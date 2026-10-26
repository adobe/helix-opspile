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

import { seal, unseal } from './post.js';

/**
 * The GitHub App of the global `github` MCP server (src/agent/globals.js): read-only, and
 * installed on the repositories (all of an account's, or a selection) it may read.
 *
 * The admin team creates it from the knowledge-base editor with GitHub's manifest flow: the
 * page posts `appManifest()` to GitHub, GitHub asks the admin to confirm and sends them back
 * with a code, and `createApp()` trades the code for the app's id and private key, which is
 * kept in D1 (`github_apps`), sealed with TOKEN_KEY. Nobody copies a key anywhere.
 *
 * The agents read with installation tokens (an hour each), minted with a JWT the private key
 * signs; one token per installation, kept per isolate until shortly before it expires.
 */

export const GITHUB_API = 'https://api.github.com';
const UA = 'helix-opspile';
const INSTALLATIONS_TTL_MS = 5 * 60 * 1000;
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

/** What the app may do: read, nothing else. */
export const APP_PERMISSIONS = {
  actions: 'read',
  checks: 'read',
  contents: 'read',
  discussions: 'read',
  issues: 'read',
  metadata: 'read',
  pull_requests: 'read',
  statuses: 'read',
};

const origin = (env) => String(env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');

/** GitHub's own limit on app names. */
const MAX_NAME = 34;

/**
 * The manifest of the app, as the page posts it to GitHub. `name` must be unique on GitHub;
 * the admin can change it on GitHub's page too.
 */
export function appManifest(env, { name } = {}) {
  const base = origin(env);
  const host = base ? new URL(base).hostname.split('.')[0] : 'opspile';
  return {
    name: String(name || `opspile ${host}`).trim().slice(0, MAX_NAME),
    url: base,
    description: 'Lets the opspile thread agents read the repositories it is installed on,'
      + ' through GitHub\'s MCP server (read-only).',
    redirect_url: `${base}/api/kb/github/created`,
    setup_url: `${base}/inbox/kb?github=installed`,
    setup_on_update: true,
    public: false,
    hook_attributes: { url: `${base}/github/hook`, active: false },
    default_permissions: APP_PERMISSIONS,
    default_events: [],
  };
}

/** Where the page posts the manifest: the person's account, or an organization they own. */
export function manifestAction(org, state) {
  const owner = String(org || '').trim();
  if (owner && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
    return null;
  }
  const path = owner ? `/organizations/${owner}/settings/apps/new` : '/settings/apps/new';
  return `https://github.com${path}?state=${encodeURIComponent(state)}`;
}

// ---- keys --------------------------------------------------------------------------------

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const utf8 = (s) => new TextEncoder().encode(s);

function derLength(n) {
  if (n < 0x80) {
    return [n];
  }
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) {
    bytes.unshift(v % 256);
  }
  return [0x80 + bytes.length, ...bytes];
}

const der = (tag, body) => Uint8Array.from([tag, ...derLength(body.length), ...body]);

// AlgorithmIdentifier { rsaEncryption, NULL } and version 0 of a PKCS#8 PrivateKeyInfo.
const RSA_ALGORITHM = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00];
const VERSION_0 = [0x02, 0x01, 0x00];

/**
 * A private key as PKCS#8 PEM, which Web Crypto imports. GitHub hands out PKCS#1
 * (`BEGIN RSA PRIVATE KEY`); that one is wrapped, PKCS#8 is returned as is.
 */
export function pkcs8Pem(pem) {
  const text = String(pem || '').trim();
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(text);
  if (!m) {
    throw new Error('not a PEM private key');
  }
  if (!m[1]) {
    return text;
  }
  const pkcs1 = fromB64(m[2].replace(/\s+/g, ''));
  const info = der(0x30, [...VERSION_0, ...RSA_ALGORITHM, ...der(0x04, [...pkcs1])]);
  const lines = b64(info).match(/.{1,64}/g).join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

async function signingKey(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return crypto.subtle.importKey(
    'pkcs8',
    fromB64(body),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** A JWT that authenticates as the app, for ten minutes (backdated a minute for clock skew). */
export async function appJwt(app, now = Date.now()) {
  const s = Math.floor(now / 1000);
  const header = b64url(utf8(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = b64url(utf8(JSON.stringify({
    iat: s - 60, exp: s + 540, iss: String(app.client_id || app.id),
  })));
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    await signingKey(app.privateKey),
    utf8(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

// ---- the app -----------------------------------------------------------------------------

async function github(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': UA,
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GitHub ${method} ${path.split('?')[0]}: ${res.status} ${data.message || ''}`.trim());
  }
  return data;
}

/** The app in use (the newest), with its private key unsealed; null when there is none. */
export async function currentApp(env) {
  const row = await env.DB.prepare('SELECT * FROM github_apps ORDER BY created_at DESC, id DESC LIMIT 1')
    .first().catch(() => null);
  if (!row) {
    return null;
  }
  return { ...row, privateKey: await unseal(env, row.private_key) };
}

/** The app as the editor shows it: no secrets. */
export function shownApp(app) {
  return app && {
    id: app.id,
    slug: app.slug,
    name: app.name,
    owner: app.owner,
    htmlUrl: app.html_url,
    installUrl: `https://github.com/apps/${app.slug}/installations/new`,
    createdBy: app.created_by,
    createdAt: app.created_at,
  };
}

/**
 * Trades the code GitHub sent back after the admin confirmed the manifest for the new app,
 * and keeps it. Resolves to the stored row (no secrets).
 */
export async function createApp(env, code, by) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(code || ''))) {
    throw new Error('GitHub did not send a code');
  }
  const app = await github(`/app-manifests/${code}/conversions`, { method: 'POST' });
  const privateKey = pkcs8Pem(app.pem);
  const sealed = async (v) => (v ? seal(env, v) : null);
  const row = {
    id: app.id,
    slug: app.slug,
    name: app.name || app.slug,
    owner: (app.owner && app.owner.login) || null,
    html_url: app.html_url || null,
    client_id: app.client_id || null,
    private_key: await seal(env, privateKey),
    client_secret: await sealed(app.client_secret),
    webhook_secret: await sealed(app.webhook_secret),
    created_by: by,
    created_at: new Date().toISOString(),
  };
  const cols = Object.keys(row);
  await env.DB.prepare(`INSERT OR REPLACE INTO github_apps (${cols.join(', ')})
    VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map((c) => row[c])).run();
  return row;
}

const installationCache = new Map();
const tokenCache = new Map();

/** Forgets what this isolate knows of the app's installations and tokens. */
export function forgetGithub() {
  installationCache.clear();
  tokenCache.clear();
}

/**
 * Where the app is installed: `[{ id, account, accountType, selection, htmlUrl, suspended }]`,
 * kept for a few minutes per isolate.
 */
export async function installations(env, app, now = Date.now()) {
  const cached = installationCache.get(app.id);
  if (cached && now - cached.at < INSTALLATIONS_TTL_MS) {
    return cached.list;
  }
  const list = (await github('/app/installations?per_page=100', { token: await appJwt(app, now) }))
    .map((i) => ({
      id: i.id,
      account: (i.account && i.account.login) || String(i.id),
      accountType: (i.account && i.account.type) || null,
      selection: i.repository_selection || null,
      htmlUrl: i.html_url || null,
      suspended: Boolean(i.suspended_at),
    }));
  installationCache.set(app.id, { at: now, list });
  return list;
}

/** An installation token: `{ token, expiresAt }` (ms), reused until shortly before it expires. */
export async function installationToken(env, app, installationId, now = Date.now()) {
  const key = `${app.id}:${installationId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - TOKEN_MARGIN_MS > now) {
    return cached;
  }
  const res = await github(`/app/installations/${Number(installationId)}/access_tokens`, {
    method: 'POST', token: await appJwt(app, now),
  });
  const value = { token: res.token, expiresAt: Date.parse(res.expires_at) || now + 3600_000 };
  tokenCache.set(key, value);
  return value;
}
