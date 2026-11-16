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
 * The gallery's page (scripts/fmc-gallery.mjs puts FIGURES and STACKS before this): draws each
 * figure and stack with the runner the inbox imports, /inbox/fmc.js (src/ui-fmc.js).
 */
/* global FIGURES, STACKS */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const GIF = (n) => `https://www.fmc-modeling.org/images/visualization_guidelines/FMC-VisualizationGuidelines-${n}.gif`;
const SIDE = {
  left: 'the original: its good side is the left one', bottom: 'the original: its good side is the lower one', both: 'the original',
};

const fmc = await import('/inbox/fmc.js');
const host = document.getElementById('figures');
const { measure, size } = fmc.measurer(host);
let total = 0;

async function draw(el, job) {
  try {
    const { svg, ms } = await job();
    total += ms;
    el.innerHTML = `${svg}<span class="cap">${ms} ms</span>`;
  } catch (e) {
    el.innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
}

const stacks = document.getElementById('stacks');
stacks.innerHTML = '<h2>Stack drawings (fake data)</h2>';
for (const s of STACKS) {
  const fig = document.createElement('article');
  fig.className = 'fig';
  fig.innerHTML = `<h3>${esc(s.title)}</h3><p class="note">${esc(s.note)}</p><div class="pair"><div class="ours" data-stack></div></div>`;
  stacks.append(fig);
   
  await draw(fig.querySelector('[data-stack]'), () => fmc.drawStack(s.view, { measure, size }));
}

host.insertAdjacentHTML('beforeend', '<h2>The guidelines\' figures</h2>');
for (const f of FIGURES) {
  const fig = document.createElement('article');
  fig.className = 'fig';
  fig.id = `figure-${f.fig}`;
  const src = f.src || GIF(f.fig);
  const ours = (f.diagrams || [f.diagram]).map((d, i) => `<div class="ours" data-i="${i}"></div>`).join('');
  fig.innerHTML = `<h3>${f.fig === 'notation' ? '' : `Figure ${esc(f.fig)}: `}${esc(f.title)}</h3>${f.note ? `<p class="note">${esc(f.note)}</p>` : ''}`
    + `<div class="pair"><div class="orig"><img src="${esc(src)}" alt="Figure ${esc(f.fig)} of the FMC visualization guidelines" loading="lazy"><span class="cap">${esc(SIDE[f.good] || SIDE.both)}</span></div>${ours}</div>`;
  host.append(fig);
  for (const [i, d] of (f.diagrams || [f.diagram]).entries()) {
     
    await draw(fig.querySelector(`[data-i="${i}"]`), () => fmc.render(d, { measure, size }));
  }
}
document.getElementById('total').textContent = `Laid out and drawn in ${total} ms in all.`;
document.body.dataset.done = 'true';
