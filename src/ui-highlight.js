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
 * How the inbox highlights a code block: @pierre/highlights (the highlighter slicc's chat uses),
 * whose lexers are one WebAssembly module, into runs of `<span class="hl-…">`. The classes are
 * groups of the highlighter's token types (`GROUPS`), which ui/spectrum-inbox.css colors with
 * Spectrum 2 tokens, so the colors follow the color scheme and the page writes no style.
 *
 * A fence that names no language, as all of Slack's, gets one by what it looks like
 * (`guessLanguage`), and stays plain text when nothing is sure.
 *
 * The page does not load this file: scripts/ui-markdown.mjs bundles it, with the highlighter,
 * into src/ui-highlight.bundle.js, which the Worker serves at /inbox/highlight.js, and the
 * inbox imports that with the first code block it shows (`Markdown.render`'s `highlight`).
 */

import { codeToTokens, isSupportedLanguage } from '@pierre/highlights';

/** Blocks longer than this stay plain text, and so does a line this long (one run). */
export const LONGEST = 100_000;
const LONGEST_LINE = 1000;

/**
 * The classes, by the highlighter's token types (a type takes its parent's: `keyword.control`
 * is `keyword`). Punctuation, operators and variables are the text's color.
 */
export const GROUPS = {
  comment: 'comment',
  keyword: 'keyword',
  preproc: 'keyword',
  'tag.doctype': 'keyword',
  string: 'string',
  'text.literal': 'string',
  'string.escape': 'regex',
  'string.regex': 'regex',
  number: 'constant',
  boolean: 'constant',
  constant: 'constant',
  enum: 'constant',
  variant: 'constant',
  'variable.special': 'constant',
  function: 'function',
  constructor: 'function',
  type: 'type',
  namespace: 'type',
  selector: 'type',
  property: 'property',
  attribute: 'property',
  label: 'property',
  link_text: 'property',
  tag: 'tag',
  'diff.plus': 'inserted',
  'diff.minus': 'deleted',
  link_uri: 'link',
  title: 'strong',
  'emphasis.strong': 'strong',
  emphasis: 'emphasis',
};

/** A theme whose colors are the group names: the highlighter writes `var(--hl-<group>)`. */
const THEME = {
  name: 'opspile',
  appearance: 'light',
  cssVariables: { prefix: '--hl-' },
  style: { syntax: GROUPS },
};
const GROUP = /^var\(--hl-([a-z]+)\)$/;
const CLASSES = new Set(Object.values(GROUPS));

const encode = (s) => s.replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));

const PLAIN = /^(plain|plaintext|text|txt)$/i;

/** Lines that start with a date (and maybe a time): a log. */
const LOG_LINE = /^\[?(\d{4}-\d{2}-\d{2}|\d{2}[./]\d{2}[./]\d{4})[ T]\d{2}:\d{2}/;
const SHELL = /^(\$ |# )?(curl|wget|npm|npx|yarn|pnpm|node|aio|git|docker|kubectl|helm|mvn|gradle|brew|ssh|scp|sudo|cd|export|echo|cat|grep|ls|chmod|openssl|dig|nslookup|aws|az|gcloud|java|python3?|pip3?)\b/;
const SQL = /^\s*(select\b[\s\S]*\bfrom\b|insert\s+into\b|update\b[\s\S]*\bset\b|delete\s+from\b|create\s+(table|index|view)\b|with\s+\w+\s+as\s*\()/i;
const HTTP = /^([A-Z]+ \S+ HTTP\/\d(\.\d)?|HTTP\/\d(\.\d)? \d{3}\b)/;
const DIFF = /^(diff --git |--- \S|@@ -\d)/m;
const APACHE = /^\s*(RewriteRule|RewriteCond|RewriteEngine|<VirtualHost|<IfModule|<Directory|<Location|Header\s+(set|always|unset)|ProxyPass)\b/m;
const JAVA = /^\s*(package [\w.]+;|import (static )?[\w.]+(\.\*)?;|(public |private |protected )(final |static |abstract )*(class|interface|enum|record|@interface) \w)/m;
const JS = /^\s*(import .+ from ['"]|import ['"]|export (default |const |function |class |async )|const \w+ = |let \w+ = |function \w*\s*\(|async function |console\.log\(|document\.|window\.)/m;
const PYTHON = /^\s*(def \w+\(.*\):|class \w+(\(.*\))?:|from [\w.]+ import |import [\w.]+$|if __name__ == )/m;
const YAML_LINE = /^\s*(- )?([\w.@/-]+|"[^"]*"|'[^']*'):( |$)|^\s*- \S|^\s*#|^---$/;
const CSS = /^[^{}\n]+\{\s*\n?(\s*[\w-]+\s*:[^;{}]+;\s*\n?)+\s*\}/;

/**
 * The language of a code block, by what it looks like, or '' when it is not clear: JSON that
 * parses (or nearly), markup, a diff, Apache or dispatcher rewrites, an HTTP exchange, logs,
 * SQL, Java, JavaScript, Python, CSS, shell commands, YAML.
 *
 * @param {string} code
 */
export function guessLanguage(code) {
  const text = String(code || '').trim();
  if (!text) {
    return '';
  }
  const lines = text.split('\n').filter((l) => l.trim());
  const first = lines[0];
  if (/^[{[]/.test(text)) {
    try {
      JSON.parse(text);
      return 'json';
    } catch {
      // Cut off, commented, or a trailing comma: still JSON, if its keys are quoted.
      if (/^[{[]\s*("[^"\n]*"\s*:|[{["\d-]|true|false|null)/.test(text)) {
        return 'jsonc';
      }
    }
  }
  if (DIFF.test(text) && lines.some((l) => /^[+-]/.test(l))) {
    return 'diff';
  }
  if (APACHE.test(text)) {
    return 'apache';
  }
  if (/^<(!doctype html|html[\s>])/i.test(text)) {
    return 'html';
  }
  if (/^<(\?xml|[a-zA-Z][\w:.-]*[\s>/])/.test(text) && /\/?>\s*$/.test(text)) {
    return /^<(\?xml|jcr:root)/.test(text) || !/^<(div|span|p|a|script|style|head|body|meta|link|img|section|main|header|footer|ul|ol|li|table|form|input|button)[\s>]/i.test(text) ? 'xml' : 'html';
  }
  if (HTTP.test(first)) {
    return 'http';
  }
  if (lines.length >= 2 && lines.filter((l) => LOG_LINE.test(l)).length >= lines.length / 2) {
    return 'log';
  }
  if (LOG_LINE.test(first) && lines.length === 1) {
    return 'log';
  }
  if (SQL.test(text)) {
    return 'sql';
  }
  if (JAVA.test(text)) {
    return 'java';
  }
  if (JS.test(text)) {
    return 'javascript';
  }
  if (PYTHON.test(text)) {
    return 'python';
  }
  if (CSS.test(text)) {
    return 'css';
  }
  if (SHELL.test(first)) {
    return 'bash';
  }
  if (lines.length >= 2 && lines.every((l) => YAML_LINE.test(l))
    && lines.some((l) => /:( |$)/.test(l))) {
    return 'yaml';
  }
  return '';
}

/**
 * A code block's text as HTML, its tokens as `<span class="hl-…">` runs, or null to leave it as
 * it is: a language the highlighter does not know (or none it can guess), plain text, or a block
 * over `LONGEST`. The text is the block's exactly, so copying it copies its source.
 *
 * @param {string} code the block's text
 * @param {string} [lang] the fence's language, if it names one
 */
export function highlight(code, lang = '') {
  const text = String(code ?? '');
  const named = String(lang || '').trim().split(/\s/)[0].toLowerCase();
  const language = named || guessLanguage(text);
  if (!language || text.length > LONGEST || PLAIN.test(language)
    || !isSupportedLanguage(language)) {
    return null;
  }
  const { tokens } = codeToTokens(text, {
    lang: language, theme: THEME, tokenizeMaxLineLength: LONGEST_LINE,
  });
  let out = '';
  let at = 0;
  for (const token of tokens.flat()) {
    out += encode(text.slice(at, token.offset));
    const group = GROUP.exec(token.color || '');
    const content = encode(token.content);
    out += group && CLASSES.has(group[1]) ? `<span class="hl-${group[1]}">${content}</span>` : content;
    at = token.offset + token.content.length;
  }
  return out + encode(text.slice(at));
}
