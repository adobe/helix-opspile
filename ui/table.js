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
 * with what was typed), a HAR as a table of its requests (a click on one shows it), any other
 * text as it is (JSON indented). ui/inbox.js fetches the file (GET /api/file) and puts the
 * preview under the file's card; the ⤢ button shows it full screen. Everything is written as
 * text, never as HTML: the file is someone else's.
 *
 * A HAR holds the signed-in session of whoever recorded it. Its credentials (and the bodies,
 * where tokens travel too) stay out of the page until someone asks to see one.
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

  /**
   * A table of `rows` (the first the header) with sort and filter, in `box`. `of`, for rows that
   * stand for something (a HAR's requests): `noun`, `summary`, `cls` (the name of the view's
   * table), `rowClass(i)`, `words(i)` (what the filter finds besides the cells), and
   * `detail(i)`: what a click on the row shows under it.
   */
  function tableView(box, rows, {
    size, expand, start = {}, of = {},
  }) {
    const [head = [], ...body] = rows;
    const nums = head.map((_, c) => numeric(body, c));
    const lower = body.map((r, i) => `${r.join('\u0000')}\u0000${of.words ? of.words(i) : ''}`.toLowerCase());
    const noun = of.noun || 'row';
    const opened = new Set();
    let sort = start.sort || { c: -1, dir: 0 };
    let query = (start.query || '').trim().toLowerCase();

    const count = el('span', { class: 'fv-count' });
    const find = el('input', {
      class: 'fv-find', type: 'search', value: start.query, placeholder: of.placeholder || 'Filter rows', 'aria-label': `Filter the ${noun}s`, autocomplete: 'off', spellcheck: 'false',
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

    const detailRow = (i) => el('tr', { class: 'fv-detail' }, el('td', { colspan: String(head.length + 1) }, of.detail(i)));
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
      tbody.replaceChildren(...shown.flatMap((i) => {
        const row = el(
          'tr',
          of.detail ? {
            class: of.rowClass?.(i), 'data-i': String(i), tabindex: '0', role: 'button', 'aria-expanded': String(opened.has(i)),
          } : {},
          el('td', { class: 'fv-n' }, String(i + 1)),
          ...body[i].map((v, c) => el('td', { class: nums[c] ? 'num' : '', title: v.length > 40 ? v : null }, v)),
        );
        return opened.has(i) ? [row, detailRow(i)] : [row];
      }));
      if (!shown.length) tbody.append(el('tr', {}, el('td', { class: 'fv-none', colspan: String(head.length + 1) }, query ? `No ${noun} has that.` : `No ${noun}s.`)));
      const shape = of.summary || plural(head.length, 'column');
      count.textContent = query
        ? `${plural(order.length, noun)} of ${fmt(body.length)} · ${shape}`
        : `${plural(body.length, noun)} · ${shape}`;
      more.textContent = order.length > shown.length ? `The first ${fmt(shown.length)} of ${plural(order.length, noun)}${size === 'inline' ? ': ⤢ shows more' : ''}; the filter and the sort take them all.` : '';
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
    const toggle = (row) => {
      const i = Number(row.dataset.i);
      const on = !opened.has(i);
      if (on) {
        opened.add(i);
        row.after(detailRow(i));
      } else {
        opened.delete(i);
        row.nextElementSibling.remove();
      }
      row.setAttribute('aria-expanded', String(on));
    };
    if (of.detail) {
      tbody.addEventListener('click', (e) => {
        const row = e.target.closest('tr[data-i]');
        if (row) toggle(row);
      });
      tbody.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-i]')) {
          e.preventDefault();
          toggle(e.target);
        }
      });
    }
    let timer = 0;
    find.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { query = find.value.trim().toLowerCase(); draw(); }, body.length > 5000 ? 150 : 0);
    });
    box.append(
      el('div', { class: 'fv-bar' }, count, find, expand),
      el('div', { class: 'fv-scroll', tabindex: '0' }, el('table', { class: `fv-table ${of.cls || ''}` }, thead, tbody)),
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

  // --- HAR ---

  const SECRET_NAME = /^(proxy-)?authorization$|^(set-)?cookie$|token|secret|passw|api[-_]?key|session|signature|^sig$|^code$/i;
  const JWT = /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/;
  const HIDDEN = '••••••';
  /** Whether a header or a query parameter is a credential: by its name, or a JWT by its look. */
  const secret = (name, value) => SECRET_NAME.test(String(name)) || JWT.test(String(value));

  /** A URL without its scheme and with the values of its credentials hidden. */
  function maskUrl(url) {
    const [base, ...query] = String(url || '').replace(/^https?:\/\//i, '').split('?');
    if (!query.length) return base;
    const pairs = query.join('?').split('&').map((pair) => {
      const at = pair.indexOf('=');
      const name = at < 0 ? pair : pair.slice(0, at);
      return at >= 0 && secret(name, pair.slice(at + 1)) ? `${name}=${HIDDEN}` : pair;
    });
    return `${base}?${pairs.join('&')}`;
  }

  const entryType = (e) => {
    const type = e._resourceType || String(e.response?.content?.mimeType || '').split(';')[0].split('/').pop();
    return String(type || '').toLowerCase();
  };
  // Chrome's reason for a request that never got an answer, where there is one.
  const failure = (e) => e.response?._error || e._error || '';
  const failed = (e) => { const s = Number(e.response?.status) || 0; return s === 0 || s >= 400; };

  // The parsed recording, for the preview and then its full-screen view: parsing it is slow.
  let lastHar = { text: null, har: null };
  /**
   * A HAR's requests, or null when `text` is not one: `{ head, rows, entries, summary }`, a row
   * for a table: when it started (seconds), status, method, time, size, type, and the URL
   * last, where a preview's width runs out.
   */
  function har(text) {
    if (lastHar.text === text) return lastHar.har;
    let entries;
    try {
      ({ entries } = JSON.parse(String(text).replace(/^\uFEFF/, '')).log);
    } catch {
      entries = null;
    }
    let parsed = null;
    if (Array.isArray(entries)) {
      const when = (e) => Date.parse(e.startedDateTime) || 0;
      const first = entries.reduce((n, e) => Math.min(n, when(e)), Infinity);
      const rows = entries.map((e) => [
        ((when(e) - first) / 1000).toFixed(2),
        String(e.response?.status ?? 0),
        String(e.request?.method || ''),
        String(Math.round(Number(e.time) || 0)),
        (Math.max(0, Number(e.response?.content?.size) || 0) / 1024).toFixed(1),
        entryType(e),
        maskUrl(e.request?.url),
      ]);
      const bad = entries.filter(failed).length;
      const slowest = entries.reduce((n, e) => Math.max(n, Number(e.time) || 0), 0);
      parsed = {
        head: ['Start (s)', 'Status', 'Method', 'Time (ms)', 'Size (KB)', 'Type', 'URL'],
        rows,
        entries,
        summary: `${fmt(bad)} failed · slowest ${(slowest / 1000).toFixed(1)} s`,
      };
    }
    lastHar = { text, har: parsed };
    return parsed;
  }

  /** A value of a credential: hidden until asked for, so that a look at a request shows none. */
  function hidden(value) {
    const box = el('span', { class: 'fv-secret' }, HIDDEN, ' ');
    box.append(el('button', {
      type: 'button',
      onclick: (e) => { e.stopPropagation(); box.replaceChildren(String(value)); },
    }, 'Show'));
    return box;
  }

  /** Name and value pairs, the credentials among them hidden. */
  const pairs = (title, list) => (list?.length ? el(
    'section',
    {},
    el('h4', { text: title }),
    el('dl', {}, ...list.flatMap(({ name, value }) => [
      el('dt', { text: name }),
      el('dd', {}, secret(name, value) ? hidden(value) : String(value ?? '')),
    ])),
  ) : null);

  const MAX_BODY = 200000;
  /** The body of a request or response as text, or null when it is not. */
  function bodyText({ text, encoding, mimeType }) {
    if (!text) return null;
    let out = String(text);
    if (encoding === 'base64') {
      if (!/^text\/|json|xml|javascript/i.test(mimeType || '')) return null;
      try {
        out = new TextDecoder().decode(Uint8Array.from(atob(out), (c) => c.charCodeAt(0)));
      } catch {
        return null;
      }
    }
    if (/json/i.test(mimeType || '') && out.length < 2000000) {
      try { out = JSON.stringify(JSON.parse(out), null, 2); } catch { /* as it is */ }
    }
    return out.length > MAX_BODY ? `${out.slice(0, MAX_BODY)}\n…` : out;
  }

  /** A body, behind a button: tokens travel in them, and a HAR has many. */
  function bodySection(title, part) {
    if (!part?.text) return null;
    const section = el('section', {}, el('h4', { text: `${title} · ${part.mimeType || 'no type'} · ${fmtSize(part.text.length)}` }));
    const text = bodyText(part);
    section.append(text === null
      ? el('p', { text: 'Not text.' })
      : el('button', {
        type: 'button',
        class: 'fv-show',
        onclick: (e) => {
          e.stopPropagation();
          e.target.replaceWith(el('pre', { class: 'fv-text', tabindex: '0' }, text));
        },
      }, 'Show'));
    return section;
  }

  /** One request: what it asked, what it was told, and where its time went. */
  function harDetail(e) {
    const stages = Object.entries(e.timings || {})
      .filter(([k, v]) => !k.startsWith('_') && k !== 'comment' && Number(v) > 0)
      .map(([k, v]) => `${k} ${fmt(Math.round(v))} ms`);
    const reason = failure(e);
    return el(
      'div',
      { class: 'fv-request' },
      el(
        'p',
        { class: 'fv-url' },
        `${e.request?.method || ''} ${maskUrl(e.request?.url)}`,
      ),
      el('p', {
        text: [e.startedDateTime, e.response?.status ? `${e.response.status} ${e.response.statusText || ''}`.trim() : '', e.serverIPAddress].filter(Boolean).join(' · '),
      }),
      reason ? el('p', { class: 'fv-why', text: reason }) : null,
      stages.length ? el('p', { text: stages.join(' · ') }) : null,
      pairs('Query', e.request?.queryString),
      pairs('Request headers', e.request?.headers),
      bodySection('Request body', e.request?.postData),
      pairs('Response headers', e.response?.headers),
      bodySection('Response body', e.response?.content),
    );
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
    const recording = /\.har$/i.test(name) ? har(text) : null;
    if (recording) {
      const { head, rows: requests, entries } = recording;
      view = tableView(box, [head, ...requests], {
        size,
        expand,
        start,
        of: {
          noun: 'request',
          cls: 'fv-har',
          placeholder: 'Filter: URL, status, failed',
          summary: recording.summary,
          rowClass: (i) => (failed(entries[i]) ? 'fv-failed' : null),
          words: (i) => (failed(entries[i]) ? `failed ${failure(entries[i])}` : ''),
          detail: (i) => harDetail(entries[i]),
        },
      });
      return view;
    }
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
    parse, sniff, numeric, mount, open, har, maskUrl, secret, bodyText,
  };
})();
