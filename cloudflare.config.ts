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
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  bindings, defineConfig, exports as workerExports, triggers,
} from 'cf/config';

if (existsSync('.env')) process.loadEnvFile('.env');

// The inbox's markdown renderer, bundled for the browser (src/ui-markdown.bundle.js, not
// committed): built on every cf deploy and cf dev, so the page matches src/ui-markdown.js and
// the pinned micromark.
execFileSync(process.execPath, ['scripts/ui-markdown.mjs'], { stdio: ['ignore', 'ignore', 'inherit'] });

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

// Thread agents, optional: they run only when AGENT_MODEL is set, and only in AGENT_CHANNELS
// (comma-separated channel ids). AGENT_GATEWAY names the AI Gateway in front of Amazon Bedrock,
// in the account AI_GATEWAY_ACCOUNT (default: the Worker's); AGENT_REGION is the Bedrock
// region (default us-east-2).
const AGENT_VARS = [
  'AGENT_MODEL', 'AGENT_CHANNELS', 'AGENT_GATEWAY', 'AGENT_REGION', 'AI_GATEWAY_ACCOUNT',
  'AGENT_ANTHROPIC_BETA', 'AGENT_BASE_URL',
] as const;

const SECRETS = [
  'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'MS_CLIENT_SECRET', 'DIAG_TOKEN', 'GRAPH_CLIENT_STATE',
  // Posting as the user: the Slack app's client secret, and the key that encrypts tokens.
  'SLACK_CLIENT_SECRET', 'TOKEN_KEY',
  // Thread agents: the Amazon Bedrock API key, and (AI_GATEWAY_TOKEN_REQUIRED=1) a token for
  // an authenticated AI Gateway. Required only where agents are on.
  ...(process.env.AGENT_MODEL ? ['BEDROCK_API_KEY'] : []),
  ...(process.env.AGENT_MODEL && process.env.AI_GATEWAY_TOKEN_REQUIRED ? ['AI_GATEWAY_TOKEN'] : []),
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
    // Pile 3: one knowledge-base repo per org and per team (#12). Artifacts creates the
    // namespace with its first repo.
    ARTIFACTS: bindings.artifacts({ namespace: `helix-opspile${suffix}` }),
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
  // The gateway lives in the Worker's own account unless AI_GATEWAY_ACCOUNT says otherwise.
  const values: Record<string, string | undefined> = {
    ...process.env,
    AI_GATEWAY_ACCOUNT: process.env.AI_GATEWAY_ACCOUNT
      || (process.env.AGENT_MODEL ? process.env.CLOUDFLARE_ACCOUNT_ID : undefined),
  };
  return Object.fromEntries(
    [...VARS, ...AGENT_VARS].filter((name) => values[name])
      .map((name) => [name, bindings.text(values[name] as string)]),
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
      // Pi (thread agents) and isomorphic-git use Node's Buffer and friends.
      compatibilityFlags: ['nodejs_compat'],
      // Renews the Graph subscription, which lives at most 60 minutes (#5), and creates
      // missing team knowledge bases (#12).
      exports: {
        TeamRoom: workerExports.durableObject({ storage: 'sqlite' }),
        ThreadAgent: workerExports.durableObject({ storage: 'sqlite' }),
      },
      triggers: deployed
        ? [triggers.scheduled({ schedule: '*/20 * * * *' }), ...consumers(mode)]
        : [],
      env: {
        ...vars(deployed),
        ...resources(mode),
        // One Durable Object per ops team: live read state (#7).
        ROOMS: bindings.durableObject({ worker: name, exportName: 'TeamRoom' }),
        // One Durable Object per inbox entry: its thread agent.
        AGENTS: bindings.durableObject({ worker: name, exportName: 'ThreadAgent' }),
        ...Object.fromEntries(SECRETS.map((name) => [name, bindings.secret()])),
      },
    },
  };
});
