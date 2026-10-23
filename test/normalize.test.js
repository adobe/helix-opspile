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
import {
  channelPath, FORMAT, merge, parse, render,
} from '../src/channels.js';
import { htmlToMarkdown } from '../src/markdown.js';
import { normalize, slackVersion } from '../src/normalize.js';

// Made-up ids only.
const slack = (event, extra = {}) => ({
  type: 'event_callback', enterprise_id: 'E1', team_id: 'T1', event_id: 'Ev1', event, ...extra,
});
const SKEY = 'slack/E1/C1/2026/10/21/x.json';

describe('normalize (slack)', () => {
  it('turns a root message into an upsert', () => {
    const { op, message } = normalize(SKEY, slack({
      type: 'message', channel: 'C1', user: 'U1', ts: '1792584000.000100', text: 'hi',
    }));
    assert.equal(op, 'upsert');
    assert.equal(message.rootId, '1792584000.000100');
    assert.equal(message.thread, 'slack:E1:C1:1792584000.000100');
    assert.equal(message.at, '2026-10-21T12:00:00.000Z');
    assert.equal(message.permalink, 'https://slack.com/archives/C1/p1792584000000100');
    assert.deepEqual(message.authorRef, {
      source: 'slack', tenant: 'E1', userId: 'U1', home: undefined, bot: false,
    });
  });

  it('files a reply under its root', () => {
    const { message } = normalize(SKEY, slack({
      type: 'message', channel: 'C1', user: 'U1', ts: '1792584060.000200', thread_ts: '1792584000.000100',
    }));
    assert.equal(message.rootId, '1792584000.000100');
    assert.equal(message.id, '1792584060.000200');
    assert.match(message.permalink, /\?thread_ts=1792584000\.000100&cid=C1$/);
  });

  it('uses the new message and the edit time for message_changed', () => {
    const { op, message } = normalize(SKEY, slack({
      type: 'message',
      subtype: 'message_changed',
      channel: 'C1',
      event_ts: '1792584100.000000',
      message: {
        user: 'U1', ts: '1792584000.000100', text: 'fixed', edited: { ts: '1792584090.000000' },
      },
    }));
    assert.equal(op, 'upsert');
    assert.equal(message.text, 'fixed');
    assert.equal(message.editedAt, '2026-10-21T12:01:30.000Z');
    assert.equal(message.version, slackVersion('1792584090.000000'));
  });

  it('versions an unedited change (an unfurl) by the change itself', () => {
    const { message } = normalize(SKEY, slack({
      type: 'message',
      subtype: 'message_changed',
      channel: 'C1',
      event_ts: '1792584100.000000',
      message: { user: 'U1', ts: '1792584000.000100', text: 'same' },
    }));
    assert.equal(message.version, slackVersion('1792584100.000000'));
    assert.equal(message.editedAt, undefined);
  });

  it('turns message_deleted into a tombstone', () => {
    const { op, message } = normalize(SKEY, slack({
      type: 'message',
      subtype: 'message_deleted',
      channel: 'C1',
      deleted_ts: '1792584000.000100',
      event_ts: '1792584200.000000',
      previous_message: { user: 'U1', ts: '1792584000.000100', text: 'oops' },
    }));
    assert.equal(op, 'delete');
    assert.equal(message.id, '1792584000.000100');
    assert.equal(message.deletedAt, '2026-10-21T12:03:20.000Z');
  });

  it('marks bots and system messages', () => {
    const bot = normalize(SKEY, slack({
      type: 'message', subtype: 'bot_message', channel: 'C1', ts: '1.1', bot_id: 'B1', username: 'ci',
    }));
    assert.deepEqual(bot.message.authorRef, {
      kind: 'bot', name: 'ci', botId: 'B1', tenant: 'E1', teamId: 'T1',
    });
    const join = normalize(SKEY, slack({
      type: 'message', subtype: 'channel_join', channel: 'C1', ts: '1.2', user: 'U1',
    }));
    assert.equal(join.message.authorRef.kind, 'system');
  });

  it('skips reactions and records renames', () => {
    assert.equal(normalize(SKEY, slack({ type: 'reaction_added', item: { channel: 'C1' } })).op, 'skip');
    const r = normalize(SKEY, slack({ type: 'channel_rename', channel: { id: 'C1', name: 'new' } }));
    assert.deepEqual(r, {
      op: 'channel',
      channel: {
        source: 'slack', tenant: 'E1', channelId: 'C1', name: 'new',
      },
    });
  });

  it('keeps file links', () => {
    const { message } = normalize(SKEY, slack({
      type: 'message',
      subtype: 'file_share',
      channel: 'C1',
      user: 'U1',
      ts: '1.3',
      text: 'log',
      files: [{ name: 'a.txt', permalink: 'https://files.example/a' }],
    }));
    assert.match(message.text, /- \[a\.txt\]\(https:\/\/files\.example\/a\)$/);
  });

  it('gives Slack images their size, so the inbox can reserve the space', () => {
    const { message } = normalize(SKEY, slack({
      type: 'message',
      subtype: 'file_share',
      channel: 'C1',
      user: 'U1',
      ts: '1.4',
      text: '',
      files: [{
        name: 'shot.png', mimetype: 'image/png', url_private: 'https://files.example/shot.png', original_w: 1200, original_h: 800,
      }],
    }));
    assert.match(message.text, /!\[shot\.png\]\(https:\/\/files\.example\/shot\.png "1200x800"\)/);
  });
});

describe('normalize (teams)', () => {
  const TKEY = 'teams/tenant-1/team-1/19:c@thread.tacv2/2026/10/21/1-2.json';
  const msg = (extra = {}) => ({
    id: '1792584060000',
    replyToId: '1792584000000',
    messageType: 'message',
    createdDateTime: '2026-10-21T12:01:00Z',
    lastModifiedDateTime: '2026-10-21T12:02:00Z',
    channelIdentity: { teamId: 'team-1', channelId: '19:c@thread.tacv2' },
    from: { user: { id: 'u-1', displayName: 'Ada', tenantId: 'tenant-1' } },
    body: { contentType: 'html', content: '<p>hi</p>' },
    webUrl: 'https://teams.example/l/message/1',
    ...extra,
  });

  it('turns a reply into an upsert under its root', () => {
    const { op, message } = normalize(TKEY, msg());
    assert.equal(op, 'upsert');
    assert.equal(message.rootId, '1792584000000');
    assert.equal(message.thread, 'teams:tenant-1:team-1:19:c@thread.tacv2:1792584000000');
    assert.equal(message.format, 'html');
    assert.equal(message.authorRef.userId, 'u-1');
    assert.equal(message.permalink, 'https://teams.example/l/message/1');
  });

  it('lists file attachments as links, with spaces in their addresses encoded', () => {
    const attachments = [{
      contentType: 'reference',
      name: 'notes [v2].pdf',
      contentUrl: 'https://files.example/sites/x/Shared Documents/A B/notes [v2].pdf',
    }];
    const link = '- [notes \\[v2\\].pdf](https://files.example/sites/x/Shared%20Documents/A%20B/notes%20[v2].pdf)';
    const { message } = normalize(TKEY, msg({ attachments }));
    assert.equal(htmlToMarkdown(message.text), `hi\n\nAttachments:\n\n${link}`);
    const plain = normalize(TKEY, msg({ attachments, body: { contentType: 'text', content: 'hi' } }));
    assert.equal(plain.message.text, `hi\n\nAttachments:\n\n${link}`);
  });

  it('turns a soft-deleted message into a tombstone', () => {
    assert.equal(normalize(TKEY, msg({ deletedDateTime: '2026-10-21T12:05:00Z' })).op, 'delete');
  });

  it('skips notifications and marks bots', () => {
    assert.equal(normalize('teams/t/x/y/2026/10/21/notification-ab.json', {}).op, 'skip');
    const bot = normalize(TKEY, msg({ from: { application: { displayName: 'Alerts' } } }));
    assert.deepEqual(bot.message.authorRef, { kind: 'bot', name: 'Alerts' });
  });

  it('keeps a bot author\'s id, but not a webhook\'s', () => {
    const bot = normalize(TKEY, msg({
      from: { application: { id: 'b-1', displayName: 'helper-agent', applicationIdentityType: 'bot' } },
    }));
    assert.deepEqual(bot.message.authorRef, {
      kind: 'bot', name: 'helper-agent', source: 'teams', tenant: 'tenant-1', botId: 'b-1',
    });
    const hook = normalize(TKEY, msg({
      from: { application: { id: 'w-1', displayName: 'Hook', applicationIdentityType: 'webhook' } },
    }));
    assert.deepEqual(hook.message.authorRef, { kind: 'bot', name: 'Hook' });
  });

  it('lists the bots a message mentions, by the name it used', () => {
    const app = (id, type = 'bot') => ({
      application: { id, displayName: `${id}-long`, applicationIdentityType: type },
    });
    const { message } = normalize(TKEY, msg({
      mentions: [
        { id: 0, mentionText: 'helper', mentioned: app('b-1') },
        { id: 1, mentionText: 'helper', mentioned: app('b-1') },
        { id: 2, mentioned: app('b-2') },
        { id: 3, mentionText: 'Hook', mentioned: app('w-1', 'webhook') },
        { id: 4, mentionText: 'Ada', mentioned: { user: { id: 'u-1' } } },
      ],
    }));
    assert.deepEqual(message.botMentions, [
      { id: 'b-1', name: 'helper' }, { id: 'b-2', name: 'b-2-long' },
    ]);
    assert.deepEqual(message.mentionIds, ['u-1']);
  });
});

describe('pile-2 files', () => {
  it('builds the path', () => {
    assert.equal(
      channelPath({
        org: 'acme', team: 'helix', source: 'slack', channelId: 'C1', rootId: '1.1', id: '1.2',
      }),
      'channels/acme/helix/slack-C1/1.1/1.2.md',
    );
  });

  it('renders frontmatter that parses back', () => {
    const meta = {
      source: 'slack', id: '1.2', author: { kind: 'person', name: 'A: B', staff: true }, raw: ['k1'],
    };
    const text = render(meta, 'body\nline');
    assert.match(text, /^---\nsource: "slack"\nid: "1\.2"\nauthor: \{/);
    assert.deepEqual(parse(text), { meta, body: 'body\nline' });
  });

  const file = (version, extra = {}, body = 'b') => ({
    version, deleted: false, meta: { raw: [`k${version}`], at: `at${version}`, ...extra }, body,
  });

  it('writes a new file', () => {
    assert.deepEqual(merge(null, file('1')), file('1'));
  });

  it('moves forward to a newer version and keeps the original time', () => {
    const next = merge(file('1'), file('2', {}, 'new'));
    assert.equal(next.body, 'new');
    assert.equal(next.meta.at, 'at1');
    assert.deepEqual(next.meta.raw, ['k1', 'k2']);
  });

  it('never goes back to an older version, but records its raw key', () => {
    const next = merge(file('2', {}, 'new'), file('1', {}, 'old'));
    assert.equal(next.body, 'new');
    assert.deepEqual(next.meta.raw, ['k1', 'k2']);
  });

  it('does nothing for a replay of the same raw object', () => {
    assert.equal(merge(file('1'), file('1')), null);
  });

  it('rewrites the same version when a newer normalizer renders it differently, once', () => {
    const old = { ...file('1', {}, 'plain'), format: 1 };
    const now = { ...file('1', {}, 'with size'), format: FORMAT };
    assert.equal(merge(old, now).body, 'with size');
    assert.equal(merge({ ...now, format: FORMAT }, { ...file('1', {}, 'other'), format: FORMAT }), null);
    // An older format never wins.
    assert.equal(merge({ ...file('1', {}, 'with size'), format: FORMAT }, { ...file('1', {}, 'plain'), format: 1 }), null);
  });

  it('turns a file into a tombstone and keeps it one', () => {
    const del = { ...file('3', { deletedAt: 'd' }), deleted: true };
    const tomb = merge(file('1'), del);
    assert.equal(tomb.deleted, true);
    assert.equal(tomb.body, '');
    assert.equal(tomb.meta.deletedAt, 'd');
    const after = merge(tomb, file('4', {}, 'resurrected?'));
    assert.equal(after.deleted, true);
    assert.equal(after.body, '');
    assert.deepEqual(after.meta.raw, ['k1', 'k3', 'k4']);
  });

  it('writes a tombstone without body when the delete comes first', () => {
    const del = { ...file('3', { deletedAt: 'd' }), deleted: true };
    assert.equal(merge(null, del).body, '');
  });
});
