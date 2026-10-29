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

import assert from 'node:assert/strict';
import {
  afterEach, beforeEach, describe, it,
} from 'node:test';
import { render } from '../src/channels.js';
import {
  attachmentsOf, EXPORT_DELAY_SECONDS, exportThreads, queueExport, SWEEP_JOB, sweepExports,
  urgencyLevel,
} from '../src/clickhouse.js';
import { consume } from '../src/normalizer.js';
import { refile } from '../src/refile.js';
import { d1 } from './d1.js';
import { fakeBucket, quiet } from './fakes.js';

// Made-up ids, names, domains and texts only.
const KEY = 'slack:E1:C1:1.1';
const PATH = 'channels/acme/helix/slack-C1/1.1/';
const T0 = Date.UTC(2026, 9, 20, 10, 0, 0);
const iso = (minutes) => new Date(T0 + minutes * 60000).toISOString();
const NOW = T0 + 60 * 60000;
const DELETED = '_deleted';

// The contract's columns (the plan's table schema), in its order.
const COLUMNS = [
  'timestamp', 'source', 'thread', 'logical_thread', 'message_id', 'is_root', 'channel.key',
  'channel.name', 'channel.kind', 'team', 'teams', 'org.slug', 'org.name', 'org.type',
  'author.kind', 'author.relation', 'author.name', 'author.domain', 'author.ops_teams', 'edited',
  'reactions', 'mentions', 'attachments', 'thread.title', 'thread.root_at', 'thread.messages',
  'thread.resolved', 'thread.waiting_on', 'label.next_actor', 'label.kind', 'label.urgency', 'label.urgency_level',
  'label.resolved_p', 'label.model', 'facts_tickets', 'facts_sites', 'facts_cves', 'facts_urls',
  'facts_problems', 'url', '_version', '_deleted',
];

const CLICKHOUSE = {
  CLICKHOUSE_URL: 'https://clickhouse.example:8443',
  CLICKHOUSE_DATABASE: 'logs',
  CLICKHOUSE_USER: 'writer',
  CLICKHOUSE_PASSWORD: 'made-up-password',
  PUBLIC_ORIGIN: 'https://opspile.example/',
  STAFF_DOMAINS: 'staff.example',
};

function setup(extra = {}) {
  const env = {
    DB: d1({
      teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'sites', name: 'Sites' }],
      people: [
        {
          id: 7, email: 'ada@staff.example', name: 'Ada Staff', staff: 1, teams: ['helix', 'sites'],
        },
        { id: 8, email: 'cy@customer.example', name: 'Cy Customer' },
      ],
    }),
    CHANNELS: fakeBucket(),
    queued: [],
    ...CLICKHOUSE,
    ...extra,
  };
  env.NORMALIZE = {
    async send(body, options) {
      env.queued.push({ body, options });
    },
    async sendBatch(jobs) {
      env.queued.push(...jobs.map((j) => ({ body: j.body })));
    },
  };
  const sql = env.DB.sqlite;
  sql.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, email, person,
    fetched_at) VALUES ('slack', 'E1', ?, ?, ?, ?, ?, ?)`).run('U7', 'person', 'ada', 'ada@staff.example', 7, iso(0));
  sql.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, email, person,
    fetched_at) VALUES ('slack', 'E1', ?, ?, ?, ?, ?, ?)`).run('U8', 'person', 'cy', 'cy@customer.example', 8, iso(0));
  sql.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, email, fetched_at)
    VALUES ('slack', 'E1', 'U9', 'person', 'Pat Partner', 'pat@agency.example', ?)`).run(iso(0));
  sql.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, fetched_at)
    VALUES ('slack', 'E1', 'B1', 'bot', 'Deploy Bot', ?)`).run(iso(0));
  sql.prepare("INSERT INTO partner_domains (domain, name) VALUES ('agency.example', 'Agency')").run();
  sql.prepare(`INSERT INTO orgs (slug, name, type, updated_at)
    VALUES ('acme', 'Acme Corp', 'customer', ?)`).run(iso(0));
  sql.prepare(`INSERT INTO channel_teams (source, channel_id, team, added_at)
    VALUES ('slack', 'C1', 'sites', ?)`).run(iso(0));
  return env;
}

function thread(env, key = KEY, {
  root = '1.1', minutes = 0, kind = 'channel', logical = null, title = 'Cache purge fails',
} = {}) {
  env.DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org,
    team, kind, channel_name, title, path, root_at, any_at, messages, logical_thread, updated_at)
    VALUES (?, 'slack', 'E1', 'C1', ?, 'acme', 'helix', ?, 'aem-acme', ?, ?, ?, ?, 0, ?, ?)`)
    .run(
      key,
      root,
      kind,
      title,
      `channels/acme/helix/slack-C1/${root}/`,
      iso(minutes),
      iso(minutes),
      logical,
      iso(minutes),
    );
}

function message(env, id, minutes, {
  key = KEY, user = 'U8', person = 8, staff = 0, counted = 1, deleted = 0, kind = 'person',
  edited = 0, attachments = 0,
} = {}) {
  const sql = env.DB.sqlite;
  sql.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, author, person,
    staff, counted, deleted, author_key, author_kind, edited, attachments)
    VALUES ('slack', 'E1', 'C1', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      key,
      iso(minutes),
      person,
      staff,
      counted,
      deleted,
      user && `slack:E1:${user}`,
      kind,
      edited,
      attachments,
    );
  sql.prepare(`UPDATE threads SET any_at = MAX(any_at, ?2), updated_at = ?2,
    messages = (SELECT COUNT(*) FROM messages WHERE thread = ?1 AND deleted = 0),
    last_at = (SELECT MAX(at) FROM messages WHERE thread = ?1 AND counted = 1 AND deleted = 0),
    last_staff = (SELECT staff FROM messages WHERE thread = ?1 AND counted = 1 AND deleted = 0
      ORDER BY at DESC LIMIT 1) WHERE thread = ?1`)
    .run(key, iso(minutes));
}

function label(env, key, {
  nextActor = 'us', kind = 'incident', urgency = 2.4, resolvedP = 0.1, through = null,
  at = iso(30), title = 'Purge returns 403',
} = {}) {
  env.DB.sqlite.prepare(`INSERT INTO labels (thread, next_actor, kind, urgency, resolved_p,
    labeled_through, model, labeled_at, title) VALUES (?, ?, ?, ?, ?, ?, 'clef+clairic', ?, ?)
    ON CONFLICT (thread) DO UPDATE SET next_actor = excluded.next_actor, kind = excluded.kind,
      urgency = excluded.urgency, resolved_p = excluded.resolved_p,
      labeled_through = excluded.labeled_through, labeled_at = excluded.labeled_at,
      title = excluded.title`)
    .run(key, nextActor, kind, urgency, resolvedP, through || iso(10), at, title);
}

describe('klickhaus export', () => {
  const realFetch = globalThis.fetch;
  let posts;
  let status;
  beforeEach(() => {
    posts = [];
    status = 200;
    globalThis.fetch = async (url, init) => {
      posts.push({ url: new URL(url), init });
      return new Response(status === 200 ? '' : 'Code: 60. DB::Exception: Table logs.x does not exist. (UNKNOWN_TABLE) row: secret words', { status });
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const rowsOf = (post) => post.init.body.trim().split('\n').map((l) => JSON.parse(l));

  it('writes one row per message with the contract\'s columns, and moves the watermark', async () => {
    const env = setup();
    thread(env);
    message(env, '1.1', 0, { attachments: 2 });
    message(env, '1.2', 5, {
      user: 'U7', person: 7, staff: 1, edited: 1,
    });
    message(env, '1.3', 6, { user: 'U9', person: null });
    message(env, '1.4', 7, {
      user: 'B1', person: null, counted: 0, kind: 'bot',
    });
    message(env, '1.5', 8, { deleted: 1 });
    label(env, KEY);
    const sql = env.DB.sqlite;
    sql.prepare(`INSERT INTO facts (thread, source, field, value) VALUES
      (?1, 'rule', 'ticket', 'OPS-12'), (?1, 'rule', 'site', 'acme/site'),
      (?1, 'rule', 'cve', 'CVE-2026-1234'), (?1, 'rule', 'url', 'https://acme.example/a'),
      (?1, 'clairic', 'affected_url', 'https://acme.example/b'), (?1, 'clairic', 'problem', 'purge fails'),
      (?1, 'rule', 'repo', 'acme/site')`).run(KEY);
    sql.prepare(`INSERT INTO reactions (message, thread, emoji, user_key, at) VALUES
      ('slack:E1:C1:1.2', ?1, 'eyes', 'slack:E1:U8', ?2),
      ('slack:E1:C1:1.2', ?1, '+1', 'slack:E1:U9', ?2)`).run(KEY, iso(9));
    sql.prepare(`INSERT INTO mentions (thread, message, person, at, via)
      VALUES (?, 'slack:E1:C1:1.1', 7, ?, 'id')`).run(KEY, iso(0));

    const r = await exportThreads(env, KEY, { now: NOW });
    assert.deepEqual(r, { result: 'exported', threads: 1, rows: 5 });
    assert.equal(posts.length, 1);
    const [{ url, init }] = posts;
    assert.equal(url.origin, 'https://clickhouse.example:8443');
    assert.equal(url.searchParams.get('query'), 'INSERT INTO logs.opspile_messages_raw FORMAT JSONEachRow');
    assert.equal(url.searchParams.get('async_insert'), '1');
    assert.equal(url.searchParams.get('wait_for_async_insert'), '1');
    assert.equal(init.method, 'POST');
    // Credentials in headers, never in the URL.
    assert.equal(init.headers['x-clickhouse-user'], 'writer');
    assert.equal(init.headers['x-clickhouse-key'], 'made-up-password');
    assert.doesNotMatch(url.href, /made-up-password/);

    const rows = rowsOf(posts[0]);
    rows.forEach((row) => assert.deepEqual(Object.keys(row).sort(), [...COLUMNS].sort()));
    const [root, staff, partner, bot, gone] = rows;
    assert.deepEqual(root, {
      timestamp: iso(0),
      source: 'slack',
      thread: KEY,
      logical_thread: '',
      message_id: '1.1',
      is_root: 1,
      'channel.key': 'slack:E1:C1',
      'channel.name': 'aem-acme',
      'channel.kind': 'channel',
      team: 'helix',
      teams: ['helix', 'sites'],
      'org.slug': 'acme',
      'org.name': 'Acme Corp',
      'org.type': 'customer',
      'author.kind': 'person',
      'author.relation': 'customer',
      'author.name': 'Cy Customer',
      'author.domain': 'customer.example',
      'author.ops_teams': [],
      edited: 0,
      reactions: 0,
      mentions: 1,
      attachments: 2,
      'thread.title': 'Purge returns 403',
      'thread.root_at': iso(0),
      'thread.messages': 4,
      'thread.resolved': 0,
      // The partner posted last and Clef says us.
      'thread.waiting_on': 'us',
      'label.next_actor': 'us',
      'label.kind': 'incident',
      'label.urgency': 2.4,
      'label.urgency_level': 'high',
      'label.resolved_p': 0.1,
      'label.model': 'clef+clairic',
      facts_tickets: ['OPS-12'],
      facts_sites: ['acme/site'],
      facts_cves: ['CVE-2026-1234'],
      facts_urls: ['https://acme.example/b', 'https://acme.example/a'],
      facts_problems: ['purge fails'],
      url: `https://opspile.example/inbox?view=personal&t=${encodeURIComponent(KEY)}`,
      _version: NOW,
      _deleted: 0,
    });
    assert.equal(staff['author.relation'], 'adobe');
    assert.equal(staff['author.name'], 'Ada Staff');
    assert.deepEqual(staff['author.ops_teams'], ['helix', 'sites']);
    assert.equal(staff.edited, 1);
    assert.equal(staff.reactions, 2);
    assert.equal(staff.is_root, 0);
    assert.equal(partner['author.relation'], 'partner');
    assert.equal(partner['author.domain'], 'agency.example');
    assert.equal(bot['author.kind'], 'bot');
    assert.equal(bot['author.relation'], 'bot');
    assert.equal(bot['author.name'], 'Deploy Bot');
    // A deleted message is a tombstone with the same key.
    assert.equal(gone[DELETED], 1);
    assert.equal(gone.message_id, '1.5');
    assert.equal(gone.timestamp, iso(8));

    assert.deepEqual(env.DB.rows('SELECT exported_through, exported_at FROM threads'), [
      { exported_through: iso(8), exported_at: new Date(NOW).toISOString() },
    ]);
  });

  it('says resolved as the inbox does: a staff ✅ on the root, reopened by the customer', async () => {
    const env = setup();
    thread(env);
    message(env, '1.1', 0);
    label(env, KEY, { resolvedP: 0.2, through: iso(0) });
    env.DB.sqlite.prepare(`INSERT INTO reactions (message, thread, emoji, user_key, at)
      VALUES ('slack:E1:C1:1.1', ?, 'white_check_mark', 'slack:E1:U7', ?)`).run(KEY, iso(3));
    await exportThreads(env, KEY, { now: NOW });
    assert.equal(rowsOf(posts[0])[0]['thread.resolved'], 1);

    // The customer writes again: open until Clef has read that message.
    message(env, '1.2', 5);
    await exportThreads(env, KEY, { now: NOW + 1 });
    assert.deepEqual(rowsOf(posts[1]).map((r) => r['thread.resolved']), [0, 0]);

    // Clef read it and says resolved.
    label(env, KEY, { resolvedP: 0.9, through: iso(5) });
    await exportThreads(env, KEY, { now: NOW + 2 });
    assert.deepEqual(rowsOf(posts[2]).map((r) => r['thread.resolved']), [1, 1]);
  });

  it('says who a thread waits on as the inbox does', async () => {
    const env = setup();
    thread(env);
    message(env, '1.1', 0);
    const waiting = async (n) => {
      await exportThreads(env, KEY, { now: NOW + n });
      return rowsOf(posts[n])[0]['thread.waiting_on'];
    };
    // Unlabeled, the customer posted last: us.
    assert.equal(await waiting(0), 'us');
    // Adobe posted last: never us, whatever Clef says.
    message(env, '1.2', 5, { user: 'U7', person: 7, staff: 1 });
    label(env, KEY, { nextActor: 'us' });
    assert.equal(await waiting(1), 'nobody');
    label(env, KEY, { nextActor: 'customer' });
    assert.equal(await waiting(2), 'customer');
    // 🙏 after the last message: nothing is pending.
    env.DB.sqlite.prepare(`INSERT INTO reactions (message, thread, emoji, user_key, at)
      VALUES ('slack:E1:C1:1.2', ?, 'pray', 'slack:E1:U8', ?)`).run(KEY, iso(6));
    assert.equal(await waiting(3), 'nobody');
  });

  it('exports a re-threaded group as the inbox shows it', async () => {
    const env = setup();
    const LATER = 'slack:E1:C1:2.1';
    thread(env);
    thread(env, LATER, { root: '2.1', minutes: 20, logical: KEY });
    message(env, '1.1', 0);
    message(env, '2.1', 20, { key: LATER });
    label(env, KEY, { kind: 'question', urgency: 0.4, title: 'First title' });
    label(env, LATER, { kind: 'incident', urgency: 3, title: 'Later title' });
    env.DB.sqlite.prepare(`INSERT INTO facts (thread, source, field, value)
      VALUES (?, 'rule', 'ticket', 'OPS-1'), (?, 'rule', 'ticket', 'OPS-2')`).run(KEY, LATER);

    // Exporting one member exports the group.
    const r = await exportThreads(env, LATER, { now: NOW });
    assert.equal(r.threads, 2);
    const rows = rowsOf(posts[0]);
    assert.deepEqual(rows.map((x) => [x.thread, x.logical_thread]), [[KEY, ''], [LATER, KEY]]);
    for (const row of rows) {
      // The first thread's title, the latest member's label, every member's facts.
      assert.equal(row['thread.title'], 'First title');
      assert.equal(row['label.kind'], 'incident');
      assert.equal(row['label.urgency_level'], 'critical');
      assert.deepEqual(row.facts_tickets, ['OPS-1', 'OPS-2']);
      assert.equal(row.is_root, 1);
      assert.equal(row['thread.messages'], 1);
      assert.equal(row['thread.waiting_on'], 'us');
    }
    assert.equal(rows[1].url, `https://opspile.example/inbox?view=personal&t=${encodeURIComponent(LATER)}`);
    assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM threads WHERE exported_at IS NOT NULL')[0].n, 2);
  });

  it('takes a reviewer\'s answer over Clef\'s, and says alert for alert channels', async () => {
    const env = setup();
    const ALERT = 'slack:E1:C1:3.1';
    thread(env);
    thread(env, ALERT, { root: '3.1', kind: 'alert' });
    message(env, '1.1', 0);
    message(env, '3.1', 0, {
      key: ALERT, user: 'B1', person: null, counted: 0, kind: 'bot',
    });
    label(env, KEY, { urgency: 0.3 });
    env.DB.sqlite.prepare(`INSERT INTO label_reviews (thread, question, value, agrees,
      labeled_through, reviewer, created_at) VALUES (?, 'urgency', '3', 0, ?, 7, ?)`)
      .run(KEY, iso(10), iso(40));
    await exportThreads(env, [KEY, ALERT], { now: NOW });
    const rows = rowsOf(posts[0]);
    const byThread = Object.fromEntries(rows.map((x) => [x.thread, x]));
    assert.equal(byThread[KEY]['label.urgency'], 3);
    assert.equal(byThread[KEY]['label.urgency_level'], 'critical');
    assert.equal(byThread[ALERT]['label.kind'], 'alert');
    assert.equal(byThread[ALERT]['channel.kind'], 'alert');
    assert.equal(byThread[ALERT]['label.next_actor'], '');
    assert.equal(byThread[ALERT]['label.urgency_level'], 'low');
    assert.equal(byThread[ALERT]['thread.waiting_on'], 'nobody');
  });

  it('exports a thread re-filed as ignore as tombstones', async () => {
    const env = setup();
    thread(env, KEY, { kind: 'ignore' });
    message(env, '1.1', 0);
    await exportThreads(env, KEY, { now: NOW });
    assert.deepEqual(rowsOf(posts[0]).map((r) => r[DELETED]), [1]);
  });

  it('reads what only pile 2 knew once, for messages indexed before', async () => {
    const env = setup();
    thread(env);
    message(env, '1.1', 0);
    env.DB.sqlite.prepare(`UPDATE messages SET author_kind = NULL, edited = NULL,
      attachments = NULL`).run();
    await env.CHANNELS.put(`${PATH}1.1.md`, render({
      source: 'slack',
      thread: KEY,
      id: '1.1',
      at: iso(0),
      author: { kind: 'person', name: 'Cy', staff: false },
      editedAt: iso(2),
    }, [
      'See the screenshot',
      '![shot.png](https://files.slack.com/files-pri/T1-F1/shot.png)',
      '- [flow.pdf](https://acme-support.slack.com/files/U8/F2/flow.pdf)',
      '- [again](https://acme-support.slack.com/files/U8/F2/flow.pdf)',
      '- PDF file (shared from another workspace; opspile cannot see it)',
    ].join('\n')), { customMetadata: { version: '1', deleted: '0' } });
    await exportThreads(env, KEY, { now: NOW });
    const [row] = rowsOf(posts[0]);
    assert.equal(row.edited, 1);
    assert.equal(row.attachments, 3);
    assert.deepEqual(env.DB.rows('SELECT author_kind, edited, attachments FROM messages'), [
      { author_kind: 'person', edited: 1, attachments: 3 },
    ]);
  });

  it('leaves the watermark alone when ClickHouse refuses, and logs no data', async () => {
    const env = setup();
    thread(env);
    message(env, '1.1', 0);
    status = 404;
    await assert.rejects(exportThreads(env, KEY, { now: NOW }), (e) => {
      assert.equal(e.message, 'ClickHouse 404 code 60 UNKNOWN_TABLE');
      return true;
    });
    assert.deepEqual(env.DB.rows('SELECT exported_through, exported_at FROM threads'), [
      { exported_through: null, exported_at: null },
    ]);
  });

  it('exports a burst once: a job queued before the last export is done', async () => {
    const env = setup();
    thread(env);
    message(env, '1.1', 0);
    await exportThreads(env, KEY, { now: NOW });
    assert.deepEqual(await exportThreads(env, KEY, { at: NOW - 1000, now: NOW + 5000 }), {
      result: 'unchanged',
    });
    assert.equal(posts.length, 1);
    // Queued after it: exported again.
    assert.equal((await exportThreads(env, KEY, { at: NOW + 1000, now: NOW + 5000 })).result, 'exported');
    assert.equal(posts.length, 2);
  });

  it('is off without ClickHouse', async () => {
    const env = setup({ CLICKHOUSE_URL: undefined });
    thread(env);
    message(env, '1.1', 0);
    assert.deepEqual(await exportThreads(env, KEY), { result: 'skip', reason: 'no ClickHouse' });
    await queueExport(env, KEY);
    assert.deepEqual(await sweepExports(env), { skipped: 'no ClickHouse' });
    assert.equal(posts.length, 0);
    assert.deepEqual(env.queued, []);
  });

  it('queues an export after the label job', async () => {
    const env = setup();
    await queueExport(env, KEY);
    await queueExport(env, KEY, { delaySeconds: 0 });
    assert.equal(env.queued[0].body.export, KEY);
    assert.equal(typeof env.queued[0].body.at, 'number');
    assert.deepEqual(env.queued[0].options, { delaySeconds: EXPORT_DELAY_SECONDS });
    assert.equal(env.queued[1].options, undefined);
  });

  it('runs export jobs from the queue', async () => {
    const env = setup();
    thread(env);
    message(env, '1.1', 0);
    let acked = 0;
    await quiet(() => consume({
      messages: [{ body: { export: [KEY] }, ack: () => { acked += 1; }, retry: () => {} }],
    }, env));
    assert.equal(acked, 1);
    assert.equal(posts.length, 1);

    status = 500;
    let retried = 0;
    await quiet(() => consume({
      messages: [{ body: { export: KEY }, ack: () => {}, retry: () => { retried += 1; } }],
    }, env));
    assert.equal(retried, 1);
  });

  it('sweeps what changed since, the latest first, in jobs', async () => {
    const env = setup();
    const keys = Array.from({ length: SWEEP_JOB + 3 }, (_, i) => `slack:E1:C1:${i + 10}.1`);
    keys.forEach((k, i) => {
      thread(env, k, { root: `${i + 10}.1`, minutes: i });
      message(env, `${i + 10}.1`, i, { key: k });
    });
    // Too fresh: left for the online job.
    thread(env, 'slack:E1:C1:99.1', { root: '99.1', minutes: 58 });
    const now = new Date(NOW);
    const first = await sweepExports(env, now);
    assert.deepEqual(first, { queued: keys.length, jobs: 2 });
    assert.deepEqual(env.queued.flatMap((q) => q.body.export), [...keys].reverse());

    // All exported: nothing to do, until something changes.
    await exportThreads(env, keys, { now: NOW });
    env.queued.length = 0;
    assert.deepEqual(await sweepExports(env, now), { queued: 0, jobs: 0 });
    message(env, '10.2', 30, { key: keys[0] });
    label(env, keys[1], { at: iso(65) });
    env.DB.sqlite.prepare(`INSERT INTO label_reviews (thread, question, value, agrees,
      labeled_through, reviewer, created_at) VALUES (?, 'kind', 'question', 0, ?, 7, ?)`)
      .run(keys[2], iso(10), iso(61));
    env.DB.sqlite.prepare('UPDATE threads SET rethreaded_at = ? WHERE thread = ?').run(iso(62), keys[3]);
    env.DB.sqlite.prepare('UPDATE threads SET exported_through = NULL WHERE thread = ?').run(keys[4]);
    await sweepExports(env, now);
    assert.deepEqual(env.queued.flatMap((q) => q.body.export).sort(), keys.slice(0, 5).sort());
  });

  it('exports re-filed threads again, and clears their watermark for the sweep', async () => {
    const env = setup();
    env.DB.sqlite.prepare(`INSERT INTO rules (id, target, priority, source, field, pattern, value)
      VALUES (1, 'team', 100, NULL, 'name', '^aem-', 'sites'),
        (2, 'org', 100, NULL, 'name', '^aem-(.+)$', '$1')`).run();
    env.DB.sqlite.prepare(`INSERT INTO channels (source, tenant, channel_id, name, fetched_at)
      VALUES ('slack', 'E1', 'C1', 'aem-acme', ?)`).run(iso(0));
    thread(env);
    message(env, '1.1', 0);
    await exportThreads(env, KEY, { now: NOW });
    await refile(env, {
      source: 'slack', tenant: 'E1', channelId: 'C1', threads: [[KEY, PATH]],
    });
    assert.deepEqual(env.DB.rows('SELECT team, exported_through FROM threads'), [
      { team: 'sites', exported_through: null },
    ]);
    assert.deepEqual(env.queued.map((q) => q.body), [{ export: [KEY] }]);
    await exportThreads(env, [KEY], { now: NOW + 1 });
    assert.equal(rowsOf(posts[1])[0].team, 'sites');
  });

  it('counts files and buckets urgency as the inbox does', () => {
    assert.equal(attachmentsOf('no files, just https://example.com/x'), 0);
    assert.equal(attachmentsOf('> [Someone](https://acme.slack.com/archives/C1/p1 "Quoted message")\n> '
      + '![a](https://files.slack.com/files-pri/T1-F9/a.png)'), 0);
    assert.equal(urgencyLevel(null), 'low');
    assert.equal(urgencyLevel(0.4), 'low');
    assert.equal(urgencyLevel(1.5), 'high');
    assert.equal(urgencyLevel(9), 'critical');
  });
});
