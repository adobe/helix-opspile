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
import { describe, it } from 'node:test';
import { slackMessageLinks, slackMessageLookupSql } from '../src/slacklinks.js';
import { slackMessageId, slackMessageKey, slackMessageRefs } from '../src/slackurl.js';
import { d1 } from './d1.js';

const url = (channel, id, { host = 'acme.enterprise.slack.com', root = null } = {}) => {
  const base = `https://${host}/archives/${channel}/p${String(id).replace('.', '')}`;
  return root && root !== id ? `${base}?thread_ts=${root}&cid=${channel}` : base;
};

describe('slack message permalinks', () => {
  it('reads a message id from the p segment, including an enterprise host', () => {
    assert.equal(slackMessageId('1793525659017469'), '1793525659.017469');
    assert.equal(slackMessageId('123456'), null);
    const link = url('C0AAAAAAAA1', '1700000000.000001', { root: '1700000000.000001' });
    assert.equal(slackMessageKey(link), 'C0AAAAAAAA1:1700000000.000001');
    assert.equal(slackMessageKey(link.replace('acme.enterprise.', '')), 'C0AAAAAAAA1:1700000000.000001');
    assert.equal(slackMessageKey('https://slack.example.com/archives/C0AAAAAAAA1/p1700000000000001'), null);
    assert.equal(slackMessageKey('https://slack.com/archives/C0AAAAAAAA1'), null);
  });

  it('finds permalinks outside code, once each', () => {
    const bare = url('C0AAAAAAAA1', '1700000000.000001');
    const reply = url('C0BBBBBBBB2', '1700000000.000002', { root: '1700000000.000001', host: 'slack.com' });
    assert.deepEqual(slackMessageRefs([
      `see ${bare} and ${bare} again`,
      `also ${reply}`,
      `not \`${bare}\` and\n\`\`\`\n${reply}\n\`\`\``,
      'https://slack.example.com/archives/C0AAAAAAAA1/p1700000000000001',
    ]), [
      { channel: 'C0AAAAAAAA1', id: '1700000000.000001' },
      { channel: 'C0BBBBBBBB2', id: '1700000000.000002' },
    ]);
    assert.deepEqual(slackMessageRefs([null, 'no link']), []);
  });
});

describe('slack message lookup', () => {
  const fresh = () => {
    const DB = d1({
      teams: [{ slug: 'ops', name: 'Ops' }, { slug: 'other', name: 'Other' }, { slug: 'admin', name: 'Admin' }],
      people: [{
        id: 1, email: 'a@staff.example', name: 'Ada', staff: 1, teams: ['ops'],
      }],
    });
    const thread = (channel, team, at) => DB.sqlite.prepare(`INSERT INTO threads (thread, source,
        tenant, channel_id, root_id, org, team, path, any_at, updated_at)
      VALUES (?, 'slack', 'E1', ?, '1700000000.000001', 'acme', ?, 'p', ?, ?)`)
      .run(`slack:E1:${channel}:1700000000.000001`, channel, team, at, at);
    thread('C0AAAAAAAA1', 'ops', '2026-10-02');
    thread('C0BBBBBBBB2', 'other', '2026-10-02');
    const message = (channel, id, extra = {}) => DB.sqlite.prepare(`INSERT INTO messages (source, tenant,
        channel_id, id, thread, at, author, author_key, preview, person, deleted)
      VALUES ('slack', 'E1', ?, ?, ?, '2026-10-21T11:43:20.000Z', ?, ?, ?, ?, ?)`)
      .run(channel, id, `slack:E1:${channel}:1700000000.000001`, extra.author ?? 'Sam', extra.authorKey ?? 'slack:E1:U1', extra.preview ?? 'Preview is down.', extra.person ?? null, extra.deleted ?? 0);
    message('C0AAAAAAAA1', '1700000000.000001');
    message('C0AAAAAAAA1', '1700000000.000003', { deleted: 1, preview: 'gone' });
    message('C0BBBBBBBB2', '1700000000.000002', { author: 'Hidden', preview: 'secret text', authorKey: 'slack:E1:U9' });
    return DB;
  };
  const me = { id: 1, teams: [{ slug: 'ops' }] };

  it('returns a message the viewer may see, and nothing they may not', async () => {
    const DB = fresh();
    const found = await slackMessageLinks({ DB }, me, [
      url('C0AAAAAAAA1', '1700000000.000001'),
      url('C0BBBBBBBB2', '1700000000.000002'),
      url('C0AAAAAAAA1', '1700000000.000003'),
      `code \`${url('C0AAAAAAAA1', '1700000000.000001')}\``,
    ], 'E1');
    assert.deepEqual(found, [{
      channel: 'C0AAAAAAAA1',
      id: '1700000000.000001',
      thread: 'slack:E1:C0AAAAAAAA1:1700000000.000001',
      at: '2026-10-21T11:43:20.000Z',
      author: 'Sam',
      authorKey: 'slack:E1:U1',
      preview: 'Preview is down.',
    }]);
  });

  it('does not pair a channel with another channel\'s message', async () => {
    const DB = fresh();
    const found = await slackMessageLinks({ DB }, me, [
      url('C0AAAAAAAA1', '1700000000.000002'),
      url('C0BBBBBBBB2', '1700000000.000001'),
    ], 'E1');
    assert.deepEqual(found, []);
  });

  it('includes a shared channel, a personal channel, and everything for an admin', async () => {
    const DB = fresh();
    DB.sqlite.prepare(`INSERT INTO channel_teams (source, channel_id, team, added_at)
      VALUES ('slack', 'C0BBBBBBBB2', 'ops', '2026-10-03')`).run();
    const shared = await slackMessageLinks({ DB }, me, [url('C0BBBBBBBB2', '1700000000.000002')], 'E1');
    assert.equal(shared[0]?.preview, 'secret text');
    DB.sqlite.prepare('DELETE FROM channel_teams').run();
    DB.sqlite.prepare(`UPDATE messages SET person = 1
      WHERE channel_id = 'C0BBBBBBBB2' AND id = '1700000000.000002'`).run();
    const personal = await slackMessageLinks({ DB }, me, [url('C0BBBBBBBB2', '1700000000.000002')], 'E1');
    assert.equal(personal.length, 1);
    DB.sqlite.prepare(`UPDATE messages SET person = NULL
      WHERE channel_id = 'C0BBBBBBBB2'`).run();
    const admin = await slackMessageLinks({ DB }, { id: 2, teams: [{ slug: 'admin' }] }, [
      url('C0BBBBBBBB2', '1700000000.000002'),
    ], 'E1');
    assert.equal(admin.length, 1);
    assert.deepEqual(await slackMessageLinks({ DB }, me, ['no links'], 'E1'), []);
    assert.deepEqual(await slackMessageLinks({ DB }, me, [
      url('C0AAAAAAAA1', '1700000000.000001'),
    ]), []);
  });

  it('stays inside the open thread\'s workspace, on the messages primary key', async () => {
    const DB = fresh();
    DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
        path, any_at, updated_at)
      VALUES ('slack:E2:C0AAAAAAAA1:1700000000.000001', 'slack', 'E2', 'C0AAAAAAAA1',
        '1700000000.000001', 'acme', 'ops', 'p', '2026-10-02', '2026-10-02')`).run();
    DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, author,
        author_key, preview)
      VALUES ('slack', 'E2', 'C0AAAAAAAA1', '1700000000.000001',
        'slack:E2:C0AAAAAAAA1:1700000000.000001', '2026-10-21T11:43:20.000Z', 'Other',
        'slack:E2:U2', 'other grid')`).run();
    const found = await slackMessageLinks({ DB }, me, [
      url('C0AAAAAAAA1', '1700000000.000001'),
    ], 'E1');
    assert.equal(found.length, 1);
    assert.equal(found[0].author, 'Sam');
    assert.equal(found[0].preview, 'Preview is down.');
    const plan = DB.sqlite.prepare(`EXPLAIN QUERY PLAN ${slackMessageLookupSql}`).all()
      .map((row) => row.detail).join('\n');
    assert.match(plan, /source=\? AND tenant=\? AND channel_id=\? AND id=\?/);
  });
});
