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
 * What to follow, as the global `FollowSuggest`: the products, topics and customers GET
 * /api/follows/suggest suggests (src/followsuggest.js), each with a Follow switch, and a search
 * box that finds any of them by name. ui/inbox.js shows it where an empty personal view would be,
 * and in a dialog from your menu's Following.
 *
 * `mount(box, { load, isOn, toggle, intro })` draws it into `box`: `load(q)` answers what the
 * endpoint does (`q` empty for the suggestions), `isOn(kind, id)` whether you follow it, and
 * `toggle(kind, id, name)` follows it or no more, and resolves once that is settled. `kind` is
 * `tech` (a product), `area` (a topic) or `org` (a customer), as PUT /api/follows takes them.
 */
globalThis.FollowSuggest = (() => {
  const KINDS = [['tech', 'Products'], ['area', 'Topics'], ['org', 'Customers']];
  const WAIT_MS = 200;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const threads = (n) => `${n} ${n === 1 ? 'thread' : 'threads'}`;
  const and = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0]);

  /** Talked about more than before: at least 3 threads lately, half again as many as before. */
  const rising = (x) => (x.recent || 0) >= 3 && x.before > 0 && x.recent > 1.5 * x.before;

  /** Why it is suggested, in a few words: your channels, how much it is talked about, its teams. */
  function why(kind, x, days = 30) {
    const out = [];
    if (x.mine) out.push(`${threads(x.mine)} in your channels`);
    if (kind !== 'org' && x.recent) out.push(`${threads(x.recent)} in ${days} days${rising(x) ? ', rising' : ''}`);
    if (x.teams?.length) out.push(`${and(x.teams)} ${x.teams.length === 1 ? 'follows' : 'follow'} it`);
    return out.join(' · ');
  }

  const button = (kind, x, on) => `<button type="button" class="fs-follow" data-fs-kind="${kind}" data-fs-id="${esc(x.id)}" data-fs-name="${esc(x.name)}" aria-pressed="${on}" aria-label="${on ? 'Following' : 'Follow'} ${esc(x.name)}">${on ? 'Following' : 'Follow'}</button>`;

  function rowHtml(kind, x, on, days) {
    const what = why(kind, x, days);
    const product = kind === 'tech' && x.product && x.product !== x.name ? `<span class="fs-of">${esc(x.product)}</span>` : '';
    return `<li class="fs-row"><span class="fs-name"><span class="fs-nm">${esc(x.name)}</span>${product}${what ? `<span class="fs-why">${esc(what)}</span>` : ''}</span>${button(kind, x, on)}</li>`;
  }

  /** The lists of `data`, a section a kind; or a line saying there is nothing. */
  function html(data, isOn) {
    const parts = KINDS.filter(([kind]) => data[kind]?.length).map(([kind, title]) => `<section class="fs-kind"><h3>${title}</h3>
      <ul>${data[kind].map((x) => rowHtml(kind, x, isOn(kind, x.id), data.days)).join('')}</ul></section>`);
    if (parts.length) return parts.join('');
    return data.q ? `<p class="fs-note">No product, topic or customer is called “${esc(data.q)}”.</p>`
      : '<p class="fs-note">Nothing to suggest yet: search for a product, topic or customer.</p>';
  }

  function mount(box, {
    load, isOn, toggle, intro = '',
  }) {
    box.classList.add('fs');
    box.innerHTML = `${intro}<label class="fld fs-find"><span>Find a product, topic or customer</span>
      <span class="s2-search"><input type="search" autocomplete="off" spellcheck="false" enterkeyhint="search"></span></label>
      <div class="fs-list" aria-live="polite"><p class="fs-note">Finding suggestions…</p></div>`;
    const input = box.querySelector('input');
    const list = box.querySelector('.fs-list');
    let seq = 0;
    let timer = 0;
    async function draw(q) {
      seq += 1;
      const mine = seq;
      const data = await load(q).catch(() => null);
      if (mine !== seq) return;
      list.innerHTML = data ? html(data, isOn) : '<p class="fs-note">Could not get suggestions. Try again in a moment.</p>';
    }
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => draw(input.value.trim()), WAIT_MS);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; draw(''); }
    });
    list.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-fs-kind]');
      if (!b || b.disabled) return;
      const { fsKind: kind, fsId: id, fsName: name } = b.dataset;
      b.disabled = true;
      try {
        await toggle(kind, id, name);
      } finally {
        b.disabled = false;
        const on = isOn(kind, id);
        b.setAttribute('aria-pressed', String(on));
        b.setAttribute('aria-label', `${on ? 'Following' : 'Follow'} ${name}`);
        b.textContent = on ? 'Following' : 'Follow';
      }
    });
    draw('');
    return { focus: () => input.focus(), refresh: () => draw(input.value.trim()) };
  }

  return {
    mount, html, why, rising,
  };
})();
