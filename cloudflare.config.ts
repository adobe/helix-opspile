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

// helix-opspile ingest Worker, deployed with `cf deploy --mode prod|stage`.
//
// This repo is public: the account comes from the bound `cf auth` profile (or
// CLOUDFLARE_ACCOUNT_ID), and the plain-text ids come from the environment or an
// uncommitted `.env`. cf has no `keep_vars`, so a deploy without them would wipe them.
// Secrets are declared only by name; cf checks that they exist and keeps their values.
import { existsSync } from 'node:fs';
import {
  bindings, defineConfig, exports as workerExports, triggers,
} from 'cf/config';

if (existsSync('.env')) process.loadEnvFile('.env');

const NAMES: Record<string, string> = {
  prod: 'helix-opspile-prod',
  stage: 'helix-opspile-stage',
};

// PUBLIC_ORIGIN: this Worker's https origin, where Graph sends notifications.
// STAFF_DOMAINS: comma-separated mail domains whose people count as staff.
// ACCESS_TEAM_DOMAIN, ACCESS_AUD: the Cloudflare Access app in front of /inbox and /api.
// SLACK_CLIENT_ID: the Slack app's client id, for people connecting their Slack account.
const VARS = [
  'MS_CLIENT_ID', 'MS_TENANT_ID', 'PUBLIC_ORIGIN', 'STAFF_DOMAINS', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD',
  'SLACK_CLIENT_ID',
] as const;

const SECRETS = [
  'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'MS_CLIENT_SECRET', 'DIAG_TOKEN', 'GRAPH_CLIENT_STATE',
  // Posting as the user: the Slack app's client secret, and the key that encrypts tokens.
  'SLACK_CLIENT_SECRET', 'TOKEN_KEY',
];

/** Per-environment resource names; `cf deploy` creates them if they are missing. */
function resources(mode: string | undefined) {
  const suffix = mode === 'prod' ? '' : `-${mode || 'dev'}`;
  return {
    RAW: bindings.r2({ name: `helix-opspile-raw${suffix}` }),
    CHANNELS: bindings.r2({ name: `helix-opspile-channels${suffix}` }),
    NORMALIZE: bindings.queue({ name: `helix-opspile-normalize${suffix}` }),
    DB: bindings.d1({ name: `helix-opspile${suffix}` }),
    // Workers AI: Clef (thread labels) and Clairic (facts).
    AI: bindings.ai(),
    // Root messages, for re-threading. Created by hand (768 dimensions, cosine, metadata
    // indexes on `channel` and `at`); see README.
    VECTORS: bindings.vectorize({ name: `helix-opspile-roots${suffix}` }),
  };
}

function consumers(mode: string | undefined) {
  const suffix = mode === 'prod' ? '' : `-${mode}`;
  return [
    triggers.queue({
      name: `helix-opspile-normalize${suffix}`,
      maxBatchSize: 20,
      maxBatchTimeout: 5,
      maxRetries: 5,
      deadLetterQueue: `helix-opspile-normalize-dlq${suffix}`,
    }),
  ];
}

function vars(deployed: boolean) {
  const missing = VARS.filter((name) => !process.env[name]);
  if (deployed && missing.length) {
    throw new Error(`export ${missing.join(', ')} before deploying (see README "Bindings")`);
  }
  return Object.fromEntries(
    VARS.filter((name) => process.env[name])
      .map((name) => [name, bindings.text(process.env[name] as string)]),
  );
}

export default defineConfig(({ mode }) => {
  const deployed = Boolean(mode && NAMES[mode]);
  const name = deployed ? NAMES[mode as string] : 'helix-opspile';
  return {
    worker: {
      name,
      compatibilityDate: '2026-10-01',
      entrypoint: 'src/index.js',
      previewUrls: false,
      // Workers Logs; logs carry event metadata only, never message content.
      observability: { enabled: true },
      // Renews the Graph subscription, which lives at most 60 minutes (#5).
      exports: { TeamRoom: workerExports.durableObject({ storage: 'sqlite' }) },
      triggers: deployed
        ? [triggers.scheduled({ schedule: '*/20 * * * *' }), ...consumers(mode)]
        : [],
      env: {
        ...vars(deployed),
        ...resources(mode),
        // One Durable Object per ops team: live read state (#7).
        ROOMS: bindings.durableObject({ worker: name, exportName: 'TeamRoom' }),
        ...Object.fromEntries(SECRETS.map((name) => [name, bindings.secret()])),
      },
    },
  };
});
