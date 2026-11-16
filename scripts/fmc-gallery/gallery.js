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

// The gallery's page (scripts/dev-ui-fmc.mjs): each figure and its drawing, one after the other.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const GOOD = {
  left: 'the good version is the left one', lower: 'the good version is the lower one', both: 'both versions are good', only: '',
};

const started = performance.now();
const [fmc, data] = await Promise.all([import('/inbox/fmc.js'), fetch('/__dev/fmc/data.json').then((r) => r.json())]);
const loaded = performance.now() - started;
const out = document.getElementById('figures');
const times = [];
const section = (title) => (only ? null : out.insertAdjacentHTML('beforeend', `<h2>${esc(title)}</h2>`));
const heading = (title) => (only ? null : out.insertAdjacentHTML('beforeend', `<h3>${esc(title)}</h3>`));
// `?only=fig-25` shows only that one (for a screenshot of it).
const only = new URLSearchParams(window.location.search).get('only');
let stacks = 0;
async function show(fig, kind) {
  const el = document.createElement('section');
  el.className = `fig${kind === 'stack' ? ' stack' : ''}`;
  stacks += kind === 'stack' ? 1 : 0;
  el.id = kind === 'stack' ? `stack-${stacks}` : `fig-${fig.n}`;
  if (only && el.id !== only) return;
  const original = fig.src ? `<figure><img src="${esc(fig.src)}" alt="${esc(`Figure ${fig.n} of the article`)}"><figcaption>The original${GOOD[fig.good] ? `: ${GOOD[fig.good]}` : ''}.</figcaption></figure>` : '';
  el.innerHTML = `${original}<figure><div class="host"></div><figcaption><span class="how">${esc(fig.how || '')}</span> <span class="ms"></span></figcaption></figure><details><summary>Mermaid text, and Mermaid's own drawing of it</summary><pre></pre><div class="plain"></div></details>${fig.text ? `<details><summary>stack.md</summary><pre>${esc(fig.text)}</pre></details>` : ''}`;
  out.append(el);
  try {
    const res = kind === 'stack' ? await fmc.drawStack(el.querySelector('.host'), fig.view) : await fmc.draw(el.querySelector('.host'), fig.diagram);
    el.querySelector('.ms').textContent = `Drawn in ${Math.round(res.ms)} ms.`;
    el.querySelector('pre').textContent = res.text;
    const plain = el.querySelector('.plain');
    el.querySelector('details').addEventListener('toggle', () => {
      if (!plain.childElementCount) fmc.drawText(plain, res.text);
    }, { once: true });
    times.push({ id: el.id, ms: res.ms });
  } catch (e) {
    el.querySelector('.host').innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
}
section('The guidelines\' good examples');
for (const fig of data.figures) {
  heading(`Figure ${fig.n}: ${fig.title}`);
  await show(fig);
}
section('The notation reference');
for (const fig of data.notation) {
  heading(fig.title);
  await show(fig);
}
section('Stack drawings');
for (const s of data.stacks) {
  heading(s.title);
  await show({ ...s, how: s.view.summary }, 'stack');
}
document.getElementById('total').textContent = `The renderer loaded in ${Math.round(loaded)} ms.`;
window.fmcTimes = { loaded, times };
window.done = true;
