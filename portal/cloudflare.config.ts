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

// The customer portal (src/portal/worker.js), a Worker of its own, deployed from this directory
// with the repository's packages: `npm run deploy:portal:test` (or `:prod`), which is
// `cf deploy --mode test` here. README, "Customer portal".
//
// This repo is public: the account comes from the bound `cf auth` profile (or
// CLOUDFLARE_ACCOUNT_ID), and the plain-text values from the environment, an uncommitted
// `portal/.env`, or the repository's `.env`. cf has no `keep_vars`, so a deploy without them
// would wipe them.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindings, defineConfig, triggers } from 'cf/config';

const here = dirname(fileURLToPath(import.meta.url));
// The portal's own values first: a variable set stays as it is.
for (const file of [join(here, '.env'), join(here, '..', '.env')]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

// The page's markdown renderer and Spectrum 2's tokens (src/ui-markdown.bundle.js,
// src/ui-spectrum.bundle.js, not committed), as the inbox's deploy builds them.
execFileSync(process.execPath, ['scripts/ui-markdown.mjs'], {
  cwd: join(here, '..'), stdio: ['ignore', 'ignore', 'inherit'],
});

const NAMES: Record<string, string> = {
  prod: 'helix-opspile-portal',
  test: 'helix-opspile-portal-test',
};

// PORTAL_DOMAINS: comma-separated mail domains whose people may use the portal. Nobody else
// gets past its API, whatever Access lets in.
// PORTAL_ACCESS_AUD: the audience tag of the Cloudflare Access application in front of the
// portal (one-time codes by mail), in the Zero Trust organization PORTAL_ACCESS_TEAM_DOMAIN
// (default: ACCESS_TEAM_DOMAIN, the inbox's).
// PORTAL_ORIGIN (optional): the portal's own https origin, for the links to its messages.
// PORTAL_NAME (optional): what its events are keyed under in the inbox's pile 1 (default: the
// mode), so that two portals feeding one inbox stay apart.
function vars(deployed: boolean, mode: string | undefined) {
  const values: Record<string, string | undefined> = {
    PORTAL_DOMAINS: process.env.PORTAL_DOMAINS,
    ACCESS_TEAM_DOMAIN: process.env.PORTAL_ACCESS_TEAM_DOMAIN || process.env.ACCESS_TEAM_DOMAIN,
    ACCESS_AUD: process.env.PORTAL_ACCESS_AUD,
    PORTAL_INTEGRATION_AUD: process.env.PORTAL_INTEGRATION_AUD,
    PUBLIC_ORIGIN: process.env.PORTAL_ORIGIN,
    PORTAL_NAME: process.env.PORTAL_NAME || (deployed ? mode : undefined),
  };
  const missing = [
    ['PORTAL_DOMAINS', 'PORTAL_DOMAINS'], ['ACCESS_TEAM_DOMAIN', 'PORTAL_ACCESS_TEAM_DOMAIN'],
    ['ACCESS_AUD', 'PORTAL_ACCESS_AUD'],
  ].filter(([name]) => !values[name]).map(([, exported]) => exported);
  if (deployed && missing.length) {
    throw new Error(`export ${missing.join(', ')} before deploying (see README "Customer portal")`);
  }
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v)
    .map(([k, v]) => [k, bindings.text(v as string)]));
}

// PORTAL_OPSPILE_WORKER (optional): the inbox's Worker (helix-opspile-prod), of the same
// account. With it the portal is bound to the inbox's `PortalSource` entrypoint
// (src/portalentry.js): its events reach the inbox, and it lists the inbox's technologies.
// Without it the portal stands alone and its events wait in its outbox: deploy it so before the
// inbox has the entrypoint.
function inbox() {
  const worker = process.env.PORTAL_OPSPILE_WORKER;
  return worker ? { OPSPILE: bindings.worker({ worker, exportName: 'PortalSource' }) } : {};
}

// PORTAL_WORKER_DOMAINS (optional): comma-separated custom domains (their zone must be in the
// account). The workers.dev address stays on beside them.
const domains = () => String(process.env.PORTAL_WORKER_DOMAINS || '').split(',')
  .map((d) => d.trim()).filter(Boolean);

export default defineConfig(({ mode }) => {
  const deployed = Boolean(mode && NAMES[mode]);
  const name = deployed ? NAMES[mode as string] : 'helix-opspile-portal-dev';
  return {
    worker: {
      name,
      compatibilityDate: '2026-10-01',
      entrypoint: '../src/portal/worker.js',
      previewUrls: false,
      workersDev: true,
      ...(deployed && domains().length ? { domains: domains() } : {}),
      // Workers Logs; logs carry event metadata only, never message content.
      observability: { enabled: true },
      compatibilityFlags: ['nodejs_compat'],
      // What the inbox has not heard of yet goes out again, every other minute.
      triggers: deployed ? [triggers.scheduled({ schedule: '*/2 * * * *' })] : [],
      env: {
        ...vars(deployed, mode),
        ...inbox(),
        // The portal's own record (portal/migrations), of the Worker's name.
        DB: bindings.d1({ name }),
        // What its people upload: the files of messages, their pictures, customers' logos
        // (src/portal/files.js). `cf deploy` makes the bucket.
        FILES: bindings.r2({ name: `${name}-files` }),
      },
    },
  };
});
