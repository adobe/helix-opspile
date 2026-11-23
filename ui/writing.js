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
 * Writing markdown in a text box, as the global `Writing`: what the inbox's reply box and the
 * customer portal's share (ui/inbox.js, ui/portal.js). Slack's formatting shortcuts write
 * markdown and take it off again, and a link pasted over words makes them its label. The pages
 * say which text boxes it works in, and when.
 */
globalThis.Writing = (() => {
  /**
   * Markdown formatting of the text between `start` and `end` of `value`, as Slack's ⌘B and the
   * like do it: `kind` wraps the words (`bold`, `italic`, `strike`, `code`) or takes the marks off
   * them again, makes them a `link` or a `block` of code, or starts their lines as a `quote`, a
   * `bullet` or a `number`ed list (or stops). The replacement of `from`…`to` with `insert`, and
   * the selection after it.
   */
  function formatText(value, selStart, selEnd, kind) {
    const sel = value.slice(selStart, selEnd);
    const WRAP = {
      bold: '**', italic: '_', strike: '~~', code: '`',
    };
    const mark = WRAP[kind];
    if (mark) {
      const n = mark.length;
      // Already marked, inside the selection or around it: the marks come off.
      if (sel.length >= 2 * n && sel.startsWith(mark) && sel.endsWith(mark)) {
        const inner = sel.slice(n, -n);
        return {
          from: selStart, to: selEnd, insert: inner, start: selStart, end: selStart + inner.length,
        };
      }
      if (value.slice(selStart - n, selStart) === mark && value.slice(selEnd, selEnd + n) === mark) {
        return {
          from: selStart - n, to: selEnd + n, insert: sel, start: selStart - n, end: selEnd - n,
        };
      }
      // Markdown wants the marks next to the words: spaces at the ends stay outside.
      const lead = /^\s*/.exec(sel)[0].length;
      const trail = sel.length > lead ? /\s*$/.exec(sel)[0].length : 0;
      const a = selStart + lead;
      const b = selEnd - trail;
      return {
        from: a, to: b, insert: `${mark}${value.slice(a, b)}${mark}`, start: a + n, end: b + n,
      };
    }
    if (kind === 'link') {
      const url = /^(?:https?:\/\/|mailto:)\S+$/.test(sel.trim());
      const insert = url ? `[](${sel.trim()})` : `[${sel}]()`;
      // The caret where the missing part goes: the label for a URL, the URL for words.
      const at = url || !sel ? selStart + 1 : selStart + insert.length - 1;
      return {
        from: selStart, to: selEnd, insert, start: at, end: at,
      };
    }
    if (kind === 'block') {
      const before = selStart > 0 && value[selStart - 1] !== '\n' ? '\n' : '';
      const after = selEnd < value.length && value[selEnd] !== '\n' ? '\n' : '';
      const body = sel.replace(/\n$/, '');
      const at = selStart + before.length + 4;
      return {
        from: selStart, to: selEnd, insert: `${before}\`\`\`\n${body}\n\`\`\`${after}`, start: at, end: at + body.length,
      };
    }
    // Lines: from the selStart of the first one selected to the selEnd of the last.
    const from = value.lastIndexOf('\n', selStart - 1) + 1;
    const last = selEnd > selStart && value[selEnd - 1] === '\n' ? selEnd - 1 : selEnd;
    const to = value.indexOf('\n', last) < 0 ? value.length : value.indexOf('\n', last);
    const lines = value.slice(from, to).split('\n');
    const PREFIX = { quote: /^> ?/, bullet: /^[-*+] /, number: /^\d+\. / };
    const has = PREFIX[kind];
    const filled = lines.filter((l) => l.trim());
    const off = filled.length > 0 && filled.every((l) => has.test(l));
    let i = 0;
    const out = lines.map((l) => {
      if (off) return l.replace(has, '');
      if (!l.trim() && lines.length > 1) return l;
      i += 1;
      // A list of the other kind becomes this one.
      const bare = kind === 'quote' ? l : l.replace(/^(?:[-*+]|\d+\.) /, '');
      return `${{ quote: '> ', bullet: '- ', number: `${i}. ` }[kind]}${bare}`;
    });
    const insert = out.join('\n');
    if (selStart === selEnd) {
      const at = Math.max(from, selStart + out[0].length - lines[0].length);
      return {
        from, to, insert, start: at, end: at,
      };
    }
    return {
      from, to, insert, start: from, end: from + insert.length,
    };
  }

  /** What a formatting shortcut in a text box is (`formatText`'s kind), else null. */
  function formatKind(e) {
    if (!(e.metaKey || e.ctrlKey) || (e.metaKey && e.ctrlKey)) return null;
    // Letters as the layout names them (⌥ changes them on a Mac), digits as on the keyboard (⇧
    // changes those).
    const letter = !e.altKey && /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : '';
    const k = letter || (/^(?:Key|Digit)(.)$/.exec(e.code || '')?.[1] || '').toLowerCase();
    if (e.altKey) return e.shiftKey && k === 'c' ? 'block' : null;
    if (!e.shiftKey) return { b: 'bold', i: 'italic' }[k] || null;
    return {
      x: 'strike', c: 'code', u: 'link', 9: 'quote', 8: 'bullet', 7: 'number',
    }[k] || null;
  }

  /** Replaces what `r` (formatText) says in `box`, so Undo takes it back, and selects as it says. */
  function applyText(box, r) {
    box.focus();
    box.setSelectionRange(r.from, r.to);
    // The browser's own edit keeps Undo; where there is none, the text is set (and said so).
    if (!document.execCommand?.('insertText', false, r.insert)) {
      box.setRangeText(r.insert, r.from, r.to, 'end');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
    box.setSelectionRange(r.start, r.end);
  }

  /**
   * A link pasted over the words selected in a text box (the `paste` event's target) makes
   * them its label, as in Slack: whether it did. Files, several lines and a link pasted over a
   * link are left to the browser.
   */
  function pasteLink(e) {
    const box = e.target;
    if (box.selectionStart === box.selectionEnd || e.clipboardData?.files?.length) return false;
    const url = (e.clipboardData?.getData('text/plain') || '').trim();
    const sel = box.value.slice(box.selectionStart, box.selectionEnd);
    if (!/^https?:\/\/\S+$/.test(url) || /\n/.test(sel) || /^\s*https?:\/\//.test(sel)) return false;
    e.preventDefault();
    const insert = `[${sel}](${url})`;
    const at = box.selectionStart + insert.length;
    applyText(box, {
      from: box.selectionStart, to: box.selectionEnd, insert, start: at, end: at,
    });
    return true;
  }

  return {
    formatText, formatKind, applyText, pasteLink,
  };
})();
