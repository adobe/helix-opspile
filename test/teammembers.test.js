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
import { MAX_LISTED, teamMembers, teamMembersText } from '../src/agent/teammembers.js';
import { opspileExtension } from '../src/agent/tools.js';
import { d1 } from './d1.js';

// Made-up people and teams only.
const NOW = new Date('2026-11-25T12:00:00Z');

function seed() {
  const DB = d1({
    teams: [{ slug: 'edge', name: 'Edge ops' }],
    people: [
      {
        id: 1, email: 'ada@staff.example', name: 'Ada Ops', staff: 1, teams: ['edge'],
      },
      {
        id: 2, email: 'bo@staff.example', name: 'bo', staff: 1, teams: ['edge'],
      },
      {
        id: 3, email: 'cy@staff.example', name: 'Cy Quiet', staff: 1, teams: ['edge'],
      },
    ],
  });
  DB.sqlite.exec(`UPDATE team_members SET role = 'manager' WHERE person = 1;
    INSERT INTO identities (source, tenant, user_id, kind, name, person, fetched_at)
      VALUES ('slack', 'T', 'U2', 'person', 'Bo Builder', 2, '2026-11-01T00:00:00Z');
    INSERT INTO kb_concepts (repo, path, hash, type, title) VALUES
      ('kb-team-edge', 'contacts/ada-ops.md', 'h', 'Contact', 'Ada Ops')`);
  const msg = DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at,
    person, staff, counted) VALUES ('slack', 'T', 'C', ?, 't', ?, ?, 1, 1)`);
  ['a', 'b'].forEach((id) => msg.run(`m${id}`, '2026-11-20T00:00:00Z', 2));
  msg.run('m1', '2026-11-20T00:00:00Z', 1);
  // Too old to count.
  msg.run('m0', '2026-01-01T00:00:00Z', 3);
  return { DB };
}

describe('the team\'s members, for its agent', () => {
  it('are listed busiest first, each with the path of their profile in kb-team', async () => {
    const members = await teamMembers(seed(), 'edge', { now: NOW });
    assert.deepEqual(members.map((m) => [m.name, m.role, m.path, m.has, m.messages]), [
      ['Bo Builder', 'member', 'contacts/bo-builder.md', false, 2],
      ['Ada Ops', 'manager', 'contacts/ada-ops.md', true, 1],
      ['Cy Quiet', 'member', 'contacts/cy-quiet.md', false, 0],
    ]);
    assert.equal(teamMembersText(members), [
      'Your ops team\'s members, the busiest first. Each has a Contact in kb-team, their profile on the team; 2 of these have none yet.',
      '- Bo Builder: kb-team contacts/bo-builder.md, not written yet',
      '- Ada Ops (manager): kb-team contacts/ada-ops.md',
      '- Cy Quiet: kb-team contacts/cy-quiet.md, not written yet',
    ].join('\n'));
    assert.deepEqual(await teamMembers(seed(), null), []);
    assert.equal(teamMembersText([]), '');
  });

  it('are at most MAX_LISTED in the prompt, which says how many there are', () => {
    const many = Array.from({ length: MAX_LISTED + 5 }, (_, i) => ({
      name: `P ${i}`, role: 'member', path: `contacts/p-${i}.md`, has: true, messages: 0,
    }));
    const text = teamMembersText(many);
    assert.match(text, new RegExp(`^Your ops team's members, the busiest first \\(${MAX_LISTED} of ${MAX_LISTED + 5}\\)\\. .*every one of these has one\\.`));
    assert.equal(text.split('\n').length, MAX_LISTED + 1);
  });

  it('are in every agent\'s prompt, with how to keep their profiles', async () => {
    const e = seed();
    const ext = opspileExtension({
      env: e, hasThread: false, target: async () => ({ team: 'edge' }), verdicts: async () => new Map(),
    });
    const render = (key) => ext.sections.find((s) => s.key === key).render({});
    assert.match(await render('team-members'), /^Your ops team's members/);
    const all = (await Promise.all(ext.sections.map((s) => Promise.resolve(s.render({})).catch(() => ''))))
      .filter((x) => typeof x === 'string').join('\n');
    assert.match(all, /In kb-team, the team's own members \(listed under team-members\) and the colleagues and partners/);
    assert.match(all, /when a thread shows a member's expertise, a customer they work with, or a change of role, update their profile in kb-team/);
  });
});
