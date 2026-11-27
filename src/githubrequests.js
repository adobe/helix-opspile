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

import {
  approveInstallation, currentApp, forgetGithub, installationsWithApprovals,
} from './github.js';
import { announceRequest } from './requestkeys.js';

/**
 * Requests to install the opspile GitHub App (src/github.js) on one of Adobe's GitHub
 * organizations (migration 0119, `github_install_requests`), each a thread of the admin team's
 * inbox (src/requestthreads.js, kind `github`).
 *
 * Which organizations are Adobe's is configured, never guessed: ADOBE_GITHUB_ORGS, a Worker var,
 * the GitHub logins of Adobe's own organizations (comma- or space-separated). A customer's or a
 * partner's organization is never asked about, however many threads name it: the app is theirs to
 * install, and nobody at Adobe asks them to.
 *
 * The cron's sync (`syncGithubRequests`) counts, for each of those organizations, the inbox
 * entries of the last WINDOW_DAYS whose `repo` or `site` facts (`owner/name`, src/extract.js) name
 * it. One that MIN_THREADS entries name, with no installation the admin team allowed
 * (`github_installations`), is a request: how many threads, which repositories, and where the app
 * is installed from. It closes itself once an installation for the account is allowed (the sync,
 * and at once when the admin team allows one, `closeInstalled`), and the sync takes it back when
 * the organization is no longer listed or no thread of the window names it any more. Dismissed,
 * it is not asked again before its `quiet_until` (QUIET_DAYS by default).
 */

/** The Worker var that lists Adobe's GitHub organizations. */
export const ORGS_VAR = 'ADOBE_GITHUB_ORGS';
/** How many recent threads must name an organization before the admin team is asked. */
export const MIN_THREADS = 5;
/** How far back a thread counts: its latest message by a person. */
export const WINDOW_DAYS = 90;
/** How long a dismissal keeps a request from coming back, by default, and what may be picked. */
export const QUIET_DAYS = 90;
export const QUIET_CHOICES = [30, 90, 365];
/** How many of its repositories and sites a request lists; the rest are counted. */
export const SHOWN_REPOS = 8;
/** Who closes a request when nobody did by hand: the sync. */
export const SYNC_BY = 'opspile';

/** A GitHub login, as GitHub allows them. */
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const DAY_MS = 86400_000;
const clean = (v, n = 200) => String(v ?? '').trim().slice(0, n);

async function rows(env, sql, ...args) {
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return results || [];
}

/** Adobe's GitHub organizations (`ADOBE_GITHUB_ORGS`), lowercase, each once; [] when unset. */
export function adobeOrgs(env) {
  const list = String((env && env[ORGS_VAR]) || '').toLowerCase()
    .split(/[\s,]+/)
    .filter((x) => LOGIN.test(x));
  return [...new Set(list)];
}

/** Whether GitHub account `owner` is one of Adobe's organizations. */
export const isAdobeOrg = (env, owner) => adobeOrgs(env).includes(String(owner || '').toLowerCase());

/** The accounts an installation the admin team allowed reads, lowercase: `Map<account, row>`. */
async function allowedAccounts(env) {
  const list = await rows(env, `SELECT account, approved_by, approved_at FROM github_installations
    WHERE account IS NOT NULL ORDER BY approved_at`);
  return new Map(list.map((r) => [String(r.account).toLowerCase(), r]));
}

/**
 * What the threads of the window say of `orgs` (lowercase logins): `Map<account, { threads,
 * repos: [{ repo, threads }], repoCount, last }>`, an inbox entry counted once however many of its
 * threads (a re-threaded group's) or facts name it, `repo` and `site` facts together.
 */
export async function namedOrgs(env, orgs, now = new Date()) {
  if (!orgs.length) {
    return new Map();
  }
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const list = await rows(env, `SELECT LOWER(f.value) AS value,
      COALESCE(t.logical_thread, t.thread) AS entry, MAX(t.last_at) AS last
    FROM facts f JOIN threads t ON t.thread = f.thread
    WHERE f.field IN ('repo', 'site') AND t.last_at >= ?1
      AND LOWER(SUBSTR(f.value, 1, INSTR(f.value, '/') - 1)) IN (SELECT value FROM json_each(?2))
    GROUP BY 1, 2`, since, JSON.stringify(orgs));
  const by = new Map();
  for (const r of list) {
    const [owner, name] = r.value.split('/');
    if (name) {
      const o = by.get(owner) || { entries: new Set(), repos: new Map(), last: null };
      o.entries.add(r.entry);
      o.repos.set(r.value, (o.repos.get(r.value) || 0) + 1);
      o.last = !o.last || r.last > o.last ? r.last : o.last;
      by.set(owner, o);
    }
  }
  return new Map([...by].map(([owner, o]) => [owner, {
    threads: o.entries.size,
    repos: [...o.repos].map(([repo, threads]) => ({ repo, threads }))
      .sort((a, b) => b.threads - a.threads || a.repo.localeCompare(b.repo)).slice(0, SHOWN_REPOS),
    repoCount: o.repos.size,
    last: o.last,
  }]));
}

/** A request's row as the lists give it. */
export function requestOf(r) {
  let repos = [];
  try {
    repos = JSON.parse(r.repos || '[]');
  } catch {
    repos = [];
  }
  return {
    id: r.id,
    account: r.account,
    threads: r.threads,
    repoCount: r.repo_count,
    repos,
    last: r.last_at || null,
    countedAt: r.counted_at,
    requestedAt: r.requested_at,
    status: r.status,
    decidedBy: r.decided_by && r.decided_by !== SYNC_BY ? { email: r.decided_by } : null,
    decidedAt: r.decided_at || null,
    reason: r.reason || null,
    quietUntil: r.quiet_until || null,
  };
}

/**
 * Closes the open requests of the accounts an allowed installation reads now (`accounts`, or
 * every one of them): `installed`, by whoever allowed it. Their ids; announced.
 */
export async function closeInstalled(env, accounts = null) {
  const allowed = await allowedAccounts(env);
  const open = await rows(env, `SELECT id, account FROM github_install_requests
    WHERE status = 'open'`);
  const want = accounts ? new Set(accounts.map((a) => String(a).toLowerCase())) : null;
  const closed = [];
  for (const r of open) {
    const a = allowed.get(r.account);
    if (a && (!want || want.has(r.account))) {
      // eslint-disable-next-line no-await-in-loop
      const { meta } = await env.DB.prepare(`UPDATE github_install_requests SET status = 'installed',
          decided_by = ?, decided_at = ? WHERE id = ? AND status = 'open'`)
        .bind(a.approved_by || SYNC_BY, new Date().toISOString(), r.id).run();
      if (meta.changes) {
        closed.push(r.id);
        // eslint-disable-next-line no-await-in-loop
        await announceRequest(env, 'github', r.id);
      }
    }
  }
  return closed;
}

/**
 * The sync, on the cron: files a request for each of Adobe's organizations that MIN_THREADS
 * threads of the window name, without an allowed installation, an open request or a dismissal
 * still quiet; keeps the open ones' counts as the threads are now; closes those an allowed
 * installation reads (`installed`); and takes back those no longer listed, or that no thread of
 * the window names any more (`withdrawn`). What it did, in numbers; one announcement for all.
 */
export async function syncGithubRequests(env, now = new Date()) {
  const orgs = adobeOrgs(env);
  const at = now.toISOString();
  const installed = (await closeInstalled(env)).length;
  const [allowed, named, mine] = await Promise.all([
    allowedAccounts(env),
    namedOrgs(env, orgs, now),
    rows(env, `SELECT id, account, status, threads, repo_count, repos, last_at, quiet_until
      FROM github_install_requests WHERE status = 'open' OR (status = 'dismissed' AND quiet_until > ?)`, at),
  ]);
  const open = new Map(mine.filter((r) => r.status === 'open').map((r) => [r.account, r]));
  const quiet = new Set(mine.filter((r) => r.status === 'dismissed').map((r) => r.account));
  let filed = 0;
  let updated = 0;
  let withdrawn = 0;
  for (const [account, r] of open) {
    const n = named.get(account);
    let reason = null;
    if (!orgs.includes(account)) {
      reason = `${account} is no longer listed as one of Adobe's GitHub organizations (${ORGS_VAR})`;
    } else if (!n) {
      reason = `no thread of the last ${WINDOW_DAYS} days names ${account}'s repositories any more`;
    }
    if (reason) {
      // eslint-disable-next-line no-await-in-loop
      const { meta } = await env.DB.prepare(`UPDATE github_install_requests SET status = 'withdrawn',
          decided_by = ?, decided_at = ?, reason = ? WHERE id = ? AND status = 'open'`)
        .bind(SYNC_BY, at, reason, r.id).run();
      withdrawn += meta.changes ? 1 : 0;
    } else {
      const repos = JSON.stringify(n.repos);
      if (n.threads !== r.threads || n.repoCount !== r.repo_count || repos !== r.repos
        || n.last !== r.last_at) {
        // eslint-disable-next-line no-await-in-loop
        await env.DB.prepare(`UPDATE github_install_requests SET threads = ?, repo_count = ?,
            repos = ?, last_at = ?, counted_at = ? WHERE id = ? AND status = 'open'`)
          .bind(n.threads, n.repoCount, repos, n.last, at, r.id).run();
        updated += 1;
      }
    }
  }
  // The most named first, so that the inbox lists them so.
  const asked = [...named].sort(([a, x], [b, y]) => y.threads - x.threads || a.localeCompare(b));
  for (const [account, n] of asked) {
    if (n.threads >= MIN_THREADS && !allowed.has(account) && !open.has(account)
      && !quiet.has(account)) {
      // One open per account (a partial unique index): a sync running beside this one files none.
      // eslint-disable-next-line no-await-in-loop
      const { meta } = await env.DB.prepare(`INSERT OR IGNORE INTO github_install_requests
          (account, threads, repo_count, repos, last_at, counted_at, requested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(account, n.threads, n.repoCount, JSON.stringify(n.repos), n.last, at, at).run();
      filed += meta.changes ? 1 : 0;
    }
  }
  if (filed || withdrawn || updated) {
    await announceRequest(env);
  }
  return {
    orgs: orgs.length, filed, updated, installed, withdrawn,
  };
}

/**
 * The app and where it is installed, for the requests' threads: `{ app: { slug, installUrl } |
 * null, installs: Map<account, installation> | null }`; `installs` null when GitHub could not
 * say (the threads then say nothing of an installation waiting to be allowed).
 */
async function appState(env, accounts) {
  const row = await env.DB.prepare(`SELECT id, slug FROM github_apps
    ORDER BY created_at DESC, id DESC LIMIT 1`).first().catch(() => null);
  if (!row) {
    return { app: null, installs: new Map() };
  }
  const app = {
    slug: row.slug,
    installUrl: `https://github.com/apps/${encodeURIComponent(row.slug)}/installations/new`,
  };
  if (!accounts.length) {
    return { app, installs: new Map() };
  }
  try {
    const full = await currentApp(env);
    const list = full ? await installationsWithApprovals(env, full) : [];
    return {
      app,
      installs: new Map(list.map((i) => [String(i.account).toLowerCase(), i])),
    };
  } catch (e) {
    console.warn(JSON.stringify({ route: 'githubrequests', installations: 'not listed', error: e.message }));
    return { app, installs: null };
  }
}

/** `r` with the app (`app`) and the installation on its account, if any (`installation`). */
function withApp(r, state) {
  const i = state.installs ? state.installs.get(r.account) || null : undefined;
  return {
    ...r,
    app: state.app,
    installation: i === undefined ? undefined : i && {
      id: i.id,
      selection: i.selection,
      suspended: i.suspended,
      approved: i.approved,
      htmlUrl: i.htmlUrl,
    },
  };
}

/** The requests, open ones first and then the latest decided (`limit`), for the admin team. */
export async function listGithubRequests(env, { limit = 50 } = {}) {
  const list = (await rows(env, `SELECT * FROM github_install_requests
    ORDER BY status = 'open' DESC, COALESCE(decided_at, requested_at) DESC LIMIT ?`, limit))
    .map(requestOf);
  const state = await appState(env, list.filter((r) => r.status === 'open').map((r) => r.account));
  return list.map((r) => withApp(r, state));
}

/** Request `id`, as the lists give it, or null. */
export async function getGithubRequest(env, id) {
  const r = await env.DB.prepare('SELECT * FROM github_install_requests WHERE id = ?')
    .bind(Number(id) || 0).first();
  if (!r) {
    return null;
  }
  const x = requestOf(r);
  return withApp(x, await appState(env, x.status === 'open' ? [x.account] : []));
}

/** How many wait for the admin team. */
export async function openGithubCount(env) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM github_install_requests
    WHERE status = 'open'`).first();
  return (row && row.n) || 0;
}

/**
 * Dismisses request `id` as `me`: not asked again for `days` (one of QUIET_CHOICES), with
 * `reason`. `{ ok }`, or `{ error, status }` when it is not open any more.
 */
export async function dismissGithubRequest(env, me, id, { days, reason } = {}) {
  const d = QUIET_CHOICES.includes(Number(days)) ? Number(days) : QUIET_DAYS;
  const at = new Date();
  const until = new Date(at.getTime() + d * DAY_MS).toISOString();
  const by = String(me.email || me.id);
  const why = clean(reason, 500) || null;
  const { meta } = await env.DB.prepare(`UPDATE github_install_requests SET status = 'dismissed',
      decided_by = ?, decided_at = ?, reason = ?, quiet_until = ? WHERE id = ? AND status = 'open'`)
    .bind(by, at.toISOString(), why, until, Number(id)).run();
  if (!meta.changes) {
    return { error: 'it is not waiting any more: installed, dismissed or withdrawn meanwhile', status: 409 };
  }
  console.log(JSON.stringify({
    route: 'githubrequests', request: 'dismissed', id: Number(id), by: me.id,
  }));
  await announceRequest(env, 'github', Number(id));
  return { ok: true, until };
}

/**
 * Allows installation `installation` of the app on request `id`'s account, as `me`, as the
 * admin team's tools and MCP servers do (PUT /api/kb/github/installation), which closes the
 * request. `{ ok }` or `{ error, status }`.
 */
export async function allowGithubInstallation(env, me, id, installation) {
  const app = await currentApp(env);
  if (!app) {
    return { error: 'there is no GitHub App yet', status: 409 };
  }
  forgetGithub();
  const done = await approveInstallation(env, app, installation, true, me.email || String(me.id));
  if (!done) {
    return { error: 'the app has no such installation any more', status: 404 };
  }
  console.log(JSON.stringify({
    route: 'githubrequests', github: 'installation allowed', installation: done.id, by: me.id,
  }));
  await closeInstalled(env, [done.account]);
  return { ok: true, id: Number(id) };
}

/**
 * What an agent that cannot read `owner`'s repositories is told of it, when `owner` is one of
 * Adobe's organizations: whether the admin team was asked to install the app there. '' for any
 * other account, or when it cannot tell.
 */
export async function adobeOrgHint(env, owner) {
  const account = String(owner || '').toLowerCase();
  if (!isAdobeOrg(env, account)) {
    return '';
  }
  const r = await env.DB.prepare(`SELECT status, quiet_until FROM github_install_requests
    WHERE account = ? ORDER BY requested_at DESC, id DESC LIMIT 1`).bind(account).first()
    .catch(() => null);
  if (r && r.status === 'open') {
    return ` ${account} is one of Adobe's GitHub organizations, and the admin team is asked to install the app there (a request in its inbox): say so where it matters, and do not ask again.`;
  }
  if (r && r.status === 'dismissed' && r.quiet_until > new Date().toISOString()) {
    return ` ${account} is one of Adobe's GitHub organizations; the admin team decided not to install the app there for now.`;
  }
  return ` ${account} is one of Adobe's GitHub organizations: the admin team installs the app there once enough threads name it.`;
}
