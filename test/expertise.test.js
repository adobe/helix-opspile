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
import { beforeEach, describe, it } from 'node:test';
import {
  affinities, clearExperts, EXPERT_MIN, threadExperts,
} from '../src/expertise.js';
import { mentionable } from '../src/post.js';
import { threadVectorId } from '../src/vectors.js';
import { d1 } from './d1.js';

// Made-up ids, names and vectors only.
const THREAD = 'slack:E1:C1:1.1';
const match = (score, author, person = null) => ({ score, metadata: { author, person } });

function env({ embedded = 'h1', matches = [] } = {}) {
  const DB = d1({
    teams: [{ slug: 'helix', name: 'Helix' }],
    people: [{
      id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
    }],
  });
  DB.sqlite.prepare(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
    path, title, embedded, any_at, updated_at) VALUES (?, 'slack', 'E1', 'C1', '1.1', 'acme',
    'helix', 'p/', 'Redirect apex to www', ?, '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z')`)
    .run(THREAD, embedded);
  const calls = { getByIds: [], query: [], embed: [] };
  return {
    calls,
    DB,
    STAFF_DOMAINS: 'staff.example',
    AI: {
      async run(model, { text }) {
        calls.embed.push(text);
        return { data: text.map(() => [0, 1, 0]) };
      },
    },
    CONTENT: {
      async getByIds(ids) {
        calls.getByIds.push(ids);
        return embedded ? ids.map((id) => ({ id, values: new Float32Array([1, 0, 0]) })) : [];
      },
      async query(vector, options) {
        calls.query.push({ vector, options });
        return { matches };
      },
    },
  };
}

describe('expertise', () => {
  beforeEach(clearExperts);

  it('sums what each author\'s closest messages have over the weakest that counts', () => {
    const { authors, people } = affinities([
      match(0.9, 'slack:E1:U1', 7),
      match(0.85, 'slack:E1:U1', 7),
      match(0.8, 'teams:T:u2', 7),
      match(0.82, 'slack:E1:U2'),
      // Too far from the closest (0.9 - 0.15), and too far from the thread at all.
      match(0.74, 'slack:E1:U3'),
      match(0.5, 'slack:E1:U4'),
    ]);
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(near(authors.get('slack:E1:U1'), 0.15 + 0.1));
    assert.ok(near(authors.get('slack:E1:U2'), 0.07));
    assert.equal(authors.has('slack:E1:U3'), false);
    assert.equal(authors.has('slack:E1:U4'), false);
    // A person's messages on every platform count together.
    assert.ok(near(people.get(7), 0.15 + 0.1 + 0.05));
    // Nothing close enough: nobody.
    assert.equal(affinities([match(EXPERT_MIN - 0.01, 'slack:E1:U1')]).authors.size, 0);
  });

  it('leaves out the viewer, and counts the next one from the closest of the others', () => {
    const { authors } = affinities([
      match(0.95, 'slack:E1:U1', 1),
      match(0.8, 'slack:E1:U2', 2),
    ], { exclude: 1 });
    assert.deepEqual([...authors.keys()], ['slack:E1:U2']);
  });

  it('asks Vectorize with the thread\'s vector for staff messages, once per thread version', async () => {
    const e = env({ matches: [match(0.9, 'slack:E1:U2')] });
    const experts = await threadExperts(e, THREAD, { me: 1 });
    assert.equal(experts.authors.get('slack:E1:U2') > 0, true);
    assert.deepEqual(e.calls.getByIds, [[await threadVectorId(THREAD)]]);
    assert.deepEqual(e.calls.query[0].options.filter, { type: 'message', staff: true });
    assert.deepEqual(e.calls.embed, []);
    // Typing the next letter: the same answer, no new requests.
    assert.equal(await threadExperts(e, THREAD, { me: 1 }), experts);
    assert.equal(e.calls.query.length, 1);
    // A new version of the thread's vector asks again.
    e.DB.sqlite.prepare('UPDATE threads SET embedded = ? WHERE thread = ?').run('h2', THREAD);
    await threadExperts(e, THREAD, { me: 1 });
    assert.equal(e.calls.query.length, 2);
  });

  it('goes by the title while the thread has no vector yet, and by nothing without the index', async () => {
    const e = env({ embedded: null, matches: [match(0.9, 'slack:E1:U2')] });
    assert.equal((await threadExperts(e, THREAD)).authors.size, 1);
    assert.deepEqual(e.calls.embed, [['Redirect apex to www']]);
    assert.deepEqual(e.calls.query[0].vector, [0, 1, 0]);
    assert.equal(await threadExperts({ ...e, CONTENT: undefined }, THREAD), null);
    assert.equal(await threadExperts(e, 'slack:E1:C1:9.9'), null);
  });

  it('suggests nothing different when Vectorize fails', async () => {
    const e = env();
    e.CONTENT.query = async () => {
      throw new Error('down');
    };
    assert.equal(await threadExperts(e, THREAD), null);
  });

  it('puts the colleagues who know the topic after the customers in the thread', async () => {
    const e = env({
      matches: [
        match(0.9, 'slack:E1:U12'),
        match(0.8, 'teams:T:u-11', 11),
        // The viewer's own messages make nobody an expert.
        match(0.95, 'slack:E1:U1', 1),
        // Customers are ranked by where they posted, not by what.
        match(0.9, 'slack:E1:U20'),
      ],
    });
    const add = (id, name, { staff = false, person = null } = {}) => e.DB.sqlite.prepare(`INSERT INTO
      identities (source, tenant, user_id, kind, name, staff, person, fetched_at) VALUES ('slack',
      'E1', ?, 'person', ?, ?, ?, '2026-10-21T10:00:00Z')`).run(id, name, staff ? 1 : null, person);
    e.DB.sqlite.prepare(`INSERT INTO people (id, email, name, staff)
      VALUES (11, 'bo@staff.example', 'Bo Staff', 1)`).run();
    add('U1', 'Ada', { staff: true, person: 1 });
    add('U10', 'Al Staff', { staff: true });
    add('U11', 'Bo Staff', { staff: true, person: 11 });
    add('U12', 'Cy Staff', { staff: true });
    add('U20', 'Di Cust');
    add('U21', 'Ed Cust');
    e.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, author_key)
      VALUES ('slack', 'E1', 'C1', '1.2', ?, '2026-10-21T10:00:00Z', 'slack:E1:U21')`).run(THREAD);
    const inTeam = (t) => [].concat(t).includes('helix');
    const me = { id: 1 };
    const { people } = await (await mentionable(e, THREAD, '', inTeam, { me })).json();
    assert.deepEqual(people.map((p) => [p.name, Boolean(p.expert)]), [
      ['Ed Cust', false], ['Cy Staff', true], ['Bo Staff', true],
      ['Ada', false], ['Al Staff', false], ['Di Cust', false],
    ]);
    // Without a viewer (the MCP tools look up names), no vectors are asked.
    e.calls.query.length = 0;
    await mentionable(e, THREAD, 'cy', inTeam);
    assert.equal(e.calls.query.length, 0);
  });
});
