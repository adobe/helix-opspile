#!/usr/bin/env node
/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/**
 * Web vitals of the inbox in the local preview, with a headless Chrome over the DevTools
 * protocol (no dependencies): load (LCP, time to a usable list, long tasks), INP of the
 * interactions people do all day, CLS, and the cost of a live update.
 *
 *   node scripts/dev-ui.mjs --big --no-sim --latency=400 &   # prod-sized fake data
 *   node scripts/perf-ui.mjs                    # http://localhost:8799, CPU 4× slower
 *   node scripts/perf-ui.mjs --runs=3 --cpu=4 --origin=http://localhost:8799
 *   node scripts/perf-ui.mjs --profile          # also: where the main thread's time goes
 *
 * Only for fake data: never point it at the production inbox.
 *
 * INP of a step is its slowest interaction (event timing; under 16 ms is not reported, so
 * it shows as <16). "ready" is the time from the input until what it shows is on screen.
 * "block" is the main thread's blocking time in long animation frames during the step.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : fallback;
};
const ORIGIN = arg('origin', 'http://localhost:8799');
const CPU = Number(arg('cpu', '4'));
const RUNS = Number(arg('runs', '1'));
// --profile: where the main thread's time goes during all the steps; --profile=<text>: during
// the steps whose name contains it.
const PROFILE = process.argv.includes('--profile') || arg('profile', '');
const PROFILE_STEP = arg('profile', '');
// --trace=<text>: the main thread's time by kind of work (script, style, layout, HTML
// parsing, paint) during the steps whose name contains it.
const TRACE_STEP = arg('trace', '');
const CHROME = arg('chrome', process.env.CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(ORIGIN)) {
  throw new Error('perf-ui.mjs measures the local preview only');
}

// ---- a minimal DevTools protocol client -------------------------------------------------

async function launch() {
  const dir = await mkdtemp(join(tmpdir(), 'opspile-perf-'));
  const proc = spawn(
    CHROME,
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`,
      '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const url = await new Promise((resolve, reject) => {
    let buf = '';
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        resolve(m[1]);
      }
    });
    proc.on('exit', () => reject(new Error(`chrome exited: ${buf}`)));
  });
  const ws = new WebSocket(url);
  await new Promise((r) => {
    ws.onopen = r;
  });
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(`${msg.error.message} ${msg.error.data || ''}`));
      } else {
        resolve(msg.result);
      }
    } else if (msg.method) {
      for (const l of listeners) {
        l(msg);
      }
    }
  };
  const send = (method, params = {}, sessionId = undefined) => new Promise((resolve, reject) => {
    seq += 1;
    pending.set(seq, { resolve, reject });
    ws.send(JSON.stringify({
      id: seq, method, params, sessionId,
    }));
  });
  return {
    send,
    on: (fn) => listeners.push(fn),
    close: async () => {
      ws.close();
      proc.kill();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// ---- what the page records ----------------------------------------------------------------

const OBSERVE = `(() => {
  const p = window.__perf = { events: [], shifts: [], loaf: [], long: [], lcp: [], marks: {} };
  const po = (type, opts, fn) => {
    try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true, ...opts }); } catch {}
  };
  po('event', { durationThreshold: 16 }, (e) => { if (e.interactionId) p.events.push({ name: e.name, id: e.interactionId, t: e.startTime, d: e.duration }); });
  po('layout-shift', {}, (e) => p.shifts.push({ t: e.startTime, v: e.value, input: e.hadRecentInput,
    src: (e.sources || []).map((s) => (s.node && s.node.nodeType === 1 ? s.node.tagName.toLowerCase() + (s.node.className ? '.' + String(s.node.className).trim().split(/\\s+/).join('.') : '') : '#text')) }));
  po('long-animation-frame', {}, (e) => p.loaf.push({ t: e.startTime, d: e.duration, block: e.blockingDuration,
    scripts: e.scripts.map((s) => ({ inv: s.invoker, d: Math.round(s.duration), fn: s.sourceFunctionName, at: s.sourceCharPosition })) }));
  po('longtask', {}, (e) => p.long.push({ t: e.startTime, d: e.duration }));
  po('largest-contentful-paint', {}, (e) => p.lcp.push({ t: e.startTime, size: e.size, el: e.element ? e.element.tagName + '.' + e.element.className : '' }));
  new MutationObserver(() => {
    if (!p.marks.list && document.querySelector('#threads .rows .t')) p.marks.list = performance.now();
  }).observe(document, { subtree: true, childList: true });
})();`;

// ---- the scenario -------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => {
  setTimeout(r, ms);
});

async function session(browser) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => browser.send(m, p, sessionId);
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`);
    }
    return r.result.value;
  };
  const errors = [];
  browser.on((msg) => {
    if (msg.sessionId === sessionId && msg.method === 'Runtime.exceptionThrown') {
      const { exception, text } = msg.params.exceptionDetails;
      errors.push(exception?.description || text);
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVE });
  const center = async (selector) => {
    const r = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect();
      return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2 }; })()`);
    if (!r) {
      throw new Error(`no ${selector}`);
    }
    return r;
  };
  const move = async (selector) => {
    const { x, y } = await center(selector);
    if (process.env.PERF_DEBUG) {
      console.error(selector, x, y, await evaluate(`document.elementFromPoint(${x}, ${y})?.outerHTML.slice(0, 120)`));
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    return { x, y };
  };
  const click = async (selector) => {
    const { x, y } = await move(selector);
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
    });
  };
  const key = async (k) => {
    const code = k.length === 1 && /[a-z]/i.test(k) ? `Key${k.toUpperCase()}` : undefined;
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: k, text: k.length === 1 ? k : undefined, code,
    });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code });
  };
  const now = () => evaluate('performance.now()');
  /** Resolves with the frame time when `cond` (an expression) holds. */
  const until = (cond, timeout = 15000) => evaluate(`new Promise((resolve) => {
    const end = performance.now() + ${timeout};
    const check = () => { if (${cond}) resolve(performance.now()); else if (performance.now() > end) resolve(null); else requestAnimationFrame(check); };
    check(); })`);
  // Tracing: the renderer main thread's top-level work, summed by kind.
  let events = [];
  browser.on((msg) => {
    if (msg.method === 'Tracing.dataCollected') {
      events.push(...msg.params.value);
    }
  });
  const trace = {
    start: async () => {
      events = [];
      await browser.send('Tracing.start', {
        traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] },
        transferMode: 'ReportEvents',
      });
    },
    stop: async () => {
      const done = new Promise((resolve) => {
        browser.on((msg) => {
          if (msg.method === 'Tracing.tracingComplete') {
            resolve();
          }
        });
      });
      await browser.send('Tracing.end');
      await done;
      // The page's main thread: the renderer main thread that did the most work.
      const mains = events.filter((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
      const busy = (m) => events.filter((x) => x.pid === m.pid && x.tid === m.tid && x.ph === 'X')
        .reduce((n, x) => n + (x.dur || 0), 0);
      const mainThread = mains.sort((a, b) => busy(b) - busy(a))[0];
      const KINDS = {
        FunctionCall: 'script',
        EvaluateScript: 'script',
        TimerFire: 'script',
        EventDispatch: 'script',
        FireAnimationFrame: 'script',
        RunMicrotasks: 'script',
        v8: 'script',
        UpdateLayoutTree: 'style',
        RecalculateStyles: 'style',
        Layout: 'layout',
        ParseHTML: 'parse HTML',
        Paint: 'paint',
        PrePaint: 'paint',
        Layerize: 'paint',
        Commit: 'paint',
      };
      const sum = {};
      const stack = [];
      for (const e of events.filter((x) => x.pid === mainThread?.pid && x.tid === mainThread?.tid && x.ph === 'X' && x.dur)
        .sort((a, b) => a.ts - b.ts)) {
        while (stack.length && stack[stack.length - 1] <= e.ts) {
          stack.pop();
        }
        const kind = KINDS[e.name];
        // Nested work counts under its own kind; script time excludes what it forced.
        if (kind) {
          sum[kind] = (sum[kind] || 0) + e.dur / 1000;
          if (stack.length && kind !== 'script') {
            sum.script = (sum.script || 0) - e.dur / 1000;
          }
          if (kind === 'script') {
            stack.push(e.ts + e.dur);
          }
        }
      }
      return Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, Math.round(v)]));
    },
  };
  return {
    send, evaluate, click, move, key, now, until, trace, errors,
  };
}

/** What happened in the page between `t0` and now. */
async function window(page, t0) {
  return page.evaluate(`(() => {
    const p = window.__perf;
    const ev = p.events.filter((e) => e.t >= ${t0});
    const by = new Map();
    for (const e of ev) by.set(e.id, Math.max(by.get(e.id) || 0, e.d));
    const loaf = p.loaf.filter((e) => e.t >= ${t0});
    const shifts = p.shifts.filter((e) => e.t >= ${t0} && !e.input);
    return {
      interactions: [...by.values()],
      block: Math.round(loaf.reduce((n, e) => n + e.block, 0)),
      maxFrame: Math.round(Math.max(0, ...loaf.map((e) => e.d))),
      cls: shifts.reduce((n, e) => n + e.v, 0),
      shiftSources: [...new Set(shifts.flatMap((e) => e.src))].slice(0, 6),
      scripts: loaf.flatMap((e) => e.scripts).sort((a, b) => b.d - a.d).slice(0, 3),
    };
  })()`);
}

const BIG_ROW = `[...document.querySelectorAll('#threads .t')].map((el) => ({ el,
  n: Number((/(\\d+) repl/.exec(el.querySelector('.replies')?.textContent || '') || [])[1] || 0) }))
  .sort((a, b) => b.n - a.n)`;

async function scenario(browser) {
  const page = await session(browser);
  const results = [];
  const profiles = [];
  const traces = [];
  const only = PROFILE_STEP && ((name) => name.includes(PROFILE_STEP));
  const step = async (name, fn, { ready = null, settle = 600 } = {}) => {
    if (only && only(name)) {
      await page.send('Profiler.start');
    }
    const tracing = TRACE_STEP && name.includes(TRACE_STEP);
    if (tracing) {
      await page.trace.start();
    }
    const t0 = await page.now();
    await fn();
    const at = ready ? await page.until(ready) : null;
    await sleep(settle);
    if (only && only(name)) {
      const { profile } = await page.send('Profiler.stop');
      profiles.push(profile);
    }
    if (tracing) {
      traces.push({ name, work: await page.trace.stop() });
    }
    const w = await window(page, t0);
    const inp = w.interactions.length ? Math.max(...w.interactions) : null;
    results.push({
      step: name,
      inp,
      ready: at ? Math.round(at - t0) : null,
      block: w.block,
      maxFrame: w.maxFrame,
      cls: Number(w.cls.toFixed(4)),
      shifts: w.shiftSources.join(' '),
      top: w.scripts.map((s) => `${s.fn || s.inv}:${s.d}`).join(' '),
    });
  };

  // Load.
  const navStart = Date.now();
  await page.send('Page.navigate', { url: `${ORIGIN}/inbox?team=platform` });
  await page.until("document.querySelector('#threads .rows .t')", 30000);
  await sleep(3000); // the visible rows prefetch their threads
  await page.evaluate("document.querySelector('#dev-banner')?.remove()");
  const load = await page.evaluate(`(() => {
    const p = window.__perf;
    const nav = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    const long = p.long.filter((e) => e.t <= p.marks.list + 50);
    return {
      html: nav ? Math.round(nav.responseEnd) : null,
      htmlBytes: nav ? nav.transferSize : null,
      dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      fcp: fcp ? Math.round(fcp.startTime) : null,
      lcp: p.lcp.length ? Math.round(p.lcp[p.lcp.length - 1].t) : null,
      lcpEl: p.lcp.length ? p.lcp[p.lcp.length - 1].el : null,
      list: Math.round(p.marks.list),
      tbt: Math.round(long.reduce((n, e) => n + Math.max(0, e.d - 50), 0)),
      longest: Math.round(Math.max(0, ...long.map((e) => e.d))),
      cls: Number(p.shifts.filter((e) => !e.input).reduce((n, e) => n + e.v, 0).toFixed(4)),
      shifts: [...new Set(p.shifts.filter((e) => !e.input).flatMap((e) => e.src))].slice(0, 6).join(' '),
      rows: document.querySelectorAll('#threads .t').length,
    };
  })()`);
  load.wall = Date.now() - navStart;

  if (PROFILE) {
    await page.send('Profiler.enable');
    await page.send('Profiler.setSamplingInterval', { interval: 200 });
    if (!PROFILE_STEP) {
      await page.send('Profiler.start');
    }
  }
  // Rows are marked by key: the list rewrites their class names as it renders.
  const mark = (name, pickRow) => page.evaluate(`(() => { const rows = ${BIG_ROW};
    const r = (${pickRow})(rows); window.__perfKeys = { ...window.__perfKeys, ${name}: r.el.dataset.thread }; })()`);
  const rowOf = async (name) => page.evaluate(`'#threads .t[data-thread="' + CSS.escape(window.__perfKeys.${name}) + '"]'`);
  const opened = (name) => `document.querySelector('#threads .t.sel')?.dataset.thread === window.__perfKeys.${name} && document.querySelector('#pane .feed') && !document.querySelector('#pane > .empty')`;
  const open = async (label, name, pickRow, settle = 600) => {
    await mark(name, pickRow);
    const selector = await rowOf(name);
    await step(label, () => page.click(selector), { ready: opened(name), settle });
  };
  await open('open thread (cached)', 'first', '(rows) => ({ el: document.querySelector("#threads .t:nth-child(2)") })');
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await step('j (next thread)', () => page.key('j'), { ready: "document.querySelector('#pane .feed')", settle: 400 });
  }
  await step('k (previous thread)', () => page.key('k'), { ready: "document.querySelector('#pane .feed')", settle: 400 });
  // The longest thread in view (prefetched), then a long one far down the list (not yet).
  await open('open long thread (cached)', 'big', '(rows) => rows.find((r) => r.el.offsetTop < 700) || rows[0]');
  await open('open long thread (uncached)', 'far', '(rows) => rows.find((r) => r.el.offsetTop > 6000 && r.n > 40) || rows[3]', 1200);
  await page.evaluate("document.querySelector('#threads').scrollTop = 0");
  await open('open thread (cached)', 'back', '(rows) => ({ el: document.querySelector("#threads .t:nth-child(3)") })');
  await step('facet: pick a customer', () => page.click('[data-f="customer"] .fr:nth-of-type(2)'));
  await step('facet: unpick it', () => page.click('[data-f="customer"] .fr.on'));
  await step('facet: kind', () => page.click('[data-f="kind"] .fr:nth-of-type(1)'));
  await step('facet: clear kind', () => page.click('[data-f="kind"] .clear'));
  await step('Smart → Recent', () => page.click('#threads [data-sort]'));
  await step('Recent → Smart', () => page.click('#threads [data-sort]'));
  await step('unread only on', () => page.click('#threads [data-unread]'));
  await step('unread only off', () => page.click('#threads [data-unread]'));
  await page.evaluate("[...document.querySelectorAll('#pane .msg')].at(-3).classList.add('perf-msg')");
  await step('hover a message', () => page.move('.perf-msg .bubble'), { settle: 500 });
  await step('profile card', () => page.move('#pane .msg:not(.cont) .who b[data-p]'), { ready: "!document.querySelector('#pcard')?.hidden", settle: 300 });
  await page.click('#reply');
  await sleep(300);
  {
    const t0 = await page.now();
    for (const c of 'Thanks, looking') {
      // eslint-disable-next-line no-await-in-loop
      await page.key(c);
    }
    await sleep(600);
    const w = await window(page, t0);
    const sorted = [...w.interactions].sort((a, b) => a - b);
    results.push({
      step: 'typing (15 keys)', inp: sorted.length ? sorted[sorted.length - 1] : null, ready: null, block: w.block, maxFrame: w.maxFrame, cls: Number(w.cls.toFixed(4)), shifts: w.shiftSources.join(' '), top: `${sorted.length} keys ≥16ms`,
    });
  }
  await step('@-mention suggestions', async () => {
    await page.key(' ');
    await page.key('@');
    await page.key('p');
  }, { ready: "!document.querySelector('#mention-list')?.hidden", settle: 400 });
  await page.key('Escape');
  const openKey = await page.evaluate("document.querySelector('#threads .t.sel').dataset.thread");
  const count = await page.evaluate("document.querySelectorAll('#pane .msg').length");
  await step('live update (thread open)', () => fetch(`${ORIGIN}/__dev/simulate?thread=${encodeURIComponent(openKey)}`, { method: 'POST' }), {
    ready: `document.querySelectorAll('#pane .msg').length > ${count}`, settle: 1500,
  });
  const other = await page.evaluate("document.querySelector('#threads .t:not(.sel):nth-child(5)').dataset.thread");
  await step('live update (another thread)', () => fetch(`${ORIGIN}/__dev/simulate?thread=${encodeURIComponent(other)}`, { method: 'POST' }), { settle: 2000 });
  await step('switch team', () => page.evaluate("(() => { const s = document.querySelector('#team'); s.value = 'edge'; s.dispatchEvent(new Event('change')); })()"), {
    ready: "document.querySelectorAll('#threads .t').length < 100", settle: 1000,
  });
  await step('switch team back', () => page.evaluate("(() => { const s = document.querySelector('#team'); s.value = 'platform'; s.dispatchEvent(new Event('change')); })()"), {
    ready: "document.querySelectorAll('#threads .t').length > 100", settle: 1500,
  });
  if (PROFILE && !PROFILE_STEP) {
    profiles.push((await page.send('Profiler.stop')).profile);
  }
  return {
    load, results, profiles, traces, errors: page.errors,
  };
}

function selfTimes(profiles) {
  const total = new Map();
  for (const profile of profiles) {
    const dt = profile.timeDeltas;
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    profile.samples.forEach((id, i) => {
      const f = byId.get(id).callFrame;
      const where = f.url ? `${f.url.split('/').pop().split('?')[0]}:${f.lineNumber + 1}` : '';
      const name = `${f.functionName || '(anonymous)'} ${where}`.trim();
      total.set(name, (total.get(name) || 0) + (dt[i] || 0));
    });
  }
  return [...total].filter(([n]) => !/^\((idle|program|garbage collector)\)/.test(n))
    .sort((a, b) => b[1] - a[1]).slice(0, 25).map(([n, us]) => `${String(Math.round(us / 1000)).padStart(6)} ms  ${n}`);
}

const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};

const browser = await launch();
try {
  const runs = [];
  for (let r = 0; r < RUNS; r += 1) {
    // eslint-disable-next-line no-await-in-loop
    runs.push(await scenario(browser));
  }
  const load = Object.fromEntries(Object.keys(runs[0].load).map((k) => [k, typeof runs[0].load[k] === 'number' ? median(runs.map((x) => x.load[k])) : runs[0].load[k]]));
  console.log(`\nLoad (CPU ${CPU}× slower, median of ${RUNS}):`);
  console.table(load);
  const names = [...new Set(runs[0].results.map((x) => x.step))];
  const rows = names.map((name) => {
    const all = runs.flatMap((x) => x.results.filter((y) => y.step === name));
    const inps = all.map((x) => x.inp);
    return {
      step: name,
      'INP ms': median(inps) ?? '<16',
      'ready ms': median(all.map((x) => x.ready)),
      'block ms': median(all.map((x) => x.block)),
      'max frame': median(all.map((x) => x.maxFrame)),
      CLS: median(all.map((x) => x.cls)),
      shifts: all.map((x) => x.shifts).find(Boolean) || '',
      'slowest scripts': all[0].top,
    };
  });
  console.log('\nInteractions (median):');
  console.table(rows);
  const errors = runs.flatMap((x) => x.errors);
  if (errors.length) {
    console.log(`\nPage errors (${errors.length}):\n${[...new Set(errors)].join('\n')}`);
  }
  if (TRACE_STEP) {
    console.log('\nMain thread by kind of work, ms (first run):');
    console.table(Object.fromEntries(runs[0].traces.map((t, i) => [`${i} ${t.name}`, t.work])));
  }
  if (PROFILE) {
    console.log('\nSelf time during the interactions (first run):');
    console.log(selfTimes(runs[0].profiles).join('\n'));
  }
} finally {
  await browser.close();
}
