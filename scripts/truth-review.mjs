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
 * The review page of the ground truth (scripts/truth.mjs `review`): one standalone HTML file,
 * Spectrum 2's tokens (light and dark) and its script inlined, the threads and their marks in
 * it. Each thread links into the inbox (`/inbox?team=…&t=…`, as the inbox's own links), shows
 * its marks with controls to change them and what the pipelines said, and the page exports the
 * marks as JSON: a download, else the clipboard, else a text box to copy from.
 */

import { spectrumTokens } from '../src/pagecore.js';

const CSS = `
:root {
  color-scheme: light dark;
  --bg: var(--spectrum-background-base-color);
  --panel: var(--spectrum-background-layer-1-color);
  --card: var(--spectrum-background-layer-2-color);
  --line: var(--spectrum-gray-200);
  --hover: var(--spectrum-gray-100);
  --ink: var(--spectrum-neutral-content-color-default);
  --mute: var(--spectrum-neutral-subdued-content-color-default);
  --accent: var(--spectrum-accent-background-color-default);
  --link: var(--spectrum-accent-content-color-default);
  --ctl: var(--spectrum-component-height-100);
  --radius: var(--spectrum-corner-radius-medium-size-medium);
  font-family: adobe-clean-spectrum-vf, var(--spectrum-sans-font-family-stack);
  font-size: var(--spectrum-font-size-100);
  line-height: var(--spectrum-line-height-200);
  color: var(--ink);
  background: var(--bg);
}
body { margin: 0; }
.bar {
  position: sticky; top: 0; z-index: 1;
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--spectrum-spacing-200);
  padding: var(--spectrum-spacing-300);
  background: var(--panel); border-bottom: var(--spectrum-border-width-100) solid var(--line);
}
.bar h1 { margin: 0; font-size: var(--spectrum-font-size-300); font-weight: var(--spectrum-bold-font-weight); }
.bar .stats { color: var(--mute); }
.bar .grow { flex: 1; }
.legend { padding: var(--spectrum-spacing-200) var(--spectrum-spacing-300) 0; color: var(--mute); }
input[type="search"], input[type="text"], select, textarea {
  font: inherit; color: var(--ink); background: var(--bg);
  border: var(--spectrum-border-width-200) solid var(--spectrum-gray-500);
  border-radius: var(--radius); min-height: var(--ctl);
  padding: 0 var(--spectrum-spacing-100); box-sizing: border-box;
}
textarea { width: 100%; padding: var(--spectrum-spacing-75) var(--spectrum-spacing-100); resize: vertical; }
input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible {
  outline: var(--spectrum-focus-indicator-thickness) solid var(--spectrum-focus-indicator-color);
  outline-offset: var(--spectrum-focus-indicator-gap);
}
button {
  font: inherit; font-weight: var(--spectrum-bold-font-weight); cursor: pointer;
  min-height: var(--ctl); padding: 0 var(--spectrum-spacing-300);
  border-radius: calc(var(--ctl) / 2);
  border: var(--spectrum-border-width-200) solid var(--spectrum-gray-800);
  background: transparent; color: var(--ink);
}
button:hover { background: var(--hover); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--spectrum-white); }
label.check { display: inline-flex; align-items: center; gap: var(--spectrum-spacing-75); cursor: pointer; }
main { display: grid; gap: var(--spectrum-spacing-300); padding: var(--spectrum-spacing-300); }
.card {
  background: var(--card); border: var(--spectrum-border-width-100) solid var(--line);
  border-radius: var(--spectrum-corner-radius-large-default); padding: var(--spectrum-spacing-200) var(--spectrum-spacing-300);
  display: grid; gap: var(--spectrum-spacing-100);
}
.card.reviewed { border-color: var(--spectrum-positive-visual-color); }
.card.changed .title::after { content: " · changed"; color: var(--spectrum-notice-visual-color); font-weight: var(--spectrum-regular-font-weight); }
.head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--spectrum-spacing-100); }
.title { font-size: var(--spectrum-font-size-200); font-weight: var(--spectrum-bold-font-weight); color: var(--link); text-decoration: none; }
.title:hover { text-decoration: underline; }
.head .grow { flex: 1; }
.row { display: grid; grid-template-columns: var(--spectrum-component-height-500) 1fr; gap: var(--spectrum-spacing-200); align-items: start; }
.row > .label { color: var(--mute); padding-top: var(--spectrum-spacing-75); }
.chips { display: flex; flex-wrap: wrap; gap: var(--spectrum-spacing-100); align-items: center; }
.tag {
  display: inline-flex; align-items: center; gap: var(--spectrum-spacing-75);
  min-height: var(--spectrum-component-height-75); padding: 0 var(--spectrum-spacing-100);
  border-radius: var(--radius); background: var(--spectrum-gray-100); color: var(--ink);
  font-size: var(--spectrum-font-size-75);
}
.tag.meta { background: transparent; border: var(--spectrum-border-width-100) solid var(--line); color: var(--mute); }
.tag .id { color: var(--mute); }
.tag.extra { box-shadow: inset 0 0 0 var(--spectrum-border-width-200) var(--spectrum-notice-visual-color); }
.tag.missed { box-shadow: inset 0 0 0 var(--spectrum-border-width-200) var(--spectrum-negative-visual-color); }
.seg { display: inline-flex; }
.seg button, .tag button {
  min-height: var(--spectrum-component-height-75); padding: 0 var(--spectrum-spacing-100);
  border-radius: 0; border: var(--spectrum-border-width-100) solid var(--spectrum-gray-500);
  font-size: var(--spectrum-font-size-75); font-weight: var(--spectrum-regular-font-weight);
}
.seg button:first-child { border-radius: var(--radius) 0 0 var(--radius); }
.seg button:last-child { border-radius: 0 var(--radius) var(--radius) 0; }
.seg button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--spectrum-white); }
.tag button.x { border: none; border-radius: var(--radius); }
input.add { width: var(--spectrum-field-width); max-width: 100%; min-height: var(--spectrum-component-height-75); font-size: var(--spectrum-font-size-75); }
textarea[data-act="note"] { height: var(--spectrum-component-height-75); min-height: var(--spectrum-component-height-75); font-size: var(--spectrum-font-size-75); }
.said { font-size: var(--spectrum-font-size-75); color: var(--mute); }
.said .who { font-weight: var(--spectrum-bold-font-weight); }
.hidden { display: none; }
dialog {
  background: var(--card); color: var(--ink); border: var(--spectrum-border-width-100) solid var(--line);
  border-radius: var(--spectrum-corner-radius-large-default); width: min(90vw, var(--spectrum-field-width) * 4);
}
dialog textarea { height: var(--spectrum-component-height-500); min-height: 40vh; font-family: var(--spectrum-code-font-family); font-size: var(--spectrum-font-size-75); }
.toast {
  position: fixed; bottom: var(--spectrum-spacing-400); left: 50%; transform: translateX(-50%);
  background: var(--spectrum-gray-800); color: var(--spectrum-gray-50);
  padding: var(--spectrum-spacing-200) var(--spectrum-spacing-300); border-radius: var(--radius);
}
`;

/* The page's script: renders the threads from the data, keeps the edits in localStorage. */
const SCRIPT = `
const DATA = JSON.parse(document.getElementById('data').textContent);
const KEY = 'truth-review:' + DATA.seed;
const VOCAB = new Map(DATA.vocabulary.map((v) => [v.tech, v]));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clone = (x) => JSON.parse(JSON.stringify(x));
const original = new Map(DATA.threads.map((t) => [t.thread, JSON.stringify(norm(t.mark))]));
let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
const marks = new Map(DATA.threads.map((t) => [t.thread, norm(saved[t.thread] || clone(t.mark))]));
function norm(m) {
  return {
    tech: { ...(m.tech || {}) },
    missing: (m.missing || []).map((x) => (typeof x === 'string' ? { name: x } : { ...x })),
    own: [...(m.own || [])],
    note: m.note || '',
    ...(m.reviewed ? { reviewed: true } : {}),
  };
}
function store() {
  try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(marks))); } catch { /* sandboxed */ }
}
const changed = (t) => {
  const m = { ...marks.get(t) };
  delete m.reviewed;
  return JSON.stringify(m) !== original.get(t);
};
const href = (t) => DATA.origin + '/inbox?' + new URLSearchParams({ team: t.team, t: t.thread });
const name = (id) => (VOCAB.get(id)?.name || id);
function techChips(t, m) {
  return Object.entries(m.tech).sort(([a], [b]) => a.localeCompare(b)).map(([id, how]) => {
    const extra = t.said && !t.said.clef.includes(id) && !t.said.clairic.includes(id);
    return '<span class="tag' + (extra ? ' missed' : '') + '" title="' + esc(VOCAB.get(id)?.description || '') + '">'
      + esc(name(id)) + ' <span class="id">' + esc(id) + '</span>'
      + '<span class="seg"><button data-act="how" data-id="' + esc(id) + '" data-how="uses" aria-pressed="' + (how === 'uses') + '">uses</button>'
      + '<button data-act="how" data-id="' + esc(id) + '" data-how="about" aria-pressed="' + (how === 'about') + '">about</button></span>'
      + '<button class="x" data-act="drop" data-id="' + esc(id) + '" aria-label="Remove ' + esc(name(id)) + '">×</button></span>';
  }).join('');
}
function missingChips(m) {
  return m.missing.map((x, i) => '<span class="tag">' + esc(x.name)
    + '<span class="seg"><button data-act="mabout" data-i="' + i + '" aria-pressed="' + Boolean(x.about) + '">about</button></span>'
    + '<button class="x" data-act="mdrop" data-i="' + i + '" aria-label="Remove ' + esc(x.name) + '">×</button></span>').join('');
}
function ownChips(m) {
  return m.own.map((x, i) => '<span class="tag">' + esc(x)
    + '<button class="x" data-act="odrop" data-i="' + i + '" aria-label="Remove">×</button></span>').join('');
}
function said(t, m) {
  if (!t.said) return '';
  const line = (who, ids) => '<span class="who">' + who + '</span> '
    + (ids.length ? ids.map((id) => '<span class="tag meta' + (m.tech[id] ? '' : ' extra') + '">' + esc(name(id)) + '</span>').join(' ') : 'nothing');
  return '<div class="row said"><span class="label">Pipelines</span><div class="chips">'
    + line('Clef and rules' + (t.said.asked ? '' : ' (never asked)'), t.said.clef) + ' · ' + line('Clairic', t.said.clairic)
    + '</div></div>';
}
function card(t) {
  const m = marks.get(t.thread);
  return '<article class="card' + (m.reviewed ? ' reviewed' : '') + (changed(t.thread) ? ' changed' : '') + '" data-thread="' + esc(t.thread) + '">'
    + '<div class="head"><a class="title" target="_blank" rel="noopener" href="' + esc(href(t)) + '">' + esc(t.title || '(no title)') + '</a>'
    + '<span class="tag meta">' + esc(t.team) + '</span><span class="tag meta">' + esc(t.org) + '</span><span class="tag meta">layer ' + esc(t.layer) + '</span>'
    + '<span class="grow"></span><label class="check"><input type="checkbox" data-act="reviewed"' + (m.reviewed ? ' checked' : '') + '> Reviewed</label></div>'
    + '<div class="row"><span class="label">Entries</span><div class="chips">' + techChips(t, m)
    + '<input class="add" type="text" list="vocab" data-act="add" placeholder="Add an entry (uses)…" aria-label="Add an entry"></div></div>'
    + '<div class="row"><span class="label">Missing</span><div class="chips">' + missingChips(m)
    + '<input class="add" type="text" data-act="madd" placeholder="Add a product no entry covers…" aria-label="Add a missing product"></div></div>'
    + '<div class="row"><span class="label">Own</span><div class="chips">' + ownChips(m)
    + '<input class="add" type="text" data-act="oadd" placeholder="Add a part the customer built…" aria-label="Add an own part"></div></div>'
    + '<div class="row"><span class="label">Note</span><textarea rows="1" data-act="note" aria-label="Note">' + esc(m.note) + '</textarea></div>'
    + said(t, m) + '</article>';
}
const $ = (id) => document.getElementById(id);
function visible(t) {
  const m = marks.get(t.thread);
  const q = $('q').value.trim().toLowerCase();
  if ($('team').value && t.team !== $('team').value) return false;
  if ($('layer').value && t.layer !== $('layer').value) return false;
  if ($('open').checked && m.reviewed) return false;
  if ($('differ').checked && t.said) {
    const all = new Set([...t.said.clef, ...t.said.clairic]);
    const ids = Object.keys(m.tech);
    if (ids.every((id) => all.has(id)) && [...all].every((id) => m.tech[id])) return false;
  }
  return !q || [t.title, t.org, t.team, ...Object.keys(m.tech), m.note, ...m.missing.map((x) => x.name)].join(' ').toLowerCase().includes(q);
}
function stats() {
  const all = [...marks.keys()];
  $('stats').textContent = all.length + ' threads · ' + all.filter((t) => marks.get(t).reviewed).length + ' reviewed · '
    + all.filter(changed).length + ' changed · ' + DATA.threads.filter(visible).length + ' shown';
}
function render() {
  $('list').innerHTML = DATA.threads.filter(visible).map(card).join('');
  stats();
}
function rerender(thread) {
  const el = document.querySelector('[data-thread="' + CSS.escape(thread) + '"]');
  const t = DATA.threads.find((x) => x.thread === thread);
  if (el && t) el.outerHTML = card(t);
  store();
  stats();
}
$('list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const thread = b.closest('[data-thread]').dataset.thread;
  const m = marks.get(thread);
  const { act } = b.dataset;
  if (act === 'how') m.tech[b.dataset.id] = b.dataset.how;
  if (act === 'drop') delete m.tech[b.dataset.id];
  if (act === 'mabout') { const x = m.missing[b.dataset.i]; if (x.about) delete x.about; else x.about = true; }
  if (act === 'mdrop') m.missing.splice(Number(b.dataset.i), 1);
  if (act === 'odrop') m.own.splice(Number(b.dataset.i), 1);
  rerender(thread);
});
$('list').addEventListener('change', (e) => {
  const el = e.target;
  const box = el.closest('[data-thread]');
  if (!box) return;
  const thread = box.dataset.thread;
  const m = marks.get(thread);
  const { act } = el.dataset;
  const value = (el.value || '').trim();
  if (act === 'reviewed') { if (el.checked) m.reviewed = true; else delete m.reviewed; }
  else if (act === 'note') { m.note = value; store(); stats(); return; }
  else if (act === 'add') {
    const id = VOCAB.has(value) ? value : DATA.vocabulary.find((v) => v.name.toLowerCase() === value.toLowerCase())?.tech;
    if (!id) { toast('Not an entry: ' + value); return; }
    m.tech[id] = m.tech[id] || 'uses';
  } else if (act === 'madd' && value) m.missing.push({ name: value });
  else if (act === 'oadd' && value) m.own.push(value);
  else return;
  rerender(thread);
});
for (const id of ['q', 'team', 'layer', 'open', 'differ']) $(id).addEventListener('input', render);
function exported() {
  const threads = {};
  for (const [t, m] of marks) threads[t] = m;
  return JSON.stringify({ version: 1, marked_by: 'agent', reviewed_at: new Date().toISOString(), threads }, null, 1);
}
let toastTimer = 0;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 5000);
}
async function copy(json) {
  try { await navigator.clipboard.writeText(json); return true; } catch { return false; }
}
function showText(json) {
  $('json').value = json;
  $('dialog').showModal();
  $('json').select();
}
$('export').addEventListener('click', async () => {
  const json = exported();
  let downloaded = false;
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = 'marks.json';
    document.body.append(a);
    a.click();
    a.remove();
    downloaded = true;
  } catch { downloaded = false; }
  // A page in a sandboxed frame cannot tell whether its download was blocked: copy as well.
  const framed = window.self !== window.top;
  if (downloaded && !framed) { toast('Downloaded marks.json'); return; }
  if (await copy(json)) toast(downloaded ? 'Downloaded marks.json, and copied it to the clipboard in case downloads are blocked here' : 'Copied the marks to the clipboard');
  else showText(json);
});
$('copy').addEventListener('click', async () => {
  const json = exported();
  if (await copy(json)) toast('Copied the marks to the clipboard'); else showText(json);
});
$('reset').addEventListener('click', () => {
  if (!confirm('Forget your changes on this page and show the marks as they came?')) return;
  for (const t of DATA.threads) marks.set(t.thread, norm(clone(t.mark)));
  store();
  render();
});
$('close').addEventListener('click', () => $('dialog').close());
const teams = [...new Set(DATA.threads.map((t) => t.team))].sort();
const layers = [...new Set(DATA.threads.map((t) => t.layer))].sort();
$('team').innerHTML = '<option value="">All teams</option>' + teams.map((t) => '<option>' + esc(t) + '</option>').join('');
$('layer').innerHTML = '<option value="">All layers</option>' + layers.map((l) => '<option>' + esc(l) + '</option>').join('');
$('vocab').innerHTML = DATA.vocabulary.map((v) => '<option value="' + esc(v.tech) + '">' + esc(v.name) + '</option>').join('');
if (!DATA.threads.some((t) => t.said)) $('differ').closest('label').classList.add('hidden');
render();
`;

/** `</` written so it cannot end the script element the data is in. */
const inScript = (json) => json.replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');

/**
 * The review page.
 *
 * @param {{ origin: string, seed: string, vocabulary: object[], threads: object[] }} data
 *   `threads`: `{ thread, team, org, title, layer, mark, said }`, `said` null or
 *   `{ clef: string[], clairic: string[], asked: boolean }`
 */
export function reviewPage(data) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Product marks · review</title>
<style>
${spectrumTokens(CSS)}${CSS}
</style>
</head>
<body>
<div class="bar">
  <h1>Product marks</h1>
  <span class="stats" id="stats"></span>
  <span class="grow"></span>
  <input type="search" id="q" placeholder="Search" aria-label="Search">
  <select id="team" aria-label="Team"></select>
  <select id="layer" aria-label="Layer"></select>
  <label class="check"><input type="checkbox" id="open"> Not reviewed</label>
  <label class="check"><input type="checkbox" id="differ"> Pipelines differ</label>
  <button id="reset">Reset</button>
  <button id="copy">Copy JSON</button>
  <button class="primary" id="export">Export JSON</button>
</div>
<p class="legend"><b>uses</b>: the thread shows the customer uses it. <b>about</b>: the question, the problem or the work concerns it (and it is used). An entry left out is neither. A red outline: marked, but no pipeline said so; an orange one: a pipeline said so, but it is not marked. Changes stay in this browser until you export them.</p>
<main id="list"></main>
<datalist id="vocab"></datalist>
<dialog id="dialog">
  <p>Downloads and the clipboard are blocked here: copy the marks from the box.</p>
  <textarea id="json" readonly aria-label="The marks as JSON"></textarea>
  <p><button id="close">Close</button></p>
</dialog>
<div class="toast hidden" id="toast" role="status"></div>
<script type="application/json" id="data">${inScript(JSON.stringify(data))}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
