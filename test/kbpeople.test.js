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
import { writeKnowledge } from '../src/agent/kbwrite.js';
import {
  findPerson, matchContact, parseContact, personInKb,
} from '../src/kbpeople.js';
import { d1 } from './d1.js';
import { gitServer, hasGit } from './git-server.js';

const contact = (title, more = '') => `---\ntype: Contact\ntitle: ${title}\n${more}---\n\n# ${title}\n`;

/** A reader over `{ [repo]: { [path]: text } }`, the hash of a file its repo and path. */
function reader(repos) {
  const reads = [];
  return {
    reads,
    list: async (repo) => Object.keys(repos[repo] || {}).map((path) => ({ path, hash: `${repo}:${path}` })),
    blobs: async (repo, hashes) => {
      reads.push(...hashes);
      return Object.fromEntries(hashes.map((h) => [h, repos[repo][h.slice(repo.length + 1)]]));
    },
  };
}

describe('people in the knowledge bases', () => {
  it('reads a Contact, and nothing else', () => {
    const c = parseContact('contacts/dana-ops.md', contact('Dana Ops', 'description: "Adobe\'s SRE on the account."\naliases: [dops, Dana O.]\nresource: mailto:Dana@Example.com\nstale_after: 2026-01-01T00:00:00Z\n'));
    assert.deepEqual(c, {
      path: 'contacts/dana-ops.md',
      title: 'Dana Ops',
      description: 'Adobe\'s SRE on the account.',
      aliases: ['dops', 'Dana O.'],
      email: 'dana@example.com',
      status: null,
      staleAfter: '2026-01-01T00:00:00Z',
    });
    assert.equal(parseContact('sites/www.md', '---\ntype: Site\n---\n'), null);
    assert.equal(parseContact('contacts/x.md', 'no frontmatter'), null);
  });

  it('finds them by address, else by any name they go by', () => {
    const list = [
      parseContact('contacts/sam-reyes.md', contact('Sam Reyes', 'resource: mailto:sam@acme.example\n')),
      parseContact('contacts/dana-ops.md', contact('Dana Ops', 'aliases: [dops]\n')),
      parseContact('contacts/jo.md', contact('Johanna Weber (ACME)')),
    ];
    assert.equal(matchContact(list, { email: 'SAM@acme.example', names: ['Someone Else'] }).path, 'contacts/sam-reyes.md');
    assert.equal(matchContact(list, { names: ['Ops, Dana'] }).path, 'contacts/dana-ops.md');
    assert.equal(matchContact(list, { names: ['dops'] }).path, 'contacts/dana-ops.md');
    assert.equal(matchContact(list, { names: ['Johanna Weber'] }).path, 'contacts/jo.md');
    assert.equal(matchContact(list, { names: ['jo'] }).path, 'contacts/jo.md');
    assert.equal(matchContact(list, { email: 'nobody@acme.example', names: ['Nobody'] }), null);
    assert.equal(matchContact(list, { names: [] }), null);
  });

  it('looks in each knowledge base, in order, and reads a blob once', async () => {
    const r = reader({
      'kb-org-acme': {
        'contacts/dana-ops.md': contact('Dana Ops', 'description: On the ACME account.\nstale_after: 2026-01-01T00:00:00Z\n'),
        'contacts/people.md': '---\ntype: Contact\ntitle: Everyone\n---\n\n- Dana Ops\n',
        'contacts/index.md': '# contacts\n',
      },
      'kb-team-platform': {
        'contacts/dana-ops.md': contact('Dana Ops', 'description: SRE of the team.\nstatus: draft\n'),
      },
      'kb-team-edge': {},
    });
    const kbs = [
      { repo: 'kb-org-acme', kind: 'org', name: 'ACME' },
      { repo: 'kb-team-platform', kind: 'team', name: 'Platform ops' },
      { repo: 'kb-team-edge', kind: 'team', name: 'Edge ops' },
      { repo: 'kb-team-gone', kind: 'team', name: 'Gone' },
    ];
    const who = { names: ['Dana Ops'] };
    const now = new Date('2026-06-01T00:00:00Z');
    const found = await findPerson(r, kbs, who, now);
    assert.deepEqual(found, [{
      repo: 'kb-org-acme', kind: 'org', name: 'ACME', path: 'contacts/dana-ops.md', title: 'Dana Ops', description: 'On the ACME account.', status: 'stable', stale: true,
    }, {
      repo: 'kb-team-platform', kind: 'team', name: 'Platform ops', path: 'contacts/dana-ops.md', title: 'Dana Ops', description: 'SRE of the team.', status: 'draft', stale: false,
    }]);
    // The index is never read; the second time, nothing is.
    assert.ok(!r.reads.includes('kb-org-acme:contacts/index.md'));
    const before = r.reads.length;
    await findPerson(r, kbs, who, now);
    assert.equal(r.reads.length, before);
  });

  it('leaves out a knowledge base it cannot read', async () => {
    const failing = {
      list: async (repo) => {
        if (repo === 'kb-org-broken') {
          throw new Error('unavailable');
        }
        return [{ path: 'contacts/dana-ops.md', hash: 'h-ok' }];
      },
      blobs: async () => ({ 'h-ok': contact('Dana Ops') }),
    };
    const found = await findPerson(failing, [
      { repo: 'kb-org-broken', kind: 'org', name: 'Broken' },
      { repo: 'kb-team-ok', kind: 'team', name: 'OK' },
    ], { names: ['Dana Ops'] });
    assert.deepEqual(found.map((f) => f.repo), ['kb-team-ok']);
  });
});

describe('GET /api/person', { skip: !hasGit() && 'git is not installed' }, () => {
  it('answers from the knowledge bases of the thread its viewer may read', async () => {
    const srv = await gitServer();
    try {
      const DB = d1({
        teams: [{ slug: 'platform', name: 'Platform ops' }, { slug: 'edge', name: 'Edge ops' }],
        people: [{
          id: 1, email: 'lena@example.com', name: 'Lena Berg', staff: 1, teams: ['platform'],
        }],
      });
      DB.sqlite.exec(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team,
          kind, channel_name, path, root_at, last_at, any_at, messages, updated_at)
        VALUES ('slack:E1:C1:1', 'slack', 'E1', 'C1', '1', 'acme', 'platform', 'channel', 'aem-acme',
          'channels/acme/platform/slack-C1/1/', '2026-10-22T00:00:00Z', '2026-10-22T00:00:00Z',
          '2026-10-22T00:00:00Z', 1, '2026-10-22T00:00:00Z');
        INSERT INTO orgs (slug, name, updated_at) VALUES ('acme', 'ACME', '2026-10-22T00:00:00Z');
        INSERT INTO knowledge_bases (repo, kind, slug, created_at) VALUES
          ('kb-org-acme', 'org', 'acme', '2026-10-22T00:00:00Z'),
          ('kb-team-platform', 'team', 'platform', '2026-10-22T00:00:00Z');
        INSERT INTO identities (source, tenant, user_id, kind, name, email, aliases, fetched_at) VALUES
          ('slack', 'E1', 'U1', 'person', 'Sam R.', 'sam@acme.example', '["sreyes"]', '2026-10-22T00:00:00Z'),
          ('slack', 'E1', 'B1', 'bot', 'Sam Reyes', null, null, '2026-10-22T00:00:00Z');`);
      srv.create('kb-org-acme');
      srv.create('kb-team-platform');
      const env = { DB, ARTIFACTS: srv.artifacts };
      const opts = {
        message: 'seed', by: 'human:lena@example.com', logEntry: 'seed', staff: true,
      };
      await writeKnowledge(env, 'kb-org-acme', [{
        path: 'contacts/sam-reyes.md',
        content: contact('Sam Reyes', 'description: ACME\'s web lead.\nresource: mailto:sam@acme.example\n'),
      }, { path: 'sites/www.md', content: '---\ntype: Site\n---\n' }], opts);
      await writeKnowledge(env, 'kb-team-platform', [{ path: 'contacts/lena-berg.md', content: contact('Lena Berg') }], opts);

      const lena = { email: 'lena@example.com', teams: [{ slug: 'platform', role: 'member' }] };
      const anyone = async () => true;
      const ask = async (q, me = lena, canSee = anyone) => {
        const res = await personInKb(env, me, { thread: 'slack:E1:C1:1', ...q }, canSee);
        return { status: res.status, ...(await res.json()) };
      };
      // By the account's address, whatever the platform calls them.
      const sam = await ask({ key: 'slack:E1:U1' });
      assert.deepEqual(sam.entries, [{
        repo: 'kb-org-acme', kind: 'org', name: 'ACME', path: 'contacts/sam-reyes.md', title: 'Sam Reyes', description: 'ACME\'s web lead.', status: 'stable', stale: false,
      }]);
      // Without an account, by name; in the team's knowledge base.
      assert.deepEqual((await ask({ name: 'Berg, Lena' })).entries.map((e) => e.repo), ['kb-team-platform']);
      // Bots are nobody's Contact; the email stays on the server.
      assert.deepEqual((await ask({ key: 'slack:E1:B1', name: 'Sam Reyes' })).entries, []);
      assert.doesNotMatch(JSON.stringify(sam), /sam@acme/);
      // Only the knowledge bases the viewer may read: the edge team does not own ACME.
      const edge = { email: 'x@example.com', teams: [{ slug: 'edge', role: 'member' }] };
      assert.deepEqual((await ask({ key: 'slack:E1:U1' }, edge)).entries, []);
      // Only on a thread the viewer may see.
      assert.equal((await ask({ key: 'slack:E1:U1' }, lena, async () => false)).status, 404);
      assert.equal((await personInKb(env, lena, { thread: 'nope', key: 'slack:E1:U1' }, anyone)).status, 404);
    } finally {
      await srv.close();
    }
  });
});
