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
import { api } from '../src/api.js';
import { d1 } from './d1.js';
import { gitServer, hasGit } from './git-server.js';

// Made-up people and teams only.
const ADMIN = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin'],
};
const LEAD = {
  id: 2, email: 'lee@staff.example', name: 'Lee', staff: 1, teams: ['edge'],
};
const MEMBER = {
  id: 3, email: 'mo@staff.example', name: 'Mo', staff: 1, teams: ['edge'],
};
const as = (p, role = 'member') => ({ ...p, teams: p.teams.map((slug) => ({ slug, role })) });

async function call(e, me, method, path, body) {
  const url = new URL(`https://opspile.example${path}`);
  const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const res = await api(request, e, url, { viewer: me });
  return { status: res.status, body: await res.json() };
}

describe('the Topics page', { skip: !hasGit() && 'git is not installed' }, () => {
  it('is every member\'s; the admin team and team managers change the areas', async () => {
    const srv = await gitServer();
    try {
      const DB = d1({
        teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'edge', name: 'Edge' }],
        people: [ADMIN, LEAD, MEMBER],
      });
      DB.sqlite.exec(`UPDATE team_members SET role = 'manager' WHERE person = ${LEAD.id}`);
      for (const t of ['admin', 'edge']) {
        srv.create(`kb-team-${t}`);
        DB.sqlite.exec(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at)
          VALUES ('kb-team-${t}', 'team', '${t}', 'r', '2026-11-20T00:00:00Z')`);
      }
      const e = { DB, ARTIFACTS: srv.artifacts, STAFF_DOMAINS: 'staff.example' };
      // Someone on no ops team from SIGNIN_DOMAINS who is not staff does not.
      const outsider = {
        id: 9, email: 'x@partner.example', name: 'X', teams: [],
      };
      assert.equal((await call(e, outsider, 'GET', '/api/topics')).status, 403);
      // Staff on no team do, to find what to follow, and may change nothing.
      const insiders = [{ ...outsider, email: 'x@staff.example' }, { ...outsider, staff: true }];
      for (const seen of await Promise.all(insiders.map((p) => call(e, p, 'GET', '/api/topics')))) {
        assert.equal(seen.status, 200);
        assert.deepEqual(seen.body.may, { areas: [], rebuild: false });
      }
      assert.equal((await call(e, insiders[0], 'POST', '/api/topics')).status, 403);
      // A member sees it, and may change nothing.
      let r = await call(e, as(MEMBER), 'GET', '/api/topics');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.may, { areas: [], rebuild: false });
      // Every team's name, the member's or not.
      assert.deepEqual(Object.keys(r.body.teams).sort(), ['admin', 'edge']);
      // And the teams each person is on.
      assert.deepEqual(r.body.members[MEMBER.id], ['edge']);
      assert.deepEqual(r.body.areas, []);
      assert.deepEqual(r.body.follows.by, { org: [], person: [], area: [] });
      assert.equal((await call(e, as(MEMBER), 'POST', '/api/areas', {
        team: 'edge', id: 'search', title: 'Site search', what: 'site search',
      })).status, 403);
      assert.equal((await call(e, as(MEMBER), 'POST', '/api/topics')).status, 403);
      // A manager: their team's.
      assert.deepEqual((await call(e, as(LEAD, 'manager'), 'GET', '/api/topics')).body.may.areas, ['edge']);
      assert.equal((await call(e, as(LEAD, 'manager'), 'POST', '/api/areas', {
        team: 'admin', id: 'search', title: 'Site search', what: 'site search',
      })).status, 403);
      r = await call(e, as(LEAD, 'manager'), 'POST', '/api/areas', {
        team: 'edge', id: 'search', title: 'Site search', what: 'site search: ranking and indexing',
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.areas.map((a) => [a.team, a.id, a.name, a.enabled]), [['edge', 'search', 'Site search', true]]);
      assert.match(srv.show('kb-team-edge', 'areas/search.md'), /generated: \{ by: human:lee@staff\.example/);
      assert.equal((await call(e, as(LEAD, 'manager'), 'POST', '/api/areas', {
        team: 'edge', id: 'search', title: 'Again', what: 'x',
      })).status, 409);
      // Renamed and turned off: its id stays.
      r = await call(e, as(LEAD, 'manager'), 'PUT', '/api/areas', {
        team: 'edge', id: 'search', title: 'Search', enabled: false,
      });
      assert.deepEqual(r.body.areas.map((a) => [a.id, a.name, a.what, a.enabled]), [['search', 'Search', 'site search: ranking and indexing', false]]);
      // The admin team: any team's.
      assert.deepEqual((await call(e, as(ADMIN), 'GET', '/api/topics')).body.may.areas, ['admin', 'edge']);
      r = await call(e, as(ADMIN), 'DELETE', '/api/areas', { team: 'edge', id: 'search' });
      assert.deepEqual(r.body.areas, []);
      assert.equal((await call(e, as(ADMIN), 'DELETE', '/api/areas', { team: 'edge', id: 'search' })).status, 404);
      assert.equal((await call(e, as(ADMIN), 'POST', '/api/areas', {
        team: 'edge', id: 'Bad Id', title: 'x', what: 'x',
      })).status, 400);
      // A topic map needs the index and Workers AI.
      assert.equal((await call(e, as(ADMIN), 'POST', '/api/topics')).status, 503);
    } finally {
      await srv.close();
    }
  });
});
