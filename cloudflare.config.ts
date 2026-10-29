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

// The inbox's markdown renderer and the knowledge-base editor, bundled for the browser
// (src/ui-markdown.bundle.js and src/ui-editor.bundle.js, not committed): built on every cf
// deploy and cf dev, so the pages match src/ui-*.js and the pinned micromark and CodeMirror.
execFileSync(process.execPath, ['scripts/ui-markdown.mjs'], { stdio: ['ignore', 'ignore', 'inherit'] });

const NAMES: Record<string, string> = {
  prod: 'helix-opspile-prod',
  stage: 'helix-opspile-stage',
};

// PUBLIC_ORIGIN: this Worker's https origin, where Graph sends notifications.
// STAFF_DOMAINS: comma-separated mail domains whose people count as staff.
// ACCESS_TEAM_DOMAIN, ACCESS_AUD: the Cloudflare Access app in front of /inbox and /api.
// SLACK_CLIENT_ID: the Slack app's client id, for people connecting their Slack account.
// SLACK_JOIN_TEAMS (optional, below): comma-separated Slack workspace ids whose public channels
// the app joins by itself (src/autojoin.js).
const VARS = [
  'MS_CLIENT_ID', 'MS_TENANT_ID', 'PUBLIC_ORIGIN', 'STAFF_DOMAINS', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD',
  'SLACK_CLIENT_ID',
] as const;

// Thread agents, optional: they run only when AGENT_MODEL is set, and only in channels where
// they are on (switched in the knowledge-base editor; AGENT_CHANNELS, comma-separated channel
// ids, is the default for channels nobody switched). AGENT_GATEWAY names the AI Gateway in front of Amazon Bedrock,
// in the account AI_GATEWAY_ACCOUNT (default: the Worker's); AGENT_REGION is the Bedrock
// region (default us-east-2).
// The sign-in allow list (Cloudflare Access policy of the inbox) follows the ops teams when
// these are set, with the secret ACCESS_API_TOKEN (Access: Apps and Policies Write).
const ACCESS_SYNC_VARS = ['ACCESS_ACCOUNT_ID', 'ACCESS_APP_ID', 'ACCESS_POLICY_ID'] as const;
// No-team mode, optional: SIGNIN_DOMAINS, comma-separated mail domains whose people may sign in
// without being on an ops team (their personal view only); the allow list gets them as domains.
const SIGNIN_VARS = ['SIGNIN_DOMAINS'] as const;

// RETIRED_ORIGINS: comma-separated origins the Worker answered on before PUBLIC_ORIGIN; pages
// opened there are redirected, and Graph subscriptions still pointing there are removed.
const MOVE_VARS = ['RETIRED_ORIGINS'] as const;

const SLACK_VARS = ['SLACK_JOIN_TEAMS'] as const;

// Discord, optional: DISCORD_GUILDS (comma-separated server ids) turns the poller on, with the
// secret DISCORD_BOT_TOKEN. DISCORD_STAFF_ROLES: role ids whose members count as staff;
// DISCORD_HISTORY_DAYS: how far back the first poll reads (default 30); DISCORD_POLL_SECONDS:
// how often it polls (default 60). DISCORD_CLIENT_ID
// and the secret DISCORD_CLIENT_SECRET let people connect their Discord account.
const DISCORD_VARS = [
  'DISCORD_GUILDS', 'DISCORD_STAFF_ROLES', 'DISCORD_HISTORY_DAYS', 'DISCORD_POLL_SECONDS',
  'DISCORD_CLIENT_ID',
] as const;

// The klickhaus export, optional: rows of every message in ClickHouse (src/clickhouse.js). It is
// off unless CLICKHOUSE_URL (the HTTP interface's https origin), CLICKHOUSE_DATABASE,
// CLICKHOUSE_USER and the secret CLICKHOUSE_PASSWORD are set.
const CLICKHOUSE_VARS = ['CLICKHOUSE_URL', 'CLICKHOUSE_DATABASE', 'CLICKHOUSE_USER'] as const;

// TEAMS_APP_ID: the opspile Teams app's id in the org catalog, which turns the Teams bot on
// (agents' post_message in Teams threads; src/teamsbot.js). TEAMS_BOT_SERVICE_URL: the Bot
// Connector to post through, default the public cloud's.
const AGENT_VARS = [
  'AGENT_MODEL', 'AGENT_CHANNELS', 'AGENT_GATEWAY', 'AGENT_REGION', 'AI_GATEWAY_ACCOUNT',
  'AGENT_ANTHROPIC_BETA', 'AGENT_BASE_URL', 'TEAMS_APP_ID', 'TEAMS_BOT_SERVICE_URL',
] as const;

const SECRETS = [
  'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'MS_CLIENT_SECRET', 'DIAG_TOKEN', 'GRAPH_CLIENT_STATE',
  // Posting as the user: the Slack app's client secret, and the key that encrypts tokens.
  'SLACK_CLIENT_SECRET', 'TOKEN_KEY',
  // Thread agents: the Amazon Bedrock API key, and (AI_GATEWAY_TOKEN_REQUIRED=1) a token for
  // an authenticated AI Gateway. Required only where agents are on.
  ...(process.env.AGENT_MODEL ? ['BEDROCK_API_KEY'] : []),
  // The global browser MCP server (Cloudflare's hosted Browser Run one): an account API token
  // with Browser Run Write only. Required only where agents are on.
  ...(process.env.AGENT_MODEL ? ['BROWSER_RUN_TOKEN'] : []),
  ...(process.env.AGENT_MODEL && process.env.AI_GATEWAY_TOKEN_REQUIRED ? ['AI_GATEWAY_TOKEN'] : []),
  // Access sync: required only where it is configured.
  ...(process.env.ACCESS_APP_ID ? ['ACCESS_API_TOKEN'] : []),
  // Discord: the bot's token where the poller is on, the app's secret where people connect.
  ...(process.env.DISCORD_GUILDS ? ['DISCORD_BOT_TOKEN'] : []),
  ...(process.env.DISCORD_CLIENT_ID ? ['DISCORD_CLIENT_SECRET'] : []),
  // The klickhaus export's ClickHouse password, where it is on.
  ...(process.env.CLICKHOUSE_URL ? ['CLICKHOUSE_PASSWORD'] : []),
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
    // Every message a person posted in a channel thread, and every such thread as a whole
    // (src/vectors.js). Created by hand (768 dimensions, cosine, metadata indexes); see README.
    CONTENT: bindings.vectorize({ name: `helix-opspile-content${suffix}` }),
    // Full-text search: one item per message of a channel thread (src/fulltext.js), in an AI
    // Search instance with built-in storage. Created by hand (hybrid, custom metadata); see
    // README. AI Search does not run locally.
    SEARCH: bindings.aiSearch({ name: `helix-opspile-messages${suffix}`, dev: { remote: true } }),
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
    [...VARS, ...AGENT_VARS, ...ACCESS_SYNC_VARS, ...SIGNIN_VARS, ...MOVE_VARS, ...SLACK_VARS,
      ...DISCORD_VARS, ...CLICKHOUSE_VARS]
      .filter((name) => values[name])
      .map((name) => [name, bindings.text(values[name] as string)]),
  );
}

// WORKER_DOMAINS: comma-separated custom domains for the deployed Worker (its zone must be in
// the account). The workers.dev address stays on beside them.
const domains = () => String(process.env.WORKER_DOMAINS || '').split(',')
  .map((d) => d.trim()).filter(Boolean);

export default defineConfig(({ mode }) => {
  const deployed = Boolean(mode && NAMES[mode]);
  const name = deployed ? NAMES[mode as string] : 'helix-opspile';
  return {
    worker: {
      name,
      compatibilityDate: '2026-10-01',
      entrypoint: 'src/index.js',
      previewUrls: false,
      workersDev: true,
      ...(deployed && domains().length ? { domains: domains() } : {}),
      // Workers Logs; logs carry event metadata only, never message content.
      observability: { enabled: true },
      // Pi (thread agents) and isomorphic-git use Node's Buffer and friends.
      compatibilityFlags: ['nodejs_compat'],
      // Renews the Graph subscription, which lives at most 60 minutes (#5), and creates
      // missing team knowledge bases (#12).
      exports: {
        TeamRoom: workerExports.durableObject({ storage: 'sqlite' }),
        ThreadAgent: workerExports.durableObject({ storage: 'sqlite' }),
        DiscordPoller: workerExports.durableObject({ storage: 'sqlite' }),
        // The browser boxes of the first global browser server, replaced by Cloudflare's
        // hosted Browser Run MCP server: the class is gone, so is its namespace.
        BrowserBox: workerExports.durableObject({ state: 'deleted' }),
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
        // The Discord poller: one object reads the servers' new messages every minute.
        DISCORD: bindings.durableObject({ worker: name, exportName: 'DiscordPoller' }),
        // Dynamic Workers: the shells of the agents' computers (the `computer` tool).
        LOADER: bindings.workerLoader(),
        ...Object.fromEntries(SECRETS.map((name) => [name, bindings.secret()])),
      },
    },
  };
});
