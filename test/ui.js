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

/** The pages of ui/ and their scripts, read as src/index.js imports them. */

import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../ui/', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8');
const files = readdirSync(dir);

/** ui/<name>.html by file name. */
export const PAGES = Object.fromEntries(files.filter((f) => f.endsWith('.html')).map((f) => [f, read(f)]));

/** ui/<name>.js by file name, as src/page.js takes them. */
export const SCRIPTS = Object.fromEntries(files.filter((f) => f.endsWith('.js')).map((f) => [f, read(f)]));
