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
import globals from 'globals';
import { recommended } from '@adobe/eslint-config-helix';

export default [
  {
    ignores: ['node_modules/**', '.wrangler/**', '.cloudflare/**', 'coverage/**', 'dist/**'],
  },
  {
    ...recommended,
    files: ['src/**/*.js', 'test/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      ...recommended.languageOptions,
      // Import attributes: src/index.js imports the pages' scripts as text.
      ecmaVersion: 'latest',
      globals: {
        ...recommended.languageOptions.globals,
        ...globals.serviceworker,
        WebSocketPair: 'readonly',
      },
    },
    rules: {
      ...recommended.rules,
      // Workers runtime modules, and packages that only declare `exports` (the resolver does
      // not read them).
      'import/no-unresolved': ['error', { ignore: ['^cloudflare:', '^agents(/|$)', '^@earendil-works/', '^@modelcontextprotocol/', '^@cloudflare/computer/'] }],
      // console is how a Worker writes to Workers Logs.
      'no-console': 'off',
      'max-len': ['error', 100, 2, {
        ignoreUrls: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreRegExpLiterals: true,
      }],
    },
  },
  {
    // Build scripts and tests may use dev dependencies (esbuild for scripts/ui-markdown.mjs).
    files: ['test/**/*.js', 'scripts/**/*.mjs'],
    rules: {
      'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
    },
  },
  {
    // The pages' scripts (src/page.js inlines them into ui/*.html): browser code. The pages'
    // own are module scripts; app.js and header.js, which every page runs, are classic ones.
    ...recommended,
    files: ['ui/**/*.js'],
    languageOptions: {
      ...recommended.languageOptions,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // The markdown renderer, src/ui-markdown.js, bundled (`markdown.js` in the page).
        Markdown: 'readonly',
        // The knowledge-base editor's text field, src/ui-editor.js, bundled (`editor.js`).
        Editor: 'readonly',
        // Every page's header, ui/header.js.
        Header: 'readonly',
        // The team order's model, ui/rank.js (the inbox).
        Rank: 'readonly',
      },
    },
    rules: {
      ...recommended.rules,
      // The pages' layout: one-line ifs and objects, several statements on a line, helpers
      // after the code that calls them, DOM nodes' own __fields. Correctness rules stay on.
      curly: 'off',
      'max-statements-per-line': 'off',
      'object-property-newline': 'off',
      'object-curly-newline': 'off',
      'newline-per-chained-call': 'off',
      'no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
      'no-underscore-dangle': 'off',
      'no-nested-ternary': 'off',
      'no-continue': 'off',
      'no-plusplus': 'off',
      'no-bitwise': 'off',
      'prefer-destructuring': 'off',
      'no-param-reassign': ['error', { props: false }],
      'max-len': 'off',
    },
  },
  {
    files: ['ui/app.js', 'ui/header.js'],
    languageOptions: { sourceType: 'script' },
  },
];
