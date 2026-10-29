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
 * The preview of a file attached to a message, as the global `Table`: a CSV or TSV as a
 * table (its first row the header; a click on a column sorts by it, the filter keeps the rows
 * with what was typed), any other text as it is (JSON indented). ui/inbox.js fetches the file
 * (GET /api/file) and puts the preview under the file's card; the ⤢ button shows it full
 * screen. Everything is written as text, never as HTML: the file is someone else's.
 */
globalThis.Table = (() => {
  // Rows shown at once, under the card and full screen; the filter and the sort take all.
  const LIMIT = { inline: 200, full: 2000 };
  const MAX_TEXT = { inline: 60000, full: 400000 };

  /** The delimiter of a CSV: the one of `,` `;` `\t` `|` the first line has most of. */
  function sniff(text, name = '') {
    if (/\.tsv$/i.test(name)) return '\t';
    const line = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
    let best = ',';
    let most = 0;
    for (const d of [',', ';', '\t', '|']) {
      let n = 0;
      let quoted = false;
      for (const c of line) {
        if (c === '"') quoted = !quoted;
        else if (c === d && !quoted) n += 1;
      }
      if (n > most) { most = n; best = d; }
    }
    return best;
  }

  /**
   * CSV (RFC 4180: quoted fields with `""` for a quote, line breaks in them, CRLF or LF) to rows
   * of cells, every row as long as the longest.
   */
  function parse(source, { delimiter, name = '' } = {}) {
    const text = String(source || '').replace(/^\uFEFF/, '');
    const d = delimiter || sniff(text, name);
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        if (c === '"') { quoted = false; i += 1; continue; }
        cell += c;
        i += 1;
        continue;
      }
      if (c === '"' && cell === '') { quoted = true; i += 1; continue; }
      if (c === d) { row.push(cell); cell = ''; i += 1; continue; }
      if (c === '\r' || c === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
        i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
        continue;
      }
      cell += c;
      i += 1;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
    return rows.filter((r) => r.some((x) => x !== '')).map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill('')] : r));
  }

  const NUMBER = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?(e[-+]?\d+)?%?$/i;
  const number = (s) => Number(String(s).replace(/[,%]/g, ''));
  /** Whether the column holds numbers: most of its cells are (the others empty). */
  function numeric(rows, c) {
    let n = 0;
    let filled = 0;
    for (const r of rows) {
      const v = r[c].trim();
      if (v) {
        filled += 1;
        if (NUMBER.test(v) && /\d/.test(v)) n += 1;
      }
    }
    return filled > 0 && n / filled >= 0.8;
  }

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const fmt = (n) => n.toLocaleString();
  const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === '') continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    e.append(...kids.filter((x) => x != null));
    return e;
  };

  /** A table of `rows` (the first the header) with sort and filter, in `box`. */
  function tableView(box, rows, { size, expand, start = {} }) {
    const [head = [], ...body] = rows;
    const nums = head.map((_, c) => numeric(body, c));
    const lower = body.map((r) => r.join('\u0000').toLowerCase());
    let sort = start.sort || { c: -1, dir: 0 };
    let query = (start.query || '').trim().toLowerCase();

    const count = el('span', { class: 'fv-count' });
    const find = el('input', {
      class: 'fv-find', type: 'search', value: start.query, placeholder: 'Filter rows', 'aria-label': 'Filter the rows', autocomplete: 'off', spellcheck: 'false',
    });
    const thead = el('thead');
    const tbody = el('tbody');
    const more = el('div', { class: 'fv-more' });
    const headRow = el('tr', {}, el('th', { class: 'fv-n', scope: 'col', 'aria-label': 'Row' }, '#'));
    head.forEach((name, c) => {
      const th = el(
        'th',
        { scope: 'col', class: nums[c] ? 'num' : '', 'aria-sort': 'none' },
        el('button', { type: 'button', title: 'Sort by this column' }, name || `Column ${c + 1}`),
      );
      th.dataset.c = String(c);
      headRow.append(th);
    });
    thead.append(headRow);

    const draw = () => {
      let order = body.map((_, i) => i);
      if (query) order = order.filter((i) => lower[i].includes(query));
      if (sort.dir) {
        const { c, dir } = sort;
        const key = nums[c] ? (i) => number(body[i][c]) : null;
        order.sort((a, b) => {
          const x = body[a][c];
          const y = body[b][c];
          // Empty cells last, whichever way.
          if (!x.trim() || !y.trim()) return (!x.trim()) - (!y.trim());
          return dir * (key ? (key(a) - key(b)) || 0 : collator.compare(x, y));
        });
      }
      const shown = order.slice(0, LIMIT[size]);
      tbody.replaceChildren(...shown.map((i) => el(
        'tr',
        {},
        el('td', { class: 'fv-n' }, String(i + 1)),
        ...body[i].map((v, c) => el('td', { class: nums[c] ? 'num' : '', title: v.length > 40 ? v : null }, v)),
      )));
      if (!shown.length) tbody.append(el('tr', {}, el('td', { class: 'fv-none', colspan: String(head.length + 1) }, query ? 'No row has that.' : 'No rows.')));
      count.textContent = query
        ? `${plural(order.length, 'row')} of ${fmt(body.length)} · ${plural(head.length, 'column')}`
        : `${plural(body.length, 'row')} · ${plural(head.length, 'column')}`;
      more.textContent = order.length > shown.length ? `The first ${fmt(shown.length)} of ${plural(order.length, 'row')}${size === 'inline' ? ': ⤢ shows more' : ''}; the filter and the sort take them all.` : '';
      more.hidden = !more.textContent;
      for (const th of headRow.querySelectorAll('th[data-c]')) {
        const on = Number(th.dataset.c) === sort.c && sort.dir;
        th.setAttribute('aria-sort', on ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none');
      }
    };
    thead.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-c]');
      if (!th) return;
      const c = Number(th.dataset.c);
      // Ascending, descending, as the file has it.
      sort = sort.c !== c ? { c, dir: 1 } : { c, dir: sort.dir === 1 ? -1 : 0 };
      draw();
    });
    let timer = 0;
    find.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { query = find.value.trim().toLowerCase(); draw(); }, body.length > 5000 ? 150 : 0);
    });
    box.append(
      el('div', { class: 'fv-bar' }, count, find, expand),
      el('div', { class: 'fv-scroll', tabindex: '0' }, el('table', { class: 'fv-table' }, thead, tbody)),
      more,
    );
    draw();
    return { focus: () => find.focus(), state: () => ({ query: find.value, sort }) };
  }

  /** Text as it is, JSON indented; long text cut where the preview ends. */
  function textView(box, text, { size, expand, name }) {
    let shown = String(text || '').replace(/^\uFEFF/, '');
    if (/\.(json|har)$/i.test(name) && shown.length < 2000000) {
      try { shown = JSON.stringify(JSON.parse(shown), null, 2); } catch { /* as it is */ }
    }
    const lines = (shown.match(/\n/g) || []).length + 1;
    const cut = shown.length > MAX_TEXT[size];
    box.append(...[
      el('div', { class: 'fv-bar' }, el('span', { class: 'fv-count', text: `${plural(lines, 'line')} · ${fmtSize(text.length)}` }), expand),
      el('pre', { class: 'fv-text', tabindex: '0' }, cut ? `${shown.slice(0, MAX_TEXT[size])}\n…` : shown),
      cut ? el('div', { class: 'fv-more', text: `The first ${fmtSize(MAX_TEXT[size])}${size === 'inline' ? ': ⤢ shows more' : ''}; open the file for all of it.` }) : null,
    ].filter(Boolean));
    return { focus: () => {} };
  }

  const fmtSize = (n) => {
    if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
    return n >= 1024 ? `${Math.round(n / 1024)} KB` : plural(n, 'byte');
  };

  /**
   * Builds the preview of a file into `box`: `kind` `table` or `text`, `size` `inline` (under
   * its card) or `full` (a dialog). `onExpand`: the ⤢ button (inline only), given the table's
   * filter and sort, which `start` takes again.
   */
  function mount(box, {
    text, kind, name = '', size = 'inline', onExpand = null, start = {},
  }) {
    box.replaceChildren();
    let view = null;
    const expand = size === 'inline' && onExpand
      ? el('button', {
        type: 'button', class: 'fv-expand', title: 'Full screen', 'aria-label': 'Full screen', onclick: () => onExpand(view && view.state ? view.state() : {}),
      }, '⤢')
      : null;
    const rows = kind === 'table' ? parse(text, { name }) : [];
    view = rows.length ? tableView(box, rows, { size, expand, start })
      : textView(box, text, { size, expand, name });
    return view;
  }

  /** The preview full screen, with the file's name and link; Escape or ✕ closes it. */
  function open({
    text, kind, name, href, home, start = {},
  }) {
    const box = el('div', { class: 'fv-body' });
    const close = el('button', { type: 'button', class: 'fv-close', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕');
    const dlg = el(
      'dialog',
      { class: 'file-dialog', 'aria-label': name },
      el(
        'div',
        { class: 'fv-head' },
        el('b', { class: 'fv-title', text: name }),
        href ? el('a', {
          href, target: '_blank', rel: 'noopener', class: 'fv-link',
        }, home ? `Open in ${home} ↗` : 'Open ↗') : null,
        close,
      ),
      box,
    );
    const view = mount(box, {
      text, kind, name, size: 'full', start,
    });
    close.addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    view.focus();
    return dlg;
  }

  return {
    parse, sniff, numeric, mount, open,
  };
})();
