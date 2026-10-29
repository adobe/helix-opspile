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
 * The knowledge-base editor's text field: CodeMirror, with Markdown and its YAML frontmatter
 * highlighted, and the frontmatter folded away when a file opens (a click on it, or the
 * arrow in the gutter, opens it). scripts/ui-markdown.mjs bundles this file and CodeMirror
 * into src/ui-editor.bundle.js, which src/page.js puts into the page as `Editor`.
 */

import {
  defaultKeymap, history, historyKeymap, indentWithTab,
} from '@codemirror/commands';
import { markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import {
  codeFolding, foldEffect, foldGutter, foldKeymap, foldService, HighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/**
 * The frontmatter's range, from the end of the opening `---` to the end of the closing one,
 * or null when the text does not start with frontmatter.
 *
 * @param {import('@codemirror/state').Text} doc
 */
export function frontmatter(doc) {
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== '---') {
    return null;
  }
  for (let n = 2; n <= doc.lines; n += 1) {
    const line = doc.line(n);
    if (/^(---|\.\.\.)\s*$/.test(line.text)) {
      return { from: doc.line(1).to, to: line.to, lines: n - 2 };
    }
  }
  return null;
}

/** What the folded frontmatter shows: its `type`, and how many lines it hides. */
export function summary(text) {
  const type = /^type:[ \t]*(.*?)[ \t]*$/m.exec(text);
  const lines = text.split('\n').length - 2;
  const parts = [type && type[1] ? `type: ${type[1].replace(/^["']|["']$/g, '')}` : 'frontmatter'];
  parts.push(`${lines} line${lines === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

const style = HighlightStyle.define([
  { tag: t.heading, color: 'var(--ink)', fontWeight: '700' },
  { tag: t.heading1, fontSize: '1.15em' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--link)' },
  { tag: t.monospace, color: 'var(--green)' },
  { tag: t.quote, color: 'var(--mute)', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.contentSeparator], color: 'var(--accent)' },
  { tag: [t.meta, t.comment], color: 'var(--faint)' },
  // YAML
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--purple)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--green)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--yellow)' },
  { tag: [t.keyword, t.typeName, t.labelName], color: 'var(--accent)' },
  { tag: [t.punctuation, t.separator, t.squareBracket, t.brace], color: 'var(--mute)' },
  { tag: t.invalid, color: 'var(--red)' },
]);

const theme = EditorView.theme({
  '&': {
    flex: '1', minHeight: '0', background: 'var(--code)', color: 'var(--ink)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.5',
  },
  '.cm-content': { padding: '12px 0', caretColor: 'var(--ink)' },
  '.cm-line': { padding: '0 14px 0 4px' },
  '.cm-gutters': { background: 'var(--code)', border: '0', color: 'var(--faint)' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 0 0 6px', cursor: 'pointer' },
  '.cm-frontmatter': {
    display: 'inline-block',
    margin: '0 0 0 8px',
    padding: '0 8px',
    borderRadius: '9px',
    border: '1px solid var(--line)',
    color: 'var(--mute)',
    font: 'inherit',
    fontSize: '12px',
    background: 'none',
    cursor: 'pointer',
  },
  '.cm-frontmatter:hover': { color: 'var(--ink)', borderColor: 'var(--faint)' },
  '.cm-foldPlaceholder': {
    background: 'none', border: '1px solid var(--line)', color: 'var(--mute)', padding: '0 6px',
  },
});

/** The frontmatter folds as one, from the line that opens it. */
const folds = foldService.of((state, from) => {
  const range = from === 0 ? frontmatter(state.doc) : null;
  return range && range.lines > 0 ? { from: range.from, to: range.to } : null;
});

const folding = codeFolding({
  preparePlaceholder: (state, range) => (range.from === state.doc.line(1).to
    ? summary(state.sliceDoc(0, range.to)) : null),
  placeholderDOM(view, onclick, prepared) {
    const el = view.dom.ownerDocument.createElement('button');
    el.type = 'button';
    if (prepared) {
      el.className = 'cm-frontmatter';
      el.textContent = `${prepared} ▸`;
      el.title = 'Show the frontmatter';
    } else {
      el.className = 'cm-foldPlaceholder';
      el.textContent = '…';
    }
    el.onclick = onclick;
    return el;
  },
});

/**
 * An editor in `parent`.
 *
 * @param {HTMLElement} parent
 * @param {object} options
 * @param {string} options.text what it starts with
 * @param {boolean} [options.readonly]
 * @param {string} [options.label] its accessible name
 * @param {() => void} [options.onInput] after every change
 * @param {() => void} [options.onBlur] when it loses the focus
 */
export function create(parent, {
  text, readonly = false, label = '', onInput = () => {}, onBlur = () => {},
}) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        folding,
        foldGutter(),
        folds,
        keymap.of([
          ...markdownKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab,
        ]),
        // Not markdown(): it brings HTML, CSS and JavaScript along, for code blocks.
        yamlFrontmatter({ content: markdownLanguage }),
        syntaxHighlighting(style),
        EditorView.lineWrapping,
        EditorState.tabSize.of(2),
        EditorState.readOnly.of(readonly),
        EditorView.contentAttributes.of({
          'aria-label': label, spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off',
        }),
        theme,
        EditorView.updateListener.of((u) => u.docChanged && onInput()),
        EditorView.domEventHandlers({ blur: () => { onBlur(); } }),
      ],
    }),
  });
  // Folded, with the cursor after it: typing goes into the Markdown, not before the `---`.
  const fold = () => {
    const range = frontmatter(view.state.doc);
    if (range && range.lines > 0) {
      const body = Math.min(range.to + 1, view.state.doc.length);
      view.dispatch({ effects: foldEffect.of(range), selection: { anchor: body } });
    }
  };
  fold();
  return {
    view,
    get value() { return view.state.doc.toString(); },
    /** Replaces the text, with the frontmatter folded again. */
    set value(next) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
      fold();
    },
    focus() { view.focus(); },
    fold,
  };
}
