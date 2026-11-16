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
 * layer, and the flows between them, drawn by the renderer the Worker serves at /inbox/fmc.js
 * (src/ui-fmc.js, with Mermaid and ELK), which `wire` imports when it first draws one. `html`
 * writes the frame (the drawing from GET /api/kb/stack, or one made of what Clef saw in the
 * customer's threads when it has none), `wire` draws into it and shows a part's note and flows
 * while the pointer or the focus is on it. Everything in it is text the agents or people wrote:
 * written escaped, the notes through the page's Markdown renderer; Mermaid gets it as text.
 */
globalThis.Stack = (() => {
  const RENDERER = '/inbox/fmc.js';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const pct = (p) => `${Math.round(p * 100)}%`;
  let renderer = null;

  /** Markdown on one line, without the paragraph around it. */
  const inline = (md, src) => (src ? md(src).replace(/^\s*<p>([\s\S]*)<\/p>\s*$/, '$1') : '');

  /** The parts of `view`, numbered as the drawing numbers them (`data-part`). */
  const partsOf = (view) => view.layers.flatMap((l) => l.parts);

  /** The parts by layer, as a list: what shows when the renderer cannot be loaded. */
  const list = (view) => `<dl class="stk-list">${view.layers.map((l) => `<dt>${esc(l.name)}</dt><dd>${l.parts.map((p) => esc(p.name)).join(', ')}</dd>`).join('')}</dl>`;

  /**
   * The drawing's frame as HTML. `view` is `{ summary, layers: [{ id, name, parts }], flows,
   * notes }`; `detected` the customer's technologies `[{ tech, name, p }]`, likeliest first:
   * the parts that are one of them say how sure Clef is, and the others are listed under the
   * drawing. `md` renders Markdown.
   */
  function html(view, { detected = [], md = esc } = {}) {
    const drawn = new Set(partsOf(view).map((p) => p.tech).filter(Boolean));
    const rest = detected.filter((t) => !drawn.has(t.tech));
    const more = rest.length ? `<div class="stk-more"><span class="stk-mh">Also in their threads</span>${rest.map((t) => `<span class="stk-chip" title="${esc(`${pct(t.p)} sure from their threads`)}">${esc(t.name)}</span>`).join('')}</div>` : '';
    return `<div class="stk">${view.summary ? `<div class="stk-sum">${md(view.summary)}</div>` : ''}`
      + `<div class="stk-draw" role="img" aria-label="${esc(`The stack: ${partsOf(view).map((p) => p.name).join(', ')}`)}"><span class="stk-wait">Drawing…</span></div>`
      + `<div class="stk-cap" aria-live="polite"></div>${more}`
      + '<button type="button" class="stk-copy" hidden title="The drawing as Mermaid, which GitHub draws too">Copy as Mermaid</button>'
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

  /** The renderer, imported once; a failed import is tried again with the next drawing. */
  function load() {
    renderer = renderer || import(RENDERER).catch((e) => {
      renderer = null;
      throw e;
    });
    return renderer;
  }

  /**
   * Draws `view` into the frame under `root`; a part under the pointer or the focus lights its
   * flows and says its note and them under the drawing. `detected` names how sure Clef is of a
   * part's technology, in its tooltip; `onDraw` is told when the drawing is in. Returns a
   * function that stops it.
   */
  function wire(root, view, { md = esc, detected = [], onDraw = () => {} } = {}) {
    const draw = root.querySelector('.stk-draw');
    const cap = root.querySelector('.stk-cap');
    const copy = root.querySelector('.stk-copy');
    if (!draw) return () => {};
    const parts = partsOf(view);
    const seen = new Map(detected.map((t) => [t.tech, t]));
    const at = new Map(parts.map((p, i) => [p.name.toLowerCase(), i]));
    const flows = (view.flows || []).map((f) => ({
      ...f, a: at.get(String(f.from).toLowerCase()), b: at.get(String(f.to).toLowerCase()),
    }));
    let stopped = false;
    let svg = null;
    let text = '';
    const light = (i) => {
      if (!svg) return;
      const mine = i == null ? [] : flows.map((f, k) => ({ ...f, k })).filter((f) => f.a === i || f.b === i);
      const lit = new Set(mine.flatMap((f) => [f.a, f.b]));
      const ks = new Set(mine.map((f) => String(f.k)));
      svg.classList.toggle('lit', i != null);
      svg.querySelectorAll('[data-part]').forEach((el) => el.classList.toggle('on', lit.has(Number(el.dataset.part)) || Number(el.dataset.part) === i));
      svg.querySelectorAll('[data-flow]').forEach((el) => el.classList.toggle('on', ks.has(el.dataset.flow)));
      if (!cap) return;
      const p = i == null ? null : parts[i];
      cap.innerHTML = p ? [
        `<div><b>${esc(p.name)}</b>${p.note ? `: ${inline(md, p.note)}` : ''}</div>`,
        ...mine.map((f) => `<div>${esc(parts[f.a].name)} → ${esc(parts[f.b].name)}${f.label ? `: ${inline(md, f.label)}` : ''}</div>`),
      ].join('') : '';
    };
    const on = (e) => {
      const el = e.target.closest?.('[data-part]');
      if (el && draw.contains(el)) light(Number(el.dataset.part));
    };
    const off = (e) => {
      if (!e.relatedTarget || !e.relatedTarget.closest?.('[data-part]')) light(null);
    };
    const copied = () => {
      navigator.clipboard?.writeText(text).then(() => {
        copy.textContent = 'Copied';
      }, () => {});
    };
    draw.addEventListener('pointerover', on);
    draw.addEventListener('pointerout', off);
    draw.addEventListener('focusin', on);
    draw.addEventListener('focusout', off);
    copy?.addEventListener('click', copied);
    load().then((m) => (stopped ? null : m.drawStack(draw, view))).then((res) => {
      if (!res || stopped) return;
      svg = draw.querySelector('svg');
      text = res.text;
      if (copy) copy.hidden = false;
      // A part's tooltip: its name, and how sure Clef is of what it is.
      svg.querySelectorAll('[data-part]').forEach((el) => {
        const p = parts[Number(el.dataset.part)];
        const t = p && p.tech && seen.get(p.tech);
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = [p?.name, t ? `${t.name}: ${pct(t.p)} sure from their threads` : ''].filter(Boolean).join('\n');
        el.prepend(title);
      });
      onDraw();
    }).catch(() => {
      if (stopped) return;
      draw.innerHTML = list(view);
      onDraw();
    });
    return () => {
      stopped = true;
      draw.removeEventListener('pointerover', on);
      draw.removeEventListener('pointerout', off);
      draw.removeEventListener('focusin', on);
      draw.removeEventListener('focusout', off);
      copy?.removeEventListener('click', copied);
    };
  }

  return {
    html, fromDetected, wire, list,
  };
})();
