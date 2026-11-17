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
 * The secrets of the dev computer (scripts/dev-computer/worker.mjs), which has no D1 to keep a
 * team's: what its gateway puts into its programs' requests (src/agent/secrets.js `forward`).
 */

import { placeholder } from '../../src/agent/secrets.js';

/**
 * The dev computer's secrets, which it has without D1: `GITHUB_TOKEN` (a Worker secret, the
 * `Computer on stage` run's own read-only token, gone when the run ends), sent to github.com
 * only, as a team's secret is (src/agent/secrets.js).
 */
export function devSecrets(env) {
  return async () => new Map(env.GITHUB_TOKEN ? [['GITHUB_TOKEN', {
    hosts: ['github.com'], value: () => env.GITHUB_TOKEN,
  }]] : []);
}

/**
 * What every command of the dev computer has in its environment when it has a GITHUB_TOKEN:
 * git's configuration, which sends it to github.com, as its placeholder (the gateway puts the
 * value in). So git's checks clone as the run, not anonymously from Cloudflare's address,
 * which GitHub limits (429).
 */
export function devEnv(env) {
  if (!env.GITHUB_TOKEN) {
    return {};
  }
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x-access-token:${placeholder('GITHUB_TOKEN')}`)}`,
  };
}
