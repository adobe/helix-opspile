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
 * A rich text box, as the global `RichText`: the customer portal's (ui/portal.js). A
 * `contenteditable` element in which bold is bold and a list is a list; what it holds goes to
 * the portal as HTML, which makes markdown of it (src/portal/richtext.js), so the box never
 * shows markdown's marks. The browser's own editing does the work (`document.execCommand`,
 * which keeps Undo); this adds what a message needs on top of it:
 *
 * - `format`: the formatting of ui/writing.js' shortcuts and the toolbar (`bold`, `italic`,
 *   `strike`, `code`, `link`, `bullet`, `number`, `quote`, `block`), each a toggle;
 * - `rule`: a line that starts with `- `, `1. `, `> ` or three backticks becomes the list,
 *   the quote or the code block it would be in markdown, as it is typed;
 * - `newline`: the Enter of a text box where Enter itself sends (Shift+Enter): a new line, a
 *   new list item, and out of a list, a quote or a code block from an empty line;
 * - `paste`: what is pasted keeps its formatting and nothing else of where it came from;
 * - `caret` and `replace`: what is typed before the caret, for suggestions.
 *
 * `clean` is what lets HTML into the box: the elements a message has, none of their
 * attributes but a link's address, and nothing that loads or runs.
 */
globalThis.RichText = (() => {
  /** The elements the box holds, by what each becomes; anything else is only its content. */
  const KEEP = {
    P: 'p',
    DIV: 'p',
    BR: 'br',
    B: 'strong',
    STRONG: 'strong',
    I: 'em',
    EM: 'em',
    S: 's',
    DEL: 's',
    STRIKE: 's',
    CODE: 'code',
    PRE: 'pre',
    A: 'a',
    UL: 'ul',
    OL: 'ol',
    LI: 'li',
    BLOCKQUOTE: 'blockquote',
    H1: 'p',
    H2: 'p',
    H3: 'p',
    H4: 'p',
    H5: 'p',
    H6: 'p',
    TABLE: 'table',
    THEAD: 'thead',
    TBODY: 'tbody',
    TR: 'tr',
    TH: 'th',
    TD: 'td',
  };
  /** What is left out with everything in it. */
  const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'SVG', 'MATH',
    'HEAD', 'TITLE', 'META', 'LINK', 'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'CANVAS', 'BUTTON', 'INPUT',
    'SELECT', 'TEXTAREA', 'FORM', 'NOSCRIPT']);
  const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

  function copy(from, to) {
    for (const node of from.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        to.append(node.data);
      } else if (node.nodeType === Node.ELEMENT_NODE && !DROP.has(node.tagName.toUpperCase())) {
        const tag = KEEP[node.tagName.toUpperCase()];
        if (node.tagName === 'SPAN' && node.classList.contains('mention')) {
          // A mention is one piece: it is taken out whole, not edited letter by letter.
          const mention = document.createElement('span');
          mention.className = 'mention';
          mention.contentEditable = 'false';
          mention.textContent = node.textContent;
          to.append(mention);
        } else if (!tag) {
          copy(node, to);
        } else {
          const el = document.createElement(tag);
          const href = tag === 'a' ? node.getAttribute('href') || '' : '';
          if (SAFE_LINK.test(href)) el.setAttribute('href', href);
          // A code block's language, as markdown's fence names it.
          const lang = tag === 'code' ? /(?:^|\s)(language-[\w+#.-]+)/.exec(node.className || '') : null;
          if (lang) el.className = lang[1];
          copy(node, el);
          // A heading is a line of bold text: a message has no headings.
          if (/^H[1-6]$/.test(node.tagName)) {
            const strong = document.createElement('strong');
            strong.append(...el.childNodes);
            el.append(strong);
          }
          to.append(el);
        }
      }
    }
    return to;
  }

  /** `html` as the box takes it: a fragment of the elements a message has. */
  function clean(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    return copy(doc.body, document.createDocumentFragment());
  }

  const exec = (command, value = null) => document.execCommand(command, false, value);

  /** The selection, when it is in `box`: its range, or null. */
  function rangeIn(box) {
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    return box.contains(range.commonAncestorContainer) ? range : null;
  }

  /** The closest `tag` (upper case) around `node`, inside `box`. */
  function around(box, node, ...tags) {
    for (let n = node; n && n !== box; n = n.parentNode) {
      if (n.nodeType === Node.ELEMENT_NODE && tags.includes(n.tagName)) return n;
    }
    return null;
  }

  /** The block the caret is in: a paragraph, a list item, a quote, a code block, or the box. */
  const blockOf = (box, node) => around(box, node, 'P', 'DIV', 'LI', 'BLOCKQUOTE', 'PRE') || box;

  function select(range) {
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** The caret at the start of `node` (or after it, with `after`). */
  function caretAt(node, after = false) {
    const range = document.createRange();
    if (after) range.setStartAfter(node); else range.setStart(node, 0);
    range.collapse(true);
    select(range);
  }

  /**
   * Makes a list of the caret's block, or a paragraph of its list item (`command`: the
   * browser's `insertUnorderedList` or `insertOrderedList`). The browser leaves a new list
   * inside the paragraph it was made of, where the next Enter would break it: it is taken out.
   */
  function list(box, command) {
    exec(command);
    const range = rangeIn(box);
    const made = range && around(box, range.startContainer, 'UL', 'OL');
    const p = made && made.parentNode;
    if (!p || p === box || p.tagName !== 'P') return;
    const { startContainer, startOffset } = range;
    p.replaceWith(...p.childNodes);
    const back = document.createRange();
    back.setStart(startContainer, startOffset);
    back.collapse(true);
    select(back);
  }

  /** Takes the empty lines off the end of `node`: its last line breaks, and what they leave empty. */
  function trimEnd(node) {
    let last = node.lastChild;
    while (last) {
      if (last.nodeType === Node.TEXT_NODE && last.data.replace(/[\n\u200b]+$/, '')) {
        last.data = last.data.replace(/[\n\u200b]+$/, '');
        return;
      }
      if (last.nodeType === Node.ELEMENT_NODE && last.nodeName !== 'BR') {
        trimEnd(last);
        if (last.textContent) return;
      }
      last.remove();
      last = node.lastChild;
    }
  }

  /** What `range` says, its line breaks as new lines: a code block's lines end in `<br>`. */
  function textIn(range) {
    const part = range.cloneContents();
    for (const br of part.querySelectorAll('br')) br.replaceWith('\n');
    return part.textContent.replace(/\u200b/g, '');
  }

  /** What the selection is: the formatting on at its start, by `format`'s kinds. */
  function state(box) {
    const range = rangeIn(box);
    if (!range) return {};
    const at = range.startContainer;
    const on = (command) => {
      try { return document.queryCommandState(command); } catch { return false; }
    };
    return {
      bold: on('bold'),
      italic: on('italic'),
      strike: on('strikeThrough'),
      code: Boolean(around(box, at, 'CODE')) && !around(box, at, 'PRE'),
      link: Boolean(around(box, at, 'A')),
      bullet: on('insertUnorderedList'),
      number: on('insertOrderedList'),
      quote: Boolean(around(box, at, 'BLOCKQUOTE')),
      block: Boolean(around(box, at, 'PRE')),
    };
  }

  /**
   * Words as code, or code as words again. With nothing selected, code starts where the caret
   * is, to type in, and ends there when the caret is in code already.
   */
  function toggleCode(box, range) {
    const inside = around(box, range.startContainer, 'CODE');
    if (inside && range.collapsed) {
      // A zero-width space holds the caret, here after the code; `html` leaves it out.
      const after = document.createTextNode('\u200b');
      inside.after(after);
      caretAt(after, true);
      return;
    }
    if (inside) {
      const text = document.createTextNode(inside.textContent.replace(/\u200b/g, ''));
      inside.replaceWith(text);
      const all = document.createRange();
      all.selectNodeContents(text);
      select(all);
      return;
    }
    const code = document.createElement('code');
    code.append(range.collapsed ? '\u200b' : range.extractContents().textContent);
    range.insertNode(code);
    const next = document.createRange();
    next.selectNodeContents(code);
    if (range.collapsed) next.collapse(false);
    select(next);
  }

  /**
   * Formats the selection of `box` as `kind`, or takes that formatting off it. A `link` takes
   * its address as `value`; none takes the link off.
   */
  function format(box, kind, value = '') {
    box.focus();
    const range = rangeIn(box);
    if (!range) return;
    const now = state(box);
    switch (kind) {
      case 'bold': exec('bold'); break;
      case 'italic': exec('italic'); break;
      case 'strike': exec('strikeThrough'); break;
      case 'code': toggleCode(box, range); break;
      case 'link':
        if (!SAFE_LINK.test(value)) exec('unlink');
        else if (range.collapsed) exec('insertHTML', `<a href="${value.replace(/"/g, '&quot;')}">${value.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</a>`);
        else exec('createLink', value);
        break;
      case 'bullet': list(box, 'insertUnorderedList'); break;
      case 'number': list(box, 'insertOrderedList'); break;
      case 'quote': exec('formatBlock', now.quote ? 'p' : 'blockquote'); break;
      case 'block': exec('formatBlock', now.block ? 'p' : 'pre'); break;
      default:
    }
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** What a line's first characters make of it, as markdown would. */
  const RULES = [
    [/^[-*]\s$/, (box) => list(box, 'insertUnorderedList')],
    [/^1[.)]\s$/, (box) => list(box, 'insertOrderedList')],
    [/^>\s$/, () => exec('formatBlock', 'blockquote')],
    [/^```$/, () => exec('formatBlock', 'pre')],
  ];

  /**
   * After a character was typed (the box's `input` event): a line that so far is `- `, `1. `,
   * `> ` or three backticks becomes a list, a quote or a code block. Whether it did.
   */
  function rule(box, e) {
    if (e.inputType !== 'insertText' || !/[\s`]/.test(e.data || '')) return false;
    const range = rangeIn(box);
    if (!range || !range.collapsed) return false;
    const at = range.startContainer;
    if (around(box, at, 'LI', 'BLOCKQUOTE', 'PRE', 'CODE')) return false;
    const typed = document.createRange();
    typed.setStart(blockOf(box, at), 0);
    typed.setEnd(at, range.startOffset);
    const hit = RULES.find(([re]) => re.test(typed.toString().replace(/\u00a0/g, ' ')));
    if (!hit) return false;
    // Once this input is done: the browser refuses an edit made while another one is made.
    queueMicrotask(() => {
      select(typed);
      exec('delete');
      hit[1](box);
    });
    return true;
  }

  /**
   * A new line where Enter itself sends: a new paragraph or list item, and a line break in a
   * code block or a quote, which an empty last line ends: a paragraph follows it. (An empty
   * list item ends its list, which the browser does itself.)
   */
  function newline(box) {
    const range = rangeIn(box);
    if (!range) return;
    const at = range.startContainer;
    const held = around(box, at, 'PRE', 'BLOCKQUOTE');
    if (!held || around(box, at, 'LI')) {
      exec('insertParagraph');
      return;
    }
    const rest = document.createRange();
    rest.setStart(range.endContainer, range.endOffset);
    rest.setEnd(held, held.childNodes.length);
    const before = document.createRange();
    before.setStart(held, 0);
    before.setEnd(at, range.startOffset);
    const text = textIn(before);
    // The last line's own break is the browser's, to have a line for the caret to be on.
    if (!range.collapsed || textIn(rest).replace(/\n$/, '') || (text && !/\n$/.test(text))) {
      exec('insertLineBreak');
      return;
    }
    trimEnd(held);
    const p = document.createElement('p');
    p.append(document.createElement('br'));
    held.after(p);
    if (!held.textContent.trim()) held.remove();
    caretAt(p);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * What is pasted into `box` (its `paste` event): a link over selected words makes them its
   * label; formatted text keeps the formatting a message has (`clean`); into a code block,
   * and from anything else, the text as it is.
   */
  function paste(box, e) {
    const data = e.clipboardData;
    const range = rangeIn(box);
    if (!data || !range) return;
    e.preventDefault();
    const text = data.getData('text/plain');
    if (!range.collapsed && /^https?:\/\/\S+$/.test(text.trim()) && !around(box, range.startContainer, 'PRE')) {
      exec('createLink', text.trim());
      return;
    }
    const html = around(box, range.startContainer, 'PRE', 'CODE') ? '' : data.getData('text/html');
    if (html) {
      const holder = document.createElement('div');
      holder.append(clean(html));
      exec('insertHTML', holder.innerHTML);
    } else if (text) {
      exec('insertText', text);
    }
  }

  /**
   * What was typed before the caret, for suggestions: `{ text, node, offset }`, the text of the
   * caret's text node up to it, or null (a selection, a code block, no text there).
   */
  function caret(box) {
    const range = rangeIn(box);
    if (!range || !range.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE) return null;
    if (around(box, range.startContainer, 'PRE', 'CODE')) return null;
    return {
      node: range.startContainer,
      offset: range.startOffset,
      text: range.startContainer.data.slice(0, range.startOffset).replace(/\u00a0/g, ' '),
    };
  }

  /**
   * Replaces the `length` characters before the caret `at` (see `caret`) with a mention of
   * `mention` (a name) or with `text`, and a space after it.
   */
  function replace(box, at, length, { mention = '', text = '' }) {
    const range = document.createRange();
    range.setStart(at.node, Math.max(0, at.offset - length));
    range.setEnd(at.node, at.offset);
    box.focus();
    select(range);
    if (mention) {
      // Put there as a node: the browser's own insert would start a new paragraph for it.
      const span = document.createElement('span');
      span.className = 'mention';
      span.contentEditable = 'false';
      span.textContent = `@${mention}`;
      const space = document.createTextNode('\u00a0');
      range.deleteContents();
      range.insertNode(space);
      range.insertNode(span);
      caretAt(space, true);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      exec('insertText', `${text} `);
    }
  }

  /** Puts `text` where the caret of `box` is (at its end, when the caret is elsewhere). */
  function insert(box, text) {
    box.focus();
    if (!rangeIn(box)) {
      const end = document.createRange();
      end.selectNodeContents(box);
      end.collapse(false);
      select(end);
    }
    exec('insertText', text);
  }

  /** The box's content as HTML, for the portal to make markdown of. */
  const html = (box) => box.innerHTML.replace(/\u200b/g, '');

  /** Whether the box says nothing. */
  const empty = (box) => !box.textContent.replace(/[\u200b\s]/g, '');

  /** Fills the box with `content` (HTML, let in by `clean`), the caret at its end. */
  function set(box, content) {
    box.replaceChildren(clean(content));
  }

  /** Makes `box` a rich text box: paragraphs are `<p>`, in every browser. */
  function setup(box) {
    try { exec('defaultParagraphSeparator', 'p'); } catch { /* the browser's own */ }
    return box;
  }

  return {
    clean, format, state, rule, newline, paste, caret, replace, insert, html, empty, set, setup,
  };
})();
