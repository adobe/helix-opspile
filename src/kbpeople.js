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

import { entryOf } from './drafts.js';
import { json } from './http.js';
import { repoName } from './kb.js';
import { access } from './kbaccess.js';
import { listFiles, readBlobs } from './agent/repos.js';
import {
  CONTACTS, personSlug, RESERVED, scalar, splitFrontmatter, strings,
} from './agent/okf.js';

/**
 * A person in the knowledge bases, for the inbox's profile card (`GET /api/person`): their
 * Contact (`contacts/<first-last>.md`, docs/ARCHITECTURE.md "Layout") in the knowledge bases of
 * a thread, its customer's first, then its teams'. Found by the address in `resource`, else
 * by a name they go by (the platform's name, handle and display names, the Contact's title and
 * `aliases`), compared as `personSlug` makes them. Only the knowledge bases the viewer may read
 * (src/kbaccess.js) are looked in, and the address never leaves the Worker.
 */

const MAX_CONTACTS = 200;
const MAX_BLOBS = 50;
const MAX_KBS = 4;

// Parsed Contacts by blob hash: a blob never changes, so they are read once per isolate.
const parsed = new Map();
const MAX_PARSED = 4000;

/** A Contact's fields that find and show it, or null for any other concept. */
export function parseContact(path, text) {
  const fm = splitFrontmatter(text);
  if (!fm || String(scalar(fm.yaml, 'type') || '').toLowerCase() !== 'contact') {
    return null;
  }
  const resource = scalar(fm.yaml, 'resource') || '';
  const mail = /^mailto:(.+)$/i.exec(resource.trim());
  return {
    path,
    title: scalar(fm.yaml, 'title') || null,
    description: scalar(fm.yaml, 'description') || null,
    aliases: strings(fm.yaml, 'aliases'),
    email: mail ? mail[1].trim().toLowerCase() : null,
    status: scalar(fm.yaml, 'status') || null,
    staleAfter: scalar(fm.yaml, 'stale_after') || null,
  };
}

/**
 * The Contact of the person `who` (`{ email, names }`) among `contacts`, or null: the one with
 * their address, else the one whose file name, title or aliases are one of their names.
 */
export function matchContact(contacts, { email, names = [] }) {
  const mail = String(email || '').toLowerCase();
  if (mail) {
    const hit = contacts.find((c) => c.email === mail);
    if (hit) {
      return hit;
    }
  }
  const wanted = new Set(names.map(personSlug).filter(Boolean));
  if (!wanted.size) {
    return null;
  }
  const slugsOf = (c) => [
    c.path.split('/').pop().replace(/\.md$/, ''), c.title, ...c.aliases,
  ].map(personSlug);
  return contacts.find((c) => slugsOf(c).some((s) => wanted.has(s))) || null;
}

/** The Contacts of one knowledge base (`reader`: `{ list(artifact), blobs(artifact, hashes) }`). */
async function contactsOf(reader, artifact) {
  const files = (await reader.list(artifact))
    .filter((f) => f.path.endsWith('.md') && !RESERVED.has(f.path.split('/').pop()))
    .slice(0, MAX_CONTACTS);
  const missing = files.filter((f) => !parsed.has(f.hash)).map((f) => f.hash);
  for (let i = 0; i < missing.length; i += MAX_BLOBS) {
    const part = missing.slice(i, i + MAX_BLOBS);
    // eslint-disable-next-line no-await-in-loop
    const texts = await reader.blobs(artifact, part);
    for (const f of files.filter((x) => part.includes(x.hash))) {
      if (texts[f.hash] !== undefined) {
        parsed.set(f.hash, parseContact(f.path, texts[f.hash]));
      }
    }
  }
  while (parsed.size > MAX_PARSED) {
    parsed.delete(parsed.keys().next().value);
  }
  // The same blob may be at another path (moved, or in another knowledge base): the listing's.
  return files.flatMap((f) => {
    const c = parsed.get(f.hash);
    return c ? [{ ...c, path: f.path }] : [];
  });
}

/**
 * The person's Contact in each of `kbs` (`{ repo, kind, slug, name }`, in order), as the card
 * shows them. A knowledge base that cannot be read is left out.
 */
export async function findPerson(reader, kbs, who, now = new Date()) {
  const found = await Promise.all(kbs.map(async (kb) => {
    try {
      const hit = matchContact(await contactsOf(reader, kb.repo), who);
      if (!hit) {
        return null;
      }
      const stale = Boolean(hit.staleAfter) && Date.parse(hit.staleAfter) <= now.getTime();
      return {
        repo: kb.repo,
        kind: kb.kind,
        name: kb.name,
        path: hit.path,
        title: hit.title,
        description: hit.description,
        status: hit.status || 'stable',
        stale,
      };
    } catch (e) {
      console.error(JSON.stringify({ route: 'person', repo: kb.repo, error: e.message }));
      return null;
    }
  }));
  return found.filter(Boolean);
}

/** The Worker's reader: `contacts/` of an Artifacts repo, and its blobs. */
export const artifactsReader = (env) => ({
  async list(artifact) {
    const res = await listFiles(env, artifact, CONTACTS);
    return (res.entries || []).filter((e) => e.type !== 'tree')
      .map((e) => ({ path: e.path, hash: e.hash }));
  },
  blobs: (artifact, hashes) => readBlobs(env, artifact, hashes),
});

/**
 * Who an identity key (`<source>:<tenant>:<user id>`) is: their address and every name they
 * go by. Unknown keys are who `name` says.
 */
async function whoIs(env, key, name) {
  const [source, tenant, ...rest] = String(key || '').split(':');
  const row = key && rest.length ? await env.DB.prepare(`SELECT i.name, i.handle, i.aliases,
      COALESCE(i.email, p.email) AS email, p.name AS person_name, i.kind
    FROM identities i LEFT JOIN people p ON p.id = i.person
    WHERE i.source = ? AND i.tenant = ? AND i.user_id = ?`).bind(source, tenant, rest.join(':')).first()
    : null;
  let aliases = [];
  try {
    aliases = JSON.parse((row && row.aliases) || '[]');
  } catch {
    aliases = [];
  }
  const names = [row && row.person_name, row && row.name, row && row.handle, ...aliases, name]
    .filter((n) => typeof n === 'string' && n.trim());
  return {
    email: (row && row.email) || null, names: [...new Set(names)], bot: Boolean(row && row.kind === 'bot'),
  };
}

/**
 * The knowledge bases of thread `entry` (src/drafts.js `entryOf`) that `me` may read: its
 * customer's, then its own team's and those of the teams it is shared with, each with its name.
 */
async function kbsOf(env, me, entry) {
  const wanted = [
    { kind: 'org', slug: entry.org },
    ...[entry.team, ...(entry.teams || [])].map((slug) => ({ kind: 'team', slug })),
  ].map((k) => ({ ...k, repo: repoName(k.kind, k.slug) })).filter((k) => k.repo);
  const unique = [...new Map(wanted.map((k) => [k.repo, k])).values()].slice(0, MAX_KBS);
  if (!unique.length) {
    return [];
  }
  const [{ results: known }, may] = await Promise.all([
    env.DB.prepare(`SELECT k.repo, COALESCE(o.name, t.name) AS name FROM knowledge_bases k
      LEFT JOIN orgs o ON k.kind = 'org' AND o.slug = k.slug
      LEFT JOIN teams t ON k.kind = 'team' AND t.slug = k.slug
      WHERE k.repo IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(unique.map((k) => k.repo))).all(),
    access(env, me),
  ]);
  const names = new Map((known || []).map((r) => [r.repo, r.name]));
  return unique.filter((k) => names.has(k.repo) && may.read(k))
    .map((k) => ({ ...k, name: names.get(k.repo) || k.slug }));
}

/**
 * `GET /api/person?thread=&p=&name=`: the Contact of the person with identity key `p` (or,
 * without an account, named `name`) in the knowledge bases of the thread, for those who may
 * see the thread: `{ entries: [{ repo, kind, name, path, title, description, status, stale }] }`.
 */
export async function personInKb(env, me, { thread, key, name }, canSee) {
  const entry = thread ? await entryOf(env, thread) : null;
  if (!entry || !await canSee(entry.teams, entry)) {
    return json({ error: 'not found' }, 404);
  }
  if (!env.ARTIFACTS) {
    return json({ entries: [] });
  }
  const who = await whoIs(env, key, name);
  if (who.bot || (!who.email && !who.names.length)) {
    return json({ entries: [] });
  }
  const entries = await findPerson(artifactsReader(env), await kbsOf(env, me, entry), who);
  const res = json({ entries });
  res.headers.set('cache-control', 'private, max-age=120');
  return res;
}
