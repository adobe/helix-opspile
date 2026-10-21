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
    files: ['src/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ...recommended.languageOptions,
      globals: {
        ...recommended.languageOptions.globals,
        ...globals.serviceworker,
      },
    },
    rules: {
      ...recommended.rules,
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
];
