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
 * it shows as <16). "ready" is the time from the input until what it shows is on screen: the
 * pane shows the thread's messages, the list's rows changed (for another view: after its
 * inbox came in). "block" is the main thread's blocking time in long animation frames during
 * the step.
 *
 * What it clicks, points at and waits for is in perf-ui-hooks.mjs: ids, data-* attributes,
 * roles and ARIA states the page keeps for itself, which test/perf-ui.test.js checks. A step
 * whose target is covered (the filter rail slid out over the list) fails instead of measuring
 * a click on something else.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTHOR, BANNER, BUBBLE, CARD, FACET, FACET_CLEAR, HEADER, LIST, MESSAGE, OTHER_TEAM, REPLY, ROW,
  SHOWN, TEAM, UNREAD, VIEW, VIEW_URL,
} from './perf-ui-hooks.mjs';

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
  // No headless Chrome left behind when a step fails.
  process.on('exit', () => proc.kill());
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
  const p = window.__perf = { events: [], shifts: [], loaf: [], long: [], lcp: [], marks: {}, fetched: [] };
  // When each answer came in (its headers): what a step waits for is drawn after it.
  const f = window.fetch;
  window.fetch = function fetch(...a) {
    const url = String(a[0] instanceof Request ? a[0].url : a[0]);
    return f.apply(this, a).then((r) => { p.fetched.push({ url, t: performance.now() }); return r; });
  };
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
    if (!p.marks.list && document.querySelector('${ROW}')) p.marks.list = performance.now();
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
  // Where to point at `selector` (scrolled to the middle first), and what is drawn there: `on`
  // is false when something else covers it (the filter rail slid out over the list, a popover).
  // Without `scroll`, one out of view counts as not covered: scrolling to it would fetch it.
  const center = async (selector, { scroll = true } = {}) => {
    const r = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null; if (${scroll}) el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect();
      const x = r.left + Math.min(r.width / 2, 40); const y = r.top + r.height / 2;
      // Out of view: outside the window or a scrolled box it is in.
      for (let a = el.parentElement; a; a = a.parentElement) {
        const b = a === document.documentElement ? { top: 0, bottom: innerHeight } : a.getBoundingClientRect();
        if (getComputedStyle(a).overflowY !== 'visible' && (y < b.top || y > b.bottom)) return { x, y, on: true };
      }
      if (y < 0 || y > innerHeight) return { x, y, on: true };
      const hit = document.elementFromPoint(x, y);
      return { x, y, on: el.contains(hit), hit: hit ? hit.outerHTML.slice(0, 120) : null }; })()`);
    if (!r) {
      throw new Error(`no ${selector}`);
    }
    return r;
  };
  const pointAt = async (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  /**
   * Before a step: `selector` can be pointed at. If something covers it, the pointer leaves for
   * the header (the rail folds when it is not under the pointer) until it shows.
   */
  const reach = async (selector) => {
    let r = await center(selector, { scroll: false });
    if (!r.on) {
      await pointAt(...await evaluate(`[innerWidth / 2, document.querySelector('${HEADER}').offsetHeight / 2]`));
      const end = Date.now() + 3000;
      while (!r.on && Date.now() < end) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(100);
        // eslint-disable-next-line no-await-in-loop
        r = await center(selector, { scroll: false });
      }
    }
    if (!r.on) {
      throw new Error(`${selector} is covered by ${r.hit}`);
    }
  };
  const move = async (selector) => {
    const {
      x, y, on, hit,
    } = await center(selector);
    if (process.env.PERF_DEBUG) {
      console.error(selector, x, y, hit);
    }
    // Never a step that points at something else than it says.
    if (!on) {
      throw new Error(`${selector} is covered by ${hit}`);
    }
    await pointAt(x, y);
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
    send, evaluate, click, move, reach, key, now, until, trace, errors,
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
      shiftSources: [...new Set(shifts.flatMap((e) => e.src.map((x) => x + '@' + Math.round(e.t - ${t0}))))].slice(0, 6),
      scripts: loaf.flatMap((e) => e.scripts).sort((a, b) => b.d - a.d).slice(0, 3),
    };
  })()`);
}

// ---- what the steps wait for -------------------------------------------------------------
// The hooks they find on the page are in perf-ui-hooks.mjs.

const SHOWS = (key) => `${SHOWN} === ${key}`;
/**
 * Arms window.__perfList: true once the list adds, moves or removes a row; with `fetched`, only
 * once an answer from a URL that contains it has come in too (a view shows its own threads).
 */
const ARM_LIST = (fetched = '') => `(() => { window.__perfList = false; const t0 = performance.now();
  const rowish = (n) => n.nodeType === 1 && n.matches('[data-thread]');
  const came = () => !${JSON.stringify(fetched)}
    || window.__perf.fetched.some((e) => e.t >= t0 && e.url.includes(${JSON.stringify(fetched)}));
  new MutationObserver((records, o) => {
    if (came() && records.some((r) => [...r.addedNodes, ...r.removedNodes].some(rowish))) { window.__perfList = true; o.disconnect(); }
  }).observe(document.querySelector('${LIST}'), { subtree: true, childList: true }); })()`;
/** The rows, longest thread first (by the "N replies" it shows); byIndex in list order. */
const BIG_ROW = `(() => { const els = [...document.querySelectorAll('${ROW}')];
  const rows = els.map((el) => ({ el,
    n: Number((/(\\d+) repl/.exec(el.textContent) || [])[1] || 0) })).sort((a, b) => b.n - a.n);
  rows.byIndex = els.map((el) => ({ el }));
  return rows; })()`;

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
  await page.send('Page.navigate', { url: `${ORIGIN}/inbox?team=${TEAM}` });
  await page.until(`document.querySelector('${ROW}')`, 30000);
  await sleep(3000); // the visible rows prefetch their threads
  await page.evaluate(`document.querySelector('${BANNER}')?.remove()`);
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
      rows: document.querySelectorAll('${ROW}').length,
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
  const rowOf = async (name) => page.evaluate(`'${ROW}[data-thread="' + CSS.escape(window.__perfKeys.${name}) + '"]'`);
  const opened = (name) => SHOWS(`window.__perfKeys.${name}`);
  const open = async (label, name, pickRow, settle = 600) => {
    await mark(name, pickRow);
    const selector = await rowOf(name);
    await page.reach(selector);
    await step(label, () => page.click(selector), { ready: opened(name), settle });
  };
  // j and k are ready when the pane shows another thread's messages than before.
  const moved = async (k) => {
    const was = await page.evaluate(SHOWN);
    await step(`${k} (${k === 'j' ? 'next' : 'previous'} thread)`, () => page.key(k), {
      ready: `(${SHOWN}) && (${SHOWN}) !== ${JSON.stringify(was)}`, settle: 400,
    });
  };
  // A filter, a view or unread only is ready when the list's rows change.
  const relist = async (label, selector, { settle = 600, fetched = '' } = {}) => {
    await page.reach(selector);
    await page.evaluate(ARM_LIST(fetched));
    await step(label, () => page.click(selector), { ready: 'window.__perfList', settle });
  };
  await open('open thread (cached)', 'first', '(rows) => rows.byIndex[1]');
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await moved('j');
  }
  await moved('k');
  // The longest thread in view (prefetched), then a long one far down the list (not yet).
  await open('open long thread (cached)', 'big', '(rows) => rows.find((r) => r.el.offsetTop < 700) || rows[0]');
  await open('open long thread (uncached)', 'far', '(rows) => rows.find((r) => r.el.offsetTop > 6000 && r.n > 40) || rows[3]', 1200);
  await page.evaluate(`document.querySelector('${LIST}').scrollTop = 0`);
  await open('open thread (cached)', 'back', '(rows) => rows.byIndex[2]');
  // A facet's value is the same row before and after it is picked: [data-f][data-v].
  const customer = await page.evaluate(`document.querySelector('${FACET('customer')}').dataset.v`);
  const value = `${FACET('customer')}[data-v=${JSON.stringify(customer)}]`;
  await relist('facet: pick a customer', value);
  await relist('facet: unpick it', value);
  await relist('facet: kind', FACET('kind'));
  await relist('facet: clear kind', FACET_CLEAR('kind'));
  await relist('unread only on', UNREAD);
  await relist('unread only off', UNREAD);
  const msg = await page.evaluate(`[...document.querySelectorAll('${MESSAGE}')].at(-3).dataset.id`);
  await step('hover a message', () => page.move(BUBBLE(msg)), { settle: 500 });
  await step('profile card', () => page.move(AUTHOR), { ready: `document.querySelector('${CARD}')?.hidden === false`, settle: 300 });
  await page.click(REPLY);
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
  }, { ready: `document.querySelector('${REPLY}').getAttribute('aria-expanded') === 'true'`, settle: 400 });
  await page.key('Escape');
  const openKey = await page.evaluate(SHOWN);
  const count = await page.evaluate(`document.querySelectorAll('${MESSAGE}').length`);
  await step('live update (thread open)', () => fetch(`${ORIGIN}/__dev/simulate?thread=${encodeURIComponent(openKey)}`, { method: 'POST' }), {
    ready: `document.querySelectorAll('${MESSAGE}').length > ${count}`, settle: 1500,
  });
  const other = await page.evaluate(`[...document.querySelectorAll('${ROW}')].map((el) => el.dataset.thread)
    .filter((k) => k !== ${JSON.stringify(openKey)})[4]`);
  await step('live update (another thread)', () => fetch(`${ORIGIN}/__dev/simulate?thread=${encodeURIComponent(other)}`, { method: 'POST' }), { settle: 2000 });
  // Another view closes the open thread: these come last. Each is ready when the list shows
  // the view's own threads, not the last view's.
  const view = (label, slug, settle) => relist(label, VIEW(slug), {
    fetched: VIEW_URL(slug), settle,
  });
  await view('Team → Personal', '', 1000);
  await view('Personal → Team', TEAM, 1500);
  await view('switch team', OTHER_TEAM, 1000);
  await view('switch team back', TEAM, 1500);
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
  if (process.env.PERF_DEBUG) {
    // Every run's layout shifts: step, CLS, sources @ ms after the input.
    for (const x of runs) {
      const shifted = x.results.filter((y) => y.cls).map((y) => [y.step, y.cls, y.shifts]);
      console.log(JSON.stringify(shifted));
    }
  }
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
