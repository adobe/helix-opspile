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

import { domainList, isStaffDomain } from './lookup.js';

/**
 * Keeps the Cloudflare Access policy of the inbox in step with the ops teams: whoever is a
 * member of a team (and staff, with a staff mail domain) may sign in, with any of the login
 * methods; nobody else. The policy's email includes are the list; other includes (groups,
 * domains) are left alone.
 *
 * No-team mode: with SIGNIN_DOMAINS, anyone with an email at one of those domains may sign in
 * too, so the policy also gets an email-domain include for each of them (added when missing,
 * never taken off: unsetting SIGNIN_DOMAINS leaves them for an admin to remove in Access).
 *
 * Runs after every membership change in the admin pages and on the cron. Needs the secret
 * ACCESS_API_TOKEN (Access: Apps and Policies Write) and the vars ACCESS_ACCOUNT_ID,
 * ACCESS_APP_ID and ACCESS_POLICY_ID; without them it does nothing.
 */

const API = 'https://api.cloudflare.com/client/v4';

export const accessSyncConfigured = (env) => Boolean(env.ACCESS_API_TOKEN && env.ACCESS_ACCOUNT_ID
  && env.ACCESS_APP_ID && env.ACCESS_POLICY_ID);

/** The emails that should be allowed: staff members of any ops team, lower case, sorted. */
export async function memberEmails(env) {
  const { results } = await env.DB.prepare(`SELECT DISTINCT LOWER(p.email) AS email
    FROM people p JOIN team_members m ON m.person = p.id
    WHERE p.staff = 1 AND p.email IS NOT NULL`).all();
  return (results || []).map((r) => r.email).filter((e) => isStaffDomain(env, e)).sort();
}

/**
 * The policy with its email includes replaced by `emails`, and an email-domain include for
 * each of `domains` it lacks, and what changed. Other includes stay as they are.
 */
export function withEmails(policy, emails, domains = []) {
  const include = policy.include || [];
  const before = new Set(include.filter((i) => i.email)
    .map((i) => String(i.email.email).toLowerCase()));
  const after = new Set(emails);
  const added = [...after].filter((e) => !before.has(e));
  const removed = [...before].filter((e) => !after.has(e));
  const had = new Set(include.filter((i) => i.email_domain)
    .map((i) => String(i.email_domain.domain).toLowerCase()));
  const domainsAdded = [...new Set(domains)].filter((d) => !had.has(d));
  return {
    added,
    removed,
    domainsAdded,
    body: {
      name: policy.name,
      decision: policy.decision,
      include: [
        ...include.filter((i) => !i.email),
        ...domainsAdded.map((domain) => ({ email_domain: { domain } })),
        ...[...after].map((email) => ({ email: { email } })),
      ],
      exclude: policy.exclude || [],
      require: policy.require || [],
      ...(policy.precedence != null ? { precedence: policy.precedence } : {}),
      ...(policy.session_duration ? { session_duration: policy.session_duration } : {}),
    },
  };
}

/**
 * Brings the policy in line with the teams. Returns `{ added, removed }` counts (no emails:
 * they go to logs), `{ skipped }` when not configured, or throws on an API error.
 */
export async function syncAccess(env, { fetchImpl = fetch } = {}) {
  if (!accessSyncConfigured(env)) {
    return { skipped: 'not configured' };
  }
  const emails = await memberEmails(env);
  const domains = domainList(env.SIGNIN_DOMAINS);
  // An empty list would lock everyone out: rather keep the policy as it is.
  if (!emails.length && !domains.length) {
    return { skipped: 'no members' };
  }
  const url = `${API}/accounts/${env.ACCESS_ACCOUNT_ID}/access/apps/${env.ACCESS_APP_ID}`
    + `/policies/${env.ACCESS_POLICY_ID}`;
  const headers = { authorization: `Bearer ${env.ACCESS_API_TOKEN}`, 'content-type': 'application/json' };
  const got = await (await fetchImpl(url, { headers })).json();
  if (!got.success) {
    throw new Error(`access policy: ${JSON.stringify(got.errors || []).slice(0, 200)}`);
  }
  const {
    added, removed, domainsAdded, body,
  } = withEmails(got.result, emails, domains);
  const counts = {
    added: added.length,
    removed: removed.length,
    ...(domains.length ? { domainsAdded: domainsAdded.length } : {}),
  };
  if (!added.length && !removed.length && !domainsAdded.length) {
    return counts;
  }
  const put = await (await fetchImpl(url, { method: 'PUT', headers, body: JSON.stringify(body) })).json();
  if (!put.success) {
    throw new Error(`access policy: ${JSON.stringify(put.errors || []).slice(0, 200)}`);
  }
  return counts;
}

/** syncAccess for request handlers: never throws, logs counts only. */
export async function syncAccessQuietly(env, why) {
  try {
    const r = await syncAccess(env);
    console.log(JSON.stringify({ route: 'access-sync', why, ...r }));
    return r;
  } catch (e) {
    console.error(JSON.stringify({ route: 'access-sync', why, error: e.message }));
    return { error: e.message };
  }
}
