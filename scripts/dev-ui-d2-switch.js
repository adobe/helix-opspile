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
 * In `npm run ui:dev` only (scripts/dev-ui.mjs puts it into the inbox): a switch in the stack
 * popover between the inbox's drawing (Graphviz, ui/stack.js) and the D2 prototype's
 * (POST /__dev/d2, scripts/dev-ui-d2.mjs), kept in localStorage. It wraps `Stack.wire`: the D2
 * drawing takes the Graphviz one's place in `.stk-svg`, with the same `data-part` and
 * `data-flow`, so a part under the pointer lights its flows in either.
 */
(() => {
  const KEY = 'dev-stack-engine';
  const { wire } = globalThis.Stack;
  globalThis.Stack.wire = (root, view, opts = {}) => {
    const head = root.querySelector('.stk-head h3');
    const draw = root.querySelector('.stk-draw');
    let engine = localStorage.getItem(KEY) === 'd2' ? 'd2' : 'graphviz';
    let graphviz = null;
    let d2 = null;
    let stopped = false;
    const box = () => draw.querySelector('.stk-svg');
    const put = (svg) => {
      box().innerHTML = svg;
      draw.classList.add('drawn');
      draw.classList.remove('failed');
      draw.removeAttribute('aria-busy');
      if (opts.drawn) opts.drawn();
    };
    const showD2 = async () => {
      if (!d2) {
        d2 = fetch('/__dev/d2', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ view, detected: opts.detected || [], title: opts.title || '' }),
        }).then(async (r) => {
          const text = await r.text();
          if (!r.ok) throw new Error(text);
          return text;
        });
      }
      try {
        const svg = await d2;
        if (!stopped && engine === 'd2') put(svg);
      } catch (e) {
        if (!stopped && engine === 'd2') box().textContent = `D2: ${e.message}`;
      }
    };
    const stop = wire(root, view, {
      ...opts,
      drawn: () => {
        graphviz = box().innerHTML;
        if (engine === 'd2') showD2();
        else if (opts.drawn) opts.drawn();
      },
    });
    if (!head || !draw) return stop;
    const seg = document.createElement('span');
    seg.className = 'seg stk-engine';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Drawn by');
    seg.innerHTML = '<button type="button" data-engine="graphviz">Graphviz</button><button type="button" data-engine="d2">D2</button>';
    const mark = () => seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.engine === engine)));
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-engine]');
      if (!b) return;
      engine = b.dataset.engine;
      localStorage.setItem(KEY, engine);
      mark();
      if (engine === 'd2') showD2();
      else if (graphviz != null) put(graphviz);
    });
    mark();
    head.after(seg);
    if (engine === 'd2') showD2();
    return () => {
      stopped = true;
      stop();
    };
  };
})();
