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
 * A customer's stack drawing, as the global `Stack`: an FMC block diagram of its parts and the
 * flows between them (src/fmc-stack.js, laid out by ELK in src/fmc.js), which the inbox imports
 * from /inbox/fmc.js the first time it draws one. `html` writes the frame (the drawing from GET
 * /api/kb/stack, or one made of what Clef saw in the customer's threads when it has none), with
 * the parts listed by layer until the drawing is there, or for good when it cannot load; `wire`
 * draws it, and shows a part's flows while the pointer or the focus is on it. Everything in it
 * is text the agents or people wrote: written escaped, the notes through the page's Markdown
 * renderer.
 */
globalThis.Stack = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const pct = (p) => `${Math.round(p * 100)}%`;

  /** Markdown on one line, without the paragraph around it. */
  const inline = (md, src) => (src ? md(src).replace(/^\s*<p>([\s\S]*)<\/p>\s*$/, '$1') : '');

  /** The parts in the drawing's order (by layer), each with what its tooltip says. */
  function parts(view, detected = []) {
    const seen = new Map(detected.map((t) => [t.tech, t]));
    return view.layers.flatMap((l) => l.parts.map((p) => {
      const t = p.tech && seen.get(p.tech);
      return { ...p, layer: l.id, seen: t || null, tip: [p.name, t ? `${t.name}: ${pct(t.p)} sure from their threads` : ''].filter(Boolean).join('\n') };
    }));
  }

  /**
   * The drawing as HTML. `view` is `{ summary, layers: [{ id, name, parts }], flows, notes }`;
   * `detected` the customer's technologies `[{ tech, name, p }]`, likeliest first: the parts that
   * are one of them say how sure Clef is, and the others are listed under the drawing. `md`
   * renders Markdown.
   */
  function html(view, { detected = [], md = esc } = {}) {
    const all = parts(view, detected);
    let n = 0;
    const part = (p) => {
      const i = n;
      n += 1;
      return `<li class="stk-part${all[i].seen ? ' stk-seen' : ''}" data-part="${i}" title="${esc(all[i].tip)}"><b>${esc(p.name)}</b>`
        + `${p.note ? ` <small>${inline(md, p.note)}</small>` : ''}</li>`;
    };
    const list = view.layers.map((l) => `<div class="stk-layer" data-layer="${esc(l.id)}"><div class="stk-ln">${esc(l.name)}</div>`
      + `<ul class="stk-parts">${l.parts.map(part).join('')}</ul></div>`).join('');
    const drawn = new Set(all.map((p) => p.tech).filter(Boolean));
    const rest = detected.filter((t) => !drawn.has(t.tech));
    const more = rest.length ? `<div class="stk-more"><span class="stk-mh">Also in their threads</span>${rest.map((t) => `<span class="stk-chip" title="${esc(`${pct(t.p)} sure from their threads`)}">${esc(t.name)}</span>`).join('')}</div>` : '';
    return `<div class="stk">${view.summary ? `<div class="stk-sum">${md(view.summary)}</div>` : ''}`
      + `<div class="stk-draw" aria-busy="true"><div class="stk-list">${list}</div></div>`
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
    return {
      summary: '', layers: [...by.values()].filter((l) => l.parts.length), flows: [], notes: '', guess: true,
    };
  }

  /**
   * Draws `view` in the drawing under `root` once `load` (the module at /inbox/fmc.js,
   * src/ui-fmc.js) is there: a part under the pointer or the focus lights its flows and names
   * them under the drawing. Until then, and if it does not load, the parts stay listed by layer.
   * Returns a function that stops it.
   */
  function wire(root, view, { md = esc, load, detected = [] } = {}) {
    const draw = root.querySelector('.stk-draw');
    const cap = root.querySelector('.stk-cap');
    if (!draw) return () => {};
    const all = parts(view, detected);
    const at = new Map(all.map((p, i) => [p.name.toLowerCase(), i]));
    const flows = (view.flows || []).map((f) => ({
      ...f, a: at.get(String(f.from).toLowerCase()), b: at.get(String(f.to).toLowerCase()),
    }));
    const stack = root.querySelector('.stk') || root;
    let stopped = false;
    const light = (i) => {
      const mine = i == null ? [] : flows.map((f, j) => ({ ...f, j })).filter((f) => f.a === i || f.b === i);
      const lit = new Set(mine.flatMap((f) => [f.a, f.b]));
      const on = new Set(mine.map((f) => f.j));
      stack.classList.toggle('lit', i != null);
      draw.querySelectorAll('[data-part]').forEach((el) => el.classList.toggle('on', lit.has(Number(el.dataset.part)) || Number(el.dataset.part) === i));
      draw.querySelectorAll('[data-flow]').forEach((el) => el.classList.toggle('on', on.has(Number(el.dataset.flow))));
      if (!cap) return;
      const p = all[i];
      const head = p ? `<div><b>${esc(p.name)}</b>${p.note ? `: ${inline(md, p.note)}` : ''}</div>` : '';
      cap.innerHTML = head + mine.map((f) => `<div><b>${esc(all[f.a].name)}</b> → <b>${esc(all[f.b].name)}</b>${f.label ? `: ${inline(md, f.label)}` : ''}</div>`).join('');
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
    if (typeof load === 'function') {
      load().then(async (fmc) => {
        if (stopped || !draw.isConnected) return;
        const shown = { ...view, layers: view.layers.map((l) => ({ ...l, parts: l.parts.map((p) => all.find((x) => x.name === p.name && x.layer === l.id)) })) };
        const { svg } = await fmc.drawStack(shown, { ...fmc.measurer(draw), title: 'Their tech stack' });
        if (stopped || !draw.isConnected) return;
        draw.innerHTML = svg;
        draw.removeAttribute('aria-busy');
        draw.classList.add('drawn');
        root.dispatchEvent(new CustomEvent('stack-drawn', { bubbles: true }));
      }).catch(() => draw.removeAttribute('aria-busy'));
    }
    return () => {
      stopped = true;
      draw.removeEventListener('pointerover', on);
      draw.removeEventListener('pointerout', off);
      draw.removeEventListener('focusin', on);
      draw.removeEventListener('focusout', off);
    };
  }

  return { html, fromDetected, wire };
})();
