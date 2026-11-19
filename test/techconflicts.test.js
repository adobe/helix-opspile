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
  findConflicts, resolveConflict, techConflicts, withAliases,
} from '../src/techconflicts.js';
import { writeKnowledge } from '../src/agent/kbwrite.js';
import { d1 } from './d1.js';
import { gitServer, hasGit } from './git-server.js';

const ADMIN = { email: 'ada@staff.example', name: 'Ada' };

const row = (o) => ({
  team: 'admin', name: o.tech, description: `${o.tech} as such`, layer: null, product: null, enabled: 1, aliases: null, path: null, ...o,
});

const env = () => {
  const DB = d1({ teams: [{ slug: 'admin', name: 'Admin' }, { slug: 'helix', name: 'Helix' }, { slug: 'cdn', name: 'CDN' }] });
  DB.sqlite.exec('DELETE FROM tech_stack');
  return { DB };
};
const insert = (e, o) => {
  const r = row(o);
  e.DB.sqlite.prepare(`INSERT INTO tech_stack (team, tech, name, description, layer, product, enabled, aliases, path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.team, r.tech, r.name, r.description, r.layer, r.product, r.enabled, r.aliases, r.path);
};

describe('conflicts between the teams\' technologies', () => {
  it('are an id defined otherwise, and a name two ids share', async () => {
    const all = await findConflicts([
      row({ tech: 'akamai', description: 'Akamai as CDN', aliases: 'EdgeWorkers' }),
      row({ team: 'cdn', tech: 'akamai', description: 'Akamai in front of the site' }),
      // The same everywhere: no conflict.
      row({ tech: 'eds', aliases: 'Managed CDN, Helix' }),
      row({ team: 'helix', tech: 'eds', aliases: 'Franklin' }),
      row({
        team: 'cdn', tech: 'adobe/aem-sites/managed-cdn', name: 'Adobe Managed CDN', aliases: 'managed  CDN',
      }),
      // A team that only turns the admin team's off opts out: no conflict.
      row({ tech: 'gdrive' }),
      row({ team: 'helix', tech: 'gdrive', enabled: 0 }),
      // Off: a name nobody asks about matches nothing.
      row({ tech: 'old', aliases: 'Helix', enabled: 0 }),
    ]);
    assert.deepEqual(all.map((c) => c.key), ['diverging:akamai', 'name:managed cdn']);
    const [div, name] = all;
    assert.deepEqual(div.fields, ['description']);
    assert.deepEqual(div.definitions.map((d) => d.team), ['admin', 'cdn']);
    assert.deepEqual(name.techs, ['adobe/aem-sites/managed-cdn', 'eds']);
    assert.deepEqual(name.uses.map((u) => [u.team, u.tech, u.as]), [['cdn', 'adobe/aem-sites/managed-cdn', 'alias'], ['admin', 'eds', 'alias']]);
    assert.match(div.fingerprint, /^[0-9a-f]{16}$/);
  });

  it('kept, stay hidden until a definition changes', async () => {
    const e = env();
    insert(e, { tech: 'akamai', description: 'Akamai as CDN' });
    insert(e, { team: 'cdn', tech: 'akamai', description: 'Akamai in front' });
    assert.equal((await techConflicts(e, { kept: false })).length, 1);
    const r = await resolveConflict(e, ADMIN, { key: 'diverging:akamai', action: 'keep', note: 'their CDN team words it so' });
    assert.equal(r.done, 'kept');
    assert.equal((await techConflicts(e, { kept: false })).length, 0);
    const [kept] = await techConflicts(e);
    assert.deepEqual([kept.kept.by, kept.kept.note], [ADMIN.email, 'their CDN team words it so']);
    e.DB.sqlite.exec("UPDATE tech_stack SET description = 'Akamai, changed' WHERE team = 'cdn'");
    assert.equal((await techConflicts(e, { kept: false })).length, 1);
  });

  it('are settled in D1 for rows saved there: use one, delete one, take a name off', async () => {
    const e = env();
    insert(e, { tech: 'akamai', description: 'Akamai as CDN' });
    insert(e, { team: 'cdn', tech: 'akamai', description: 'Akamai in front' });
    insert(e, { team: 'helix', tech: 'akamai', enabled: 0 });
    assert.match((await resolveConflict(e, ADMIN, { key: 'diverging:akamai', action: 'use', team: 'nobody' })).error, /team/);
    assert.equal((await resolveConflict(e, ADMIN, { key: 'diverging:akamai', action: 'use', team: 'cdn' })).done, 'used');
    assert.deepEqual(e.DB.rows("SELECT team FROM tech_stack WHERE tech = 'akamai'"), [{ team: 'cdn' }]);
    assert.equal((await resolveConflict(e, ADMIN, { key: 'diverging:akamai', action: 'use', team: 'cdn' })).status, 404);

    insert(e, { tech: 'eds', aliases: 'Managed CDN, Helix' });
    insert(e, { team: 'cdn', tech: 'managed', name: 'Managed CDN' });
    assert.match((await resolveConflict(e, ADMIN, {
      key: 'name:managed cdn', action: 'unalias', team: 'cdn', tech: 'managed',
    })).error, /name there, not an alias/);
    assert.equal((await resolveConflict(e, ADMIN, {
      key: 'name:managed cdn', action: 'unalias', team: 'admin', tech: 'eds',
    })).done, 'unaliased');
    assert.equal(e.DB.rows("SELECT aliases FROM tech_stack WHERE tech = 'eds'")[0].aliases, 'Helix');
    assert.deepEqual(await techConflicts(e), []);

    insert(e, { team: 'helix', tech: 'eds', name: 'Helix' });
    assert.equal((await resolveConflict(e, ADMIN, {
      key: 'diverging:eds', action: 'delete', team: 'helix', tech: 'eds',
    })).done, 'deleted');
    assert.deepEqual(e.DB.rows("SELECT team FROM tech_stack WHERE tech = 'eds'"), [{ team: 'admin' }]);
    assert.match((await resolveConflict(e, ADMIN, { key: 'x', action: 'keep' })).error, /no such conflict/);
  });

  it('set a file\'s aliases', () => {
    const text = '---\ntype: Feature\ntitle: X\naliases:\n  - A\n  - B\nlayer: site\n---\n\nBody.\n';
    assert.equal(withAliases(text, ['B']), '---\ntype: Feature\ntitle: X\nlayer: site\naliases: [B]\n---\n\nBody.\n');
    assert.equal(withAliases(text, []), '---\ntype: Feature\ntitle: X\nlayer: site\n---\n\nBody.\n');
  });
});

describe('settling a conflict in the teams\' catalogs', { skip: !hasGit() && 'git is not installed' }, () => {
  it('merges one technology into another: its files go, and what D1 keeps under it moves', async () => {
    const srv = await gitServer();
    try {
      const e = env();
      e.ARTIFACTS = srv.artifacts;
      for (const t of ['admin', 'cdn']) {
        srv.create(`kb-team-${t}`);
        e.DB.sqlite.exec(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at)
          VALUES ('kb-team-${t}', 'team', '${t}', 'r', '2026-11-19T00:00:00Z')`);
      }
      insert(e, { tech: 'eds', aliases: 'Managed CDN' });
      const opts = {
        message: 'seed', by: 'human:ada@staff.example', logEntry: 'seed', staff: true,
      };
      const mcdn = '---\ntype: Feature\ntitle: Adobe Managed CDN\ndescription: the CDN Adobe runs\naliases: [Managed CDN]\nlayer: edge\n---\n\nIt.\n';
      const old = '---\ntype: Product\ntitle: Managed CDN\ndescription: the managed CDN\nlayer: edge\n---\n\nThe same.\n';
      await writeKnowledge(e, 'kb-team-cdn', [{ path: 'products/adobe/aem-sites/managed-cdn.md', content: mcdn }], opts);
      await writeKnowledge(e, 'kb-team-admin', [{ path: 'products/adobe/managed.md', content: old }], opts);
      e.DB.sqlite.exec("INSERT INTO thread_tech (thread, tech, p) VALUES ('t1', 'adobe/managed', 0.9)");
      const key = 'name:managed cdn';
      assert.ok((await techConflicts(e)).some((c) => c.key === key));
      assert.match((await resolveConflict(e, ADMIN, {
        key, action: 'merge', from: 'adobe/aem-sites/managed-cdn', into: 'eds',
      })).error, /one kept in a team's catalog/);
      const r = await resolveConflict(e, ADMIN, {
        key, action: 'merge', from: 'adobe/managed', into: 'adobe/aem-sites/managed-cdn',
      });
      assert.equal(r.done, 'merged');
      assert.ok(!srv.files('kb-team-admin').includes('products/adobe/managed.md'));
      assert.match(srv.show('kb-team-cdn', 'products/adobe/aem-sites/managed-cdn.md'), /moved_from: \[adobe\/managed\]/);
      assert.deepEqual(e.DB.rows('SELECT tech FROM thread_tech'), [{ tech: 'adobe/aem-sites/managed-cdn' }]);
      // Who settled it wrote the files.
      assert.match(srv.show('kb-team-cdn', 'products/adobe/aem-sites/managed-cdn.md'), /generated: \{ by: human:ada@staff\.example/);
    } finally {
      await srv.close();
    }
  });
});
