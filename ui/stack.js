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
 * A customer's stack drawing, as the global `Stack`: its layers top to bottom (src/stack.js
 * LAYERS), each with its parts, and the flows between them as arrows. `html` writes it (the
 * drawing from GET /api/kb/stack, or one made of what Clef saw in the customer's threads when it
 * has none), `wire` draws the arrows once it is on the page and again when it changes size, and
 * shows a part's flows while the pointer or the focus is on it. Everything in it is text the
 * agents or people wrote: written escaped, the notes through the page's Markdown renderer.
 */
globalThis.Stack = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const NS = 'http://www.w3.org/2000/svg';
  const pct = (p) => `${Math.round(p * 100)}%`;

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
      const tip = [p.name, t ? `${t.name}: ${pct(t.p)} sure from their threads` : ''].filter(Boolean).join('\n');
      return `<div class="stk-part${t ? ' stk-seen' : ''}" tabindex="0" data-part="${i}" title="${esc(tip)}"><b>${esc(p.name)}</b>`
        + `${p.note ? `<small>${inline(md, p.note)}</small>` : ''}</div>`;
    };
    const layers = view.layers.map((l) => `<div class="stk-layer" data-layer="${esc(l.id)}"><div class="stk-ln">${esc(l.name)}</div>`
      + `<div class="stk-parts">${l.parts.map(part).join('')}</div></div>`).join('');
    const drawn = new Set(view.layers.flatMap((l) => l.parts.map((p) => p.tech)).filter(Boolean));
    const rest = detected.filter((t) => !drawn.has(t.tech));
    const more = rest.length ? `<div class="stk-more"><span class="stk-mh">Also in their threads</span>${rest.map((t) => `<span class="stk-chip" title="${esc(`${pct(t.p)} sure from their threads`)}">${esc(t.name)}</span>`).join('')}</div>` : '';
    return `<div class="stk">${view.summary ? `<div class="stk-sum">${md(view.summary)}</div>` : ''}`
      + `<div class="stk-draw"><svg class="stk-flows" aria-hidden="true"></svg>${layers}</div>`
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

  /** A path from one box to another, both relative to the drawing. */
  function route(a, b) {
    const ax = a.left + a.width / 2;
    const bx = b.left + b.width / 2;
    if (b.top >= a.bottom - 1) {
      const dy = Math.max(12, (b.top - a.bottom) / 2);
      return `M${ax},${a.bottom} C${ax},${a.bottom + dy} ${bx},${b.top - dy} ${bx},${b.top}`;
    }
    if (a.top >= b.bottom - 1) {
      const dy = Math.max(12, (a.top - b.bottom) / 2);
      return `M${ax},${a.top} C${ax},${a.top - dy} ${bx},${b.bottom + dy} ${bx},${b.bottom}`;
    }
    // In the same row: an arc over it, from one top to the other.
    const lift = Math.min(28, 10 + Math.abs(bx - ax) / 8);
    return `M${ax},${a.top} C${ax},${a.top - lift} ${bx},${b.top - lift} ${bx},${b.top}`;
  }

  /**
   * Draws the arrows of `view.flows` in the drawing under `root`, and again whenever it changes
   * size; a part under the pointer or the focus lights its flows and names them under the
   * drawing. Returns a function that stops it.
   */
  function wire(root, view, { md = esc } = {}) {
    const draw = root.querySelector('.stk-draw');
    const svg = root.querySelector('.stk-flows');
    const cap = root.querySelector('.stk-cap');
    if (!draw || !svg) return () => {};
    const parts = [...draw.querySelectorAll('.stk-part')];
    const names = view.layers.flatMap((l) => l.parts.map((p) => p.name));
    const at = new Map(names.map((name, i) => [name.toLowerCase(), i]));
    const flows = (view.flows || []).map((f) => ({
      ...f, a: at.get(String(f.from).toLowerCase()), b: at.get(String(f.to).toLowerCase()),
    })).filter((f) => f.a != null && f.b != null);
    let current = null;
    let light = () => {};
    const paint = () => {
      const box = draw.getBoundingClientRect();
      const rel = (el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left - box.left, top: r.top - box.top, right: r.right - box.left,
          bottom: r.bottom - box.top, width: r.width, height: r.height,
        };
      };
      svg.setAttribute('width', String(draw.scrollWidth));
      svg.setAttribute('height', String(draw.scrollHeight));
      svg.setAttribute('viewBox', `0 0 ${draw.scrollWidth} ${draw.scrollHeight}`);
      const defs = '<defs><marker id="stk-a" class="stk-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z"/></marker>'
        + '<marker id="stk-a-on" class="stk-arrow on" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>';
      svg.innerHTML = defs;
      for (const [i, f] of flows.entries()) {
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', route(rel(parts[f.a]), rel(parts[f.b])));
        p.setAttribute('data-flow', String(i));
        svg.append(p);
      }
      // Drawn again (it changed size) while a part is lit: its flows stay lit.
      if (current != null) light(current);
    };
    const stack = root.querySelector('.stk') || root;
    light = (i) => {
      current = i;
      const mine = i == null ? [] : flows.filter((f) => f.a === i || f.b === i);
      const lit = new Set(mine.flatMap((f) => [f.a, f.b]));
      stack.classList.toggle('lit', i != null);
      parts.forEach((el, k) => el.classList.toggle('on', lit.has(k) || k === i));
      svg.querySelectorAll('path[data-flow]').forEach((el) => {
        const f = flows[Number(el.dataset.flow)];
        el.classList.toggle('on', f.a === i || f.b === i);
      });
      if (!cap) return;
      cap.innerHTML = mine.map((f) => `<div><b>${esc(names[f.a])}</b> → <b>${esc(names[f.b])}</b>${f.label ? `: ${inline(md, f.label)}` : ''}</div>`).join('');
    };
    const on = (e) => {
      const el = e.target.closest?.('.stk-part');
      if (el && draw.contains(el)) light(Number(el.dataset.part));
    };
    const off = (e) => {
      if (!e.relatedTarget || !e.relatedTarget.closest?.('.stk-part')) light(null);
    };
    draw.addEventListener('pointerover', on);
    draw.addEventListener('pointerout', off);
    draw.addEventListener('focusin', on);
    draw.addEventListener('focusout', off);
    paint();
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(paint) : null;
    if (watch) watch.observe(draw);
    return () => {
      if (watch) watch.disconnect();
      draw.removeEventListener('pointerover', on);
      draw.removeEventListener('pointerout', off);
      draw.removeEventListener('focusin', on);
      draw.removeEventListener('focusout', off);
    };
  }

  return { html, fromDetected, wire };
})();
