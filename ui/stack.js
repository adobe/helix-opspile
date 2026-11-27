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

/*
 * A customer's stack drawing, as the global `Stack`: an FMC block diagram of its parts, by
 * layer, and the flows between them (src/fmcstack.js, src/fmc.js). `html` writes the frame
 * around it (the drawing from GET /api/kb/stack, or one made of what Clef saw in the customer's
 * threads when it has none) with the parts as a list by layer, and `wire` draws the diagram in
 * place of the list once the renderer (/inbox/fmc.js, Graphviz) has loaded, which it imports
 * the first time; the list stays when it cannot. A part under the pointer or the focus lights
 * its flows and names them under the drawing. Everything in it is text the agents or people
 * wrote: written escaped, the notes through the page's Markdown renderer.
 */
globalThis.Stack = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const pct = (p) => `${Math.round(p * 100)}%`;
  const RENDERER = '/inbox/fmc.js';
  const RETRY_MS = 60_000;
  const renderer = { p: null, failedAt: 0 };

  /** Markdown on one line, without the paragraph around it. */
  const inline = (md, src) => (src ? md(src).replace(/^\s*<p>([\s\S]*)<\/p>\s*$/, '$1') : '');

  /**
   * The drawing as HTML. `view` is `{ summary, layers: [{ id, name, parts }], flows, notes }`;
   * `detected` the customer's technologies `[{ tech, name, p }]`, likeliest first: the parts that
   * are one of them say how sure Clef is, and the others are listed under the drawing. `md`
   * renders Markdown.
   */
  function html(view, { detected = [], md = esc } = {}) {
    const seen = new Map(detected.map((t) => [t.tech, t]));
    let n = 0;
    const part = (p) => {
      const i = n;
      n += 1;
      const t = p.tech && seen.get(p.tech);
      const tip = [p.name, t ? `${t.name}: ${pct(t.p)} confidence` : ''].filter(Boolean).join('\n');
      return `<div class="stk-part${t ? ' stk-seen' : ''}" tabindex="0" data-part="${i}" title="${esc(tip)}"><b>${esc(p.name)}</b>`
        + `${p.note ? `<small>${inline(md, p.note)}</small>` : ''}</div>`;
    };
    const layers = view.layers.map((l) => `<div class="stk-layer" data-layer="${esc(l.id)}"><div class="stk-ln">${esc(l.name)}</div>`
      + `<div class="stk-parts">${l.parts.map(part).join('')}</div></div>`).join('');
    const drawn = new Set(view.layers.flatMap((l) => l.parts.map((p) => p.tech)).filter(Boolean));
    const rest = detected.filter((t) => !drawn.has(t.tech));
    const more = rest.length ? `<div class="stk-more"><span class="stk-mh">Also in their threads</span>${rest.map((t) => `<span class="stk-chip" title="${esc(`${pct(t.p)} confidence`)}">${esc(t.name)}</span>`).join('')}</div>` : '';
    return `<div class="stk">${view.summary ? `<div class="stk-sum">${md(view.summary)}</div>` : ''}`
      + `<div class="stk-draw" aria-busy="true"><div class="stk-svg"></div><div class="stk-rows">${layers}</div></div>`
      + `<div class="stk-cap" aria-live="polite"></div>${more}`
      + `${view.notes ? `<div class="stk-notes">${md(view.notes)}</div>` : ''}</div>`;
  }

  /**
   * A drawing of what Clef saw, for a customer without one: each technology a part, in its layer
   * (`layers`, `{ [tech]: layer }`), named by `names`, with how sure Clef is; no flows.
   */
  function fromDetected(detected, layers, order) {
    const by = new Map(order.map((l) => [l.id, { ...l, parts: [] }]));
    for (const t of detected) {
      const l = by.get(layers[t.tech] || 'other');
      if (l) l.parts.push({ name: t.name, tech: t.tech, note: `${pct(t.p)} sure` });
    }
    return { summary: '', layers: [...by.values()].filter((l) => l.parts.length), flows: [], notes: '' };
  }

  /** The renderer module, imported once; a failed import is tried again a minute later. */
  function load() {
    if (!renderer.p && Date.now() - renderer.failedAt > RETRY_MS) {
      renderer.p = import(RENDERER).catch((e) => {
        renderer.p = null;
        renderer.failedAt = Date.now();
        throw e;
      });
    }
    return renderer.p || Promise.reject(new Error('the stack renderer did not load'));
  }

  /**
   * Draws `view` as a diagram in the drawing under `root`, in place of its list of parts, then
   * calls `drawn`; a part under the pointer or the focus lights its flows and names them under
   * the drawing. `detected` marks the parts Clef saw, `title` names the system of interest.
   * Returns a function that stops it.
   */
  function wire(root, view, {
    md = esc, detected = [], title = '', drawn = () => {},
  } = {}) {
    const draw = root.querySelector('.stk-draw');
    const cap = root.querySelector('.stk-cap');
    if (!draw) return () => {};
    const parts = view.layers.flatMap((l) => l.parts);
    const at = new Map(parts.map((p, i) => [p.name.toLowerCase(), i]));
    const flows = (view.flows || []).map((f) => ({
      ...f, a: at.get(String(f.from).toLowerCase()), b: at.get(String(f.to).toLowerCase()),
    }));
    let stopped = false;
    load().then((m) => m.drawStack(view, { detected, title })).then(({ svg }) => {
      if (stopped) return;
      draw.querySelector('.stk-svg').innerHTML = svg;
      draw.classList.add('drawn');
      draw.removeAttribute('aria-busy');
      drawn();
    }, () => {
      if (stopped) return;
      draw.classList.add('failed');
      draw.removeAttribute('aria-busy');
    });
    const light = (i) => {
      const mine = i == null ? [] : flows.map((f, k) => ({ ...f, k })).filter((f) => f.a === i || f.b === i);
      const lit = new Set(mine.flatMap((f) => [f.a, f.b]));
      const on = new Set(mine.map((f) => String(f.k)));
      draw.classList.toggle('lit', i != null);
      draw.querySelectorAll('[data-part]').forEach((el) => el.classList.toggle('on', lit.has(Number(el.dataset.part)) || Number(el.dataset.part) === i));
      draw.querySelectorAll('[data-flow]').forEach((el) => el.classList.toggle('on', on.has(el.dataset.flow)));
      draw.querySelectorAll('[data-flows]').forEach((el) => el.classList.toggle('on', el.dataset.flows.split(' ').some((k) => on.has(k))));
      // The lit edges over the others where they share a line.
      draw.querySelectorAll('.fmc-edge.on, .fmc-arrow.on').forEach((el) => el.parentNode.append(el));
      if (!cap) return;
      const p = i == null ? null : parts[i];
      const head = p && draw.classList.contains('drawn') ? `<div><b>${esc(p.name)}</b>${p.note ? `: ${inline(md, p.note)}` : ''}</div>` : '';
      cap.innerHTML = head + mine.map((f) => `<div><b>${esc(parts[f.a].name)}</b> → <b>${esc(parts[f.b].name)}</b>${f.kind ? ` (${esc(f.kind)})` : ''}${f.label ? `: ${inline(md, f.label)}` : ''}</div>`).join('');
    };
    const on = (e) => {
      const el = e.target.closest?.('[data-part]');
      if (el && draw.contains(el)) light(Number(el.dataset.part));
    };
    const off = (e) => {
      if (!e.relatedTarget || !e.relatedTarget.closest?.('[data-part]')) light(null);
    };
    draw.addEventListener('pointerover', on);
    draw.addEventListener('pointerout', off);
    draw.addEventListener('focusin', on);
    draw.addEventListener('focusout', off);
    return () => {
      stopped = true;
      draw.removeEventListener('pointerover', on);
      draw.removeEventListener('pointerout', off);
      draw.removeEventListener('focusin', on);
      draw.removeEventListener('focusout', off);
    };
  }

  return {
    html, fromDetected, wire, RENDERER,
  };
})();
