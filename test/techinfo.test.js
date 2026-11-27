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
import { techInfo } from '../src/techinfo.js';
import { d1 } from './d1.js';

// Made-up teams, people, customers and products only.
const ADMIN = {
  id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['admin'],
};
const EDGE = {
  id: 2, email: 'mo@staff.example', name: 'Mo', staff: 1, teams: ['edge'],
};
const NOBODY = {
  id: 3, email: 'no@staff.example', name: 'No', staff: 1, teams: [],
};
const as = (p, role = 'member') => ({ ...p, teams: p.teams.map((slug) => ({ slug, role })) });
const AT = '2026-11-20T00:00:00Z';

function db() {
  const DB = d1({
    teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'edge', name: 'Edge ops' }, { slug: 'design', name: 'Design ops' }],
    people: [ADMIN, EDGE, NOBODY],
  });
  DB.sqlite.exec(`
    DELETE FROM tech_stack; DELETE FROM extraction_rules;
    INSERT INTO orgs (slug, name, updated_at) VALUES ('acme', 'Acme', '${AT}'), ('globex', 'Globex', '${AT}'),
      ('initech', 'Initech', '${AT}');
    INSERT INTO org_merges (slug, into_slug, merged_at) VALUES ('initech', 'acme', '${AT}');
    INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at) VALUES
      ('kb-team-admin', 'team', 'admin', 'r', '${AT}'), ('kb-team-edge', 'team', 'edge', 'r', '${AT}'),
      ('kb-team-design', 'team', 'design', 'r', '${AT}'), ('kb-org-acme', 'org', 'acme', 'r', '${AT}');
    INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, channel_name, path,
        root_at, last_at, any_at, messages, updated_at, last_author, last_staff)
      VALUES ('t1', 'slack', 'T', 'C1', '1', 'acme', 'edge', 'acme-edge', 'q/1/', '${AT}', '${AT}',
        '${AT}', 2, '${AT}', 'x', 1);
    INSERT INTO tech_stack (team, tech, name, description, aliases, kind, vendor, product, path, layer, enabled) VALUES
      ('design', 'sketchy/sketchy', 'Sketchy', 'Sketchy for designs that become pages', 'Sketchy, Sketchy MCP',
        'Product', 'Sketchy', 'Sketchy', 'products/sketchy/sketchy.md', 'content', 1),
      ('edge', 'acme-cloud/sites/delivery', 'Delivery', 'the delivery tier', '', 'Feature', 'Acme Cloud', 'Sites',
        'products/acme-cloud/sites/delivery.md', 'site', 1),
      ('edge', 'acme-cloud/sites/editor', 'Editor', 'the visual editor', '', 'Feature', 'Acme Cloud', 'Sites',
        'products/acme-cloud/sites/editor.md', 'content', 1);
    INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, position) VALUES
      ('design', 'Sketchy file link', 'regex', 'tech', 'sketchy/sketchy', 'sketchy\\.example/file/', 'i', 10),
      ('edge', 'Delivery host', 'regex', 'tech', 'acme-cloud/sites/delivery', '\\.delivery\\.example\\b', '', 10),
      ('edge', 'Something else', 'regex', 'fact', 'sketchy/sketchy', 'x', '', 20);
    INSERT INTO tech_moves (team, old, tech) VALUES ('design', 'sketchy', 'sketchy/sketchy');
    INSERT INTO team_follows (team, tech, added_at) VALUES ('edge', 'sketchy/sketchy', '${AT}');
    INSERT INTO person_follows (person, tech, added_at) VALUES (1, 'sketchy/sketchy', '${AT}'),
      (2, 'sketchy/sketchy', '${AT}');
    INSERT INTO org_stacks (org, parts, updated_at) VALUES
      ('acme', '[{"name":"Design files","tech":"sketchy/sketchy","layer":"content"},{"name":"CDN","tech":"x/cdn","layer":"edge"}]', '${AT}'),
      ('globex', 'not json', '${AT}'),
      ('initech', '[{"name":"Sketchy","tech":"sketchy/sketchy","layer":"content"}]', '${AT}');
    INSERT INTO kb_concepts (repo, path, hash, type, title, description, tags, body) VALUES
      ('kb-team-design', 'products/sketchy/sketchy.md', 'h1', 'Product', 'Sketchy', 'Sketchy for designs', NULL, 'Sketchy.'),
      ('kb-team-edge', 'products/acme-cloud/sites.md', 'h2', 'Product', 'Sites', 'Acme Cloud''s sites', NULL, 'Sites.'),
      ('kb-team-edge', 'issues/sketchy-import.md', 'h3', 'Known Issue', 'Sketchy import drops fonts', 'Fonts go missing', 'sketchy', 'Import from Sketchy loses the fonts.'),
      ('kb-org-acme', 'tech-stack/design.md', 'h4', 'Tech Stack', 'Acme designs in Sketchy', NULL, 'sketchy', 'Acme keeps its designs in Sketchy.');
  `);
  return DB;
}

describe('a technology on the Topics page', () => {
  it('has its catalog entry, knowledge, rules, followers, customers and agents', async () => {
    const env = { DB: db() };
    const r = await techInfo(env, as(ADMIN), { tech: ['sketchy/sketchy', '../nope'], name: 'Sketchy' });
    assert.equal(r.tech.length, 1);
    assert.deepEqual(r.tech[0].aliases, ['Sketchy', 'Sketchy MCP']);
    assert.equal(r.tech[0].teams[0].repo, 'kb-team-design');
    assert.equal(r.tech[0].teams[0].readable, true);
    // What its team's catalog file says: the record of it.
    assert.deepEqual(r.tech[0].teams[0].entry, {
      title: 'Sketchy', description: 'Sketchy for designs', body: 'Sketchy.', truncated: false,
    });
    assert.equal(r.product, null);
    // The catalog's own file is not "knowledge"; the entries about it are, a customer's too.
    assert.deepEqual(r.knowledge.map((k) => k.path).sort(), ['issues/sketchy-import.md', 'tech-stack/design.md']);
    assert.deepEqual(r.rules.map((x) => x.name), ['Sketchy file link']);
    assert.equal(r.rules[0].pattern, 'sketchy\\.example/file/');
    assert.deepEqual(r.follows, { teams: [{ team: 'edge', name: 'Edge ops', tech: ['sketchy/sketchy'] }], people: 2 });
    // A merged customer's stack is the one it went into; a drawing that is not JSON is none.
    assert.deepEqual(r.stacks, [{ org: 'acme', name: 'Acme', parts: [{ name: 'Design files', tech: 'sketchy/sketchy' }] }]);
    assert.deepEqual(r.agents.map((a) => [a.repo, a.write]), [['kb-team-design', true]]);
    // A map from before its file moved names it by the id it had.
    const old = await techInfo(env, as(ADMIN), { tech: ['sketchy'], name: 'Sketchy' });
    assert.deepEqual(old.tech.map((t) => t.tech), ['sketchy/sketchy']);
    assert.equal(old.rules.length, 1);
  });

  it('has the product of its features, and the agent of the team that has them', async () => {
    const env = { DB: db() };
    const r = await techInfo(env, as(EDGE), {
      tech: ['acme-cloud/sites/delivery', 'acme-cloud/sites/editor'], name: 'Sites',
    });
    assert.deepEqual(r.tech.map((t) => t.name), ['Delivery', 'Editor']);
    assert.equal(r.product.path, 'products/acme-cloud/sites.md');
    assert.equal(r.product.teamName, 'Edge ops');
    assert.equal(r.product.entry.body, 'Sites.');
    assert.deepEqual(r.rules.map((x) => x.name), ['Delivery host']);
    assert.deepEqual(r.agents.map((a) => [a.slug, a.write]), [['edge', true]]);
  });

  it('is read as the viewer may', async () => {
    const env = { DB: db() };
    // Adobe's, on no team: every knowledge base, as on a team, and the agent to talk to, which
    // changes nothing for them.
    const r = await techInfo(env, as(NOBODY), { tech: ['sketchy/sketchy'], name: 'Sketchy' });
    assert.equal(r.tech[0].name, 'Sketchy');
    assert.equal(r.tech[0].teams[0].readable, true);
    assert.equal(r.tech[0].teams[0].entry.title, 'Sketchy');
    assert.equal(r.knowledge.length, 2);
    assert.equal(r.rules.length, 1);
    assert.equal(r.hiddenRules, 0);
    assert.deepEqual(r.agents.map((a) => [a.slug, a.write]), [['design', false]]);
    // And a customer's stack drawing, its knowledge base's.
    assert.deepEqual(r.stacks.map((x) => x.org), ['acme']);
    // Someone signed in from SIGNIN_DOMAINS who is not Adobe's: none of it.
    const out = await techInfo(env, { ...NOBODY, staff: 0, email: 'x@partner.example' }, { tech: ['sketchy/sketchy'], name: 'Sketchy' });
    assert.deepEqual(
      [out.tech[0].teams[0].readable, out.knowledge, out.rules, out.agents, out.stacks],
      [false, [], [], [], []],
    );
    assert.equal(out.hiddenRules, 1);
    // On a team: every team's knowledge base, and the customers'; the agent of the team whose
    // catalog has it, read only.
    const mo = await techInfo(env, as(EDGE), { tech: ['sketchy/sketchy'], name: 'Sketchy' });
    assert.equal(mo.knowledge.length, 2);
    assert.deepEqual(mo.agents.map((a) => [a.slug, a.write]), [['design', false]]);
    // The stack of a customer of its own team.
    assert.deepEqual(mo.stacks.map((x) => x.org), ['acme']);
    // And of one its team does not own, whose knowledge base it reads too.
    const other = await techInfo(env, as({ ...EDGE, teams: ['design'] }), { tech: ['sketchy/sketchy'] });
    assert.deepEqual(other.stacks.map((x) => x.org), ['acme']);
  });

  it('of a name no catalog has: its knowledge, and the agents of your teams', async () => {
    const env = { DB: db() };
    const r = await techInfo(env, as(EDGE), { tech: [], name: 'Sketchy import' });
    assert.deepEqual(r.tech, []);
    assert.deepEqual(r.knowledge.map((k) => k.path), ['issues/sketchy-import.md']);
    assert.deepEqual(r.agents.map((a) => a.slug), ['edge', 'admin']);
  });

  it('is GET /api/topics/tech, for Adobe\'s people', async () => {
    const e = { DB: db(), STAFF_DOMAINS: 'staff.example' };
    const call = async (me) => {
      const url = new URL('https://opspile.example/api/topics/tech?tech=sketchy/sketchy&name=Sketchy');
      const res = await api(new Request(url), e, url, { viewer: me });
      return { status: res.status, body: await res.json() };
    };
    const ok = await call(as(ADMIN));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.tech[0].tech, 'sketchy/sketchy');
    const outsider = {
      id: 9, email: 'x@partner.example', name: 'X', teams: [],
    };
    assert.equal((await call(outsider)).status, 403);
  });
});
