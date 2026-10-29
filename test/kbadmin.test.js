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
import { checkChanges } from '../src/agent/kbwrite.js';
import { asSystemPrompt, systemPromptBody } from '../src/agent/okf.js';
import { agentEnabled } from '../src/agent/enabled.js';
import { api } from '../src/api.js';
import { countEntries } from '../src/kbadmin.js';
import { d1 } from './d1.js';
import { gitServer, hasGit } from './git-server.js';

// Made-up people and slugs only.
const ADMIN = {
  id: 1, email: 'ada@staff.example', name: 'Ada', teams: [{ slug: 'admin' }, { slug: 'helix' }],
};
const MEMBER = {
  id: 2, email: 'bo@staff.example', name: 'Bo', teams: [{ slug: 'helix' }],
};

function call(env, me, method, path, body) {
  const url = new URL(`https://opspile.example${path}`);
  const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  return api(request, env, url, { viewer: me });
}

describe('system prompts', () => {
  it('are concepts of their own type, and only staff write them', () => {
    const text = asSystemPrompt('Always sign as the team.');
    assert.match(text, /^---\ntype: System Prompt\n/);
    assert.equal(asSystemPrompt(text), text);
    assert.equal(systemPromptBody(text), 'Always sign as the team.');
    assert.equal(systemPromptBody('---\ntype: System Prompt\n---\n<!-- a note -->\n\nBe brief.\n'), 'Be brief.');
    const change = [{ path: 'systemprompt.md', content: 'x' }];
    assert.match(checkChanges(change), /maintained by the admin team/);
    assert.equal(checkChanges(change, { staff: true }), null);
    assert.match(checkChanges([{ path: 'systemprompt.md', content: 'x'.repeat(17 * 1024) }], { staff: true }), /at most 16 KB/);
    assert.equal(checkChanges([{ path: 'systemprompt.md', delete: true }], { staff: true }), null);
  });
});

describe('knowledge-base editor API', { skip: !hasGit() && 'git is not installed' }, () => {
  it('is for the admin team only', async () => {
    const env = { DB: d1() };
    for (const path of ['/api/kb', '/api/kb/files?repo=kb-team-helix']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(env, MEMBER, 'GET', path);
      assert.equal(res.status, 403);
    }
  });

  it('lists knowledge bases and files, reads, creates, edits and deletes as the person', async () => {
    const srv = await gitServer();
    try {
      srv.create('kb-team-helix');
      srv.create('kb-org-acme');
      const DB = d1({ teams: [{ slug: 'helix', name: 'Helix ops' }, { slug: 'admin', name: 'Admin' }] });
      DB.sqlite.exec(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at) VALUES
        ('kb-org-acme', 'org', 'acme', 'r', '2026-10-22T00:00:00Z'),
        ('kb-team-helix', 'team', 'helix', 'r', '2026-10-22T00:00:00Z')`);
      const env = { DB, ARTIFACTS: srv.artifacts };

      const bases = await (await call(env, ADMIN, 'GET', '/api/kb')).json();
      assert.deepEqual(bases.bases.map((b) => [b.repo, b.name]), [['kb-team-helix', 'Helix ops'], ['kb-org-acme', 'acme']]);
      assert.equal((await call(env, ADMIN, 'GET', '/api/kb/files?repo=kb-team-other')).status, 404);

      let files = await (await call(env, ADMIN, 'GET', '/api/kb/files?repo=kb-team-helix')).json();
      assert.deepEqual([files.files, files.hasSystemPrompt], [[], false]);

      // Create the system prompt; plain text gets its frontmatter.
      let res = await call(env, ADMIN, 'PUT', '/api/kb/file', {
        repo: 'kb-team-helix', path: 'systemprompt.md', content: 'Sign as the team.', message: 'Add agent instructions',
      });
      assert.equal(res.status, 200);
      const created = await res.json();
      assert.equal(created.commit, srv.head('kb-team-helix'));
      files = await (await call(env, ADMIN, 'GET', '/api/kb/files?repo=kb-team-helix')).json();
      assert.deepEqual(files.files.map((f) => f.path), ['index.md', 'log.md', 'systemprompt.md']);
      assert.equal(files.hasSystemPrompt, true);
      const file = await (await call(env, ADMIN, 'GET', '/api/kb/file?repo=kb-team-helix&path=systemprompt.md')).json();
      assert.match(file.text, /type: System Prompt[\s\S]*generated: \{ by: human:ada@staff\.example, at: [^}]+\}[\s\S]*Sign as the team\./);
      assert.equal(file.hash, created.hash);
      assert.match(srv.show('kb-team-helix', 'log.md'), /\*\*Update\*\*: Add agent instructions \(Ada\)/);

      // Creating it again, or saving from an old version, is a conflict that returns the file.
      res = await call(env, ADMIN, 'PUT', '/api/kb/file', { repo: 'kb-team-helix', path: 'systemprompt.md', content: 'x' });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).current.hash, file.hash);
      res = await call(env, ADMIN, 'PUT', '/api/kb/file', {
        repo: 'kb-team-helix', path: 'systemprompt.md', content: file.text.replace('team.', 'ops team.'), base: file.hash,
      });
      assert.equal(res.status, 200);
      res = await call(env, ADMIN, 'PUT', '/api/kb/file', {
        repo: 'kb-team-helix', path: 'systemprompt.md', content: 'y', base: file.hash,
      });
      assert.equal(res.status, 409);

      // Concepts are checked like the agents' writes; generated files are refused.
      res = await call(env, ADMIN, 'PUT', '/api/kb/file', { repo: 'kb-team-helix', path: 'notes/x.md', content: 'no frontmatter' });
      assert.equal(res.status, 400);
      res = await call(env, ADMIN, 'PUT', '/api/kb/file', { repo: 'kb-team-helix', path: 'index.md', content: '---\ntype: X\n---\n' });
      assert.match((await res.json()).error, /automatically/);
      res = await call(env, ADMIN, 'PUT', '/api/kb/file', {
        repo: 'kb-team-helix', path: 'notes/x.md', content: '---\ntype: Reference\ntitle: X\n---\nBody\n',
      });
      const concept = await res.json();
      assert.equal(res.status, 200);
      // Each write counts the entries: not the index, the log or the system prompt.
      const entries = () => DB.rows("SELECT entries FROM knowledge_bases WHERE repo = 'kb-team-helix'")[0].entries;
      assert.equal(entries(), 1);
      DB.sqlite.exec('UPDATE knowledge_bases SET entries = NULL');
      assert.deepEqual(await countEntries(env), { counted: 2, failed: 0 });
      assert.deepEqual(DB.rows('SELECT repo, entries FROM knowledge_bases ORDER BY repo'), [
        { repo: 'kb-org-acme', entries: 0 }, { repo: 'kb-team-helix', entries: 1 },
      ]);
      res = await call(env, ADMIN, 'DELETE', '/api/kb/file', { repo: 'kb-team-helix', path: 'notes/x.md', base: concept.hash });
      assert.equal(res.status, 200);
      assert.deepEqual(srv.files('kb-team-helix'), ['index.md', 'log.md', 'systemprompt.md']);
      assert.equal(entries(), 0);

      const { commits } = await (await call(env, ADMIN, 'GET', '/api/kb/log?repo=kb-team-helix')).json();
      assert.deepEqual(commits.map((c) => c.message), ['Delete notes/x.md', 'Update notes/x.md', 'Update systemprompt.md', 'Add agent instructions']);
      assert.ok(commits.every((c) => c.author === 'Ada'));

      // Viewing as someone else is read-only.
      res = await call(env, { ...ADMIN, readonly: true }, 'PUT', '/api/kb/file', { repo: 'kb-team-helix', path: 'a.md', content: 'x' });
      assert.equal(res.status, 403);
    } finally {
      await srv.close();
    }
  });
});

describe('thread agents in the knowledge-base editor', () => {
  it('show each channel\'s thread agent, and let its team\'s managers switch it', async () => {
    const DB = d1({ teams: [{ slug: 'helix', name: 'Helix ops' }, { slug: 'edge', name: 'Edge ops' }, { slug: 'admin', name: 'Admin' }] });
    DB.sqlite.exec(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at) VALUES
        ('kb-org-acme', 'org', 'acme', 'r', '2026-10-22T00:00:00Z'),
        ('kb-team-helix', 'team', 'helix', 'r', '2026-10-22T00:00:00Z'),
        ('kb-team-edge', 'team', 'edge', 'r', '2026-10-22T00:00:00Z');
      INSERT INTO channels (source, tenant, channel_id, name, fetched_at) VALUES
        ('slack', 'E1', 'C1', 'aem-acme', '2026-10-22T00:00:00Z');
      INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind, channel_name,
          path, last_at, any_at, updated_at) VALUES
        ('slack:E1:C1:1', 'slack', 'E1', 'C1', '1', 'acme', 'helix', 'channel', 'aem-acme', 'p', '2026-10-21T00:00:00Z', '2026-10-21T00:00:00Z', '2026-10-21T00:00:00Z'),
        ('slack:E1:C1:2', 'slack', 'E1', 'C1', '2', 'acme', 'helix', 'channel', 'aem-acme', 'p', '2026-10-22T00:00:00Z', '2026-10-22T00:00:00Z', '2026-10-22T00:00:00Z'),
        ('slack:E1:C2:1', 'slack', 'E1', 'C2', '1', 'acme', 'edge', 'channel', 'acme-edge', 'p', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z'),
        ('slack:E1:C3:1', 'slack', 'E1', 'C3', '1', 'acme', 'helix', 'alert', 'acme-alerts', 'p', '2026-10-19T00:00:00Z', '2026-10-19T00:00:00Z', '2026-10-19T00:00:00Z'),
        ('slack:E1:C4:1', 'slack', 'E1', 'C4', '1', 'acme', 'helix', 'ignore', 'acme-random', 'p', '2026-10-19T00:00:00Z', '2026-10-19T00:00:00Z', '2026-10-19T00:00:00Z')`);
    const env = {
      DB, AGENTS: {}, AGENT_MODEL: 'm', AGENT_CHANNELS: 'C2',
    };
    const MANAGER = { ...MEMBER, teams: [{ slug: 'helix', role: 'manager' }] };
    const quietly = async (fn) => {
      const { log } = console;
      console.log = () => {};
      try {
        return await fn();
      } finally {
        console.log = log;
      }
    };

    // The customer's knowledge base, for the admin team: its channels in every team.
    let res = await (await call(env, ADMIN, 'GET', '/api/kb/channels?repo=kb-org-acme')).json();
    assert.equal(res.configured, true);
    const summary = (c) => [
      c.channelId, c.name, c.teamName, c.kind, c.threads, c.agent.enabled, c.may,
    ];
    assert.deepEqual(res.channels.map(summary), [
      ['C1', 'aem-acme', 'Helix ops', 'channel', 2, false, true],
      ['C2', 'acme-edge', 'Edge ops', 'channel', 1, true, true],
      ['C3', 'acme-alerts', 'Helix ops', 'alert', 1, false, false],
    ]);
    assert.equal(res.channels[1].agent.set, false);
    let bases = await (await call(env, ADMIN, 'GET', '/api/kb')).json();
    assert.deepEqual(bases.bases.map((b) => [b.repo, b.agents]), [['kb-team-edge', 1], ['kb-team-helix', 0], ['kb-org-acme', 1]]);

    // A manager of helix sees helix's channels, and switches its agents.
    assert.equal((await call(env, MANAGER, 'GET', '/api/kb/channels?repo=kb-org-acme')).status, 404);
    res = await (await call(env, MANAGER, 'GET', '/api/kb/channels?repo=kb-team-helix')).json();
    assert.deepEqual(res.channels.map((c) => [c.channelId, c.may]), [['C1', true], ['C3', false]]);
    res = await quietly(() => call(env, MANAGER, 'PUT', '/api/kb/agent', { channel: 'C1', enabled: true }));
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).agent, {
      enabled: true, set: true, by: 'Bo', at: DB.rows('SELECT changed_at FROM agent_channels')[0].changed_at, via: null,
    });
    bases = await (await call(env, ADMIN, 'GET', '/api/kb')).json();
    assert.deepEqual(bases.bases.map((b) => [b.repo, b.agents]), [['kb-team-edge', 1], ['kb-team-helix', 1], ['kb-org-acme', 2]]);
    res = await quietly(() => call(env, MANAGER, 'PUT', '/api/kb/agent', { channel: 'C1', enabled: false }));
    assert.equal((await res.json()).agent.enabled, false);
    res = await (await call(env, MANAGER, 'GET', '/api/kb/channels?repo=kb-team-helix')).json();
    assert.deepEqual(res.channels[0].agent.enabled, false);
    assert.equal(res.channels[0].agent.by, 'Bo');

    // Not another team's channel, not an alert or ignored channel, not someone else's view.
    assert.equal((await call(env, MANAGER, 'PUT', '/api/kb/agent', { channel: 'C2', enabled: false })).status, 404);
    assert.equal((await call(env, MANAGER, 'PUT', '/api/kb/agent', { channel: 'C3', enabled: true })).status, 400);
    assert.equal((await call(env, MANAGER, 'PUT', '/api/kb/agent', { channel: 'C4', enabled: true })).status, 404);
    assert.equal((await call(env, MANAGER, 'PUT', '/api/kb/agent', { channel: 'C1', enabled: 'yes' })).status, 400);
    assert.equal((await call(env, MEMBER, 'PUT', '/api/kb/agent', { channel: 'C1', enabled: true })).status, 403);
    assert.equal((await call(env, { ...MANAGER, readonly: true }, 'PUT', '/api/kb/agent', { channel: 'C1', enabled: true })).status, 403);

    // The admin team switches any channel, the default one off too.
    res = await quietly(() => call(env, ADMIN, 'PUT', '/api/kb/agent', { channel: 'C2', enabled: false }));
    assert.equal(res.status, 200);
    res = await (await call(env, ADMIN, 'GET', '/api/kb/channels?repo=kb-team-edge')).json();
    assert.deepEqual(res.channels.map((c) => [c.channelId, c.agent.enabled, c.agent.set]), [['C2', false, true]]);

    // A team's default: its channels nobody switched have agents, the switched ones keep theirs.
    res = await (await call(env, MANAGER, 'GET', '/api/kb/channels?repo=kb-team-helix')).json();
    assert.deepEqual(res.teamDefault, {
      enabled: false, by: null, at: null, may: true,
    });
    assert.equal((await (await call(env, ADMIN, 'GET', '/api/kb/channels?repo=kb-org-acme')).json()).teamDefault, null);
    DB.sqlite.exec(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind,
        channel_name, path, last_at, any_at, updated_at) VALUES
      ('slack:E1:C5:1', 'slack', 'E1', 'C5', '1', 'initech', 'helix', 'channel', 'aem-initech', 'p',
        '2026-10-23T00:00:00Z', '2026-10-23T00:00:00Z', '2026-10-23T00:00:00Z')`);
    assert.equal((await call(env, MANAGER, 'PUT', '/api/kb/agent', { team: 'edge', enabled: true })).status, 404);
    assert.equal((await call(env, MANAGER, 'PUT', '/api/kb/agent', { team: 'helix', enabled: 'yes' })).status, 400);
    res = await quietly(() => call(env, MANAGER, 'PUT', '/api/kb/agent', { team: 'helix', enabled: true }));
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).teamDefault.enabled, true);
    res = await (await call(env, MANAGER, 'GET', '/api/kb/channels?repo=kb-team-helix')).json();
    assert.equal(res.teamDefault.by, 'Bo');
    assert.deepEqual(res.channels.map((c) => [c.channelId, c.agent.enabled, c.agent.via]), [
      ['C5', true, 'team'], ['C1', false, null], ['C3', false, null],
    ]);
    assert.equal(await agentEnabled(env, 'C5', 'helix'), true);
    assert.equal(await agentEnabled(env, 'C5'), true);
    assert.equal(await agentEnabled(env, 'C1', 'helix'), false);
    bases = await (await call(env, ADMIN, 'GET', '/api/kb')).json();
    assert.deepEqual(bases.bases.map((b) => [b.repo, b.agents]), [['kb-team-edge', 0], ['kb-team-helix', 1], ['kb-org-acme', 0]]);
    await quietly(() => call(env, MANAGER, 'PUT', '/api/kb/agent', { team: 'helix', enabled: false }));
    assert.equal(await agentEnabled(env, 'C5', 'helix'), false);
  });

  it('list the knowledge bases with their entries and the tools turned on', async () => {
    const DB = d1({ teams: [{ slug: 'helix', name: 'Helix ops' }, { slug: 'admin', name: 'Admin' }] });
    DB.sqlite.exec(`INSERT INTO knowledge_bases (repo, kind, slug, remote, created_at, entries) VALUES
        ('kb-org-acme', 'org', 'acme', 'r', '2026-10-22T00:00:00Z', 3),
        ('kb-org-initech', 'org', 'initech', 'r', '2026-10-22T00:00:00Z', NULL),
        ('kb-team-helix', 'team', 'helix', 'r', '2026-10-22T00:00:00Z', 0);
      INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind, channel_name,
          path, last_at, any_at, updated_at) VALUES
        ('slack:E1:C1:1', 'slack', 'E1', 'C1', '1', 'acme', 'helix', 'channel', 'aem-acme', 'p', '2026-10-21T00:00:00Z', '2026-10-21T00:00:00Z', '2026-10-21T00:00:00Z'),
        ('slack:E1:C2:1', 'slack', 'E1', 'C2', '1', 'initech', 'helix', 'channel', 'aem-initech', 'p', '2026-10-21T00:00:00Z', '2026-10-21T00:00:00Z', '2026-10-21T00:00:00Z');
      INSERT INTO agent_tool_switches (tool, scope, target, enabled, changed_at) VALUES
        ('computer', 'team', 'helix', 1, 'x'), ('post_message', 'channel', 'C2', 1, 'x'),
        ('computer', 'channel', 'C2', 1, 'x'), ('post_message', 'channel', 'C1', 0, 'x');
      INSERT INTO mcp_global_switches (server, scope, target, enabled, changed_at) VALUES
        ('browser', 'channel', 'C1', 1, 'x');
      INSERT INTO mcp_servers (scope, slug, name, url, enabled, updated_at) VALUES
        ('org', 'acme', 'status', 'https://s.example/mcp', 0, 'x'),
        ('org', 'initech', 'docs', 'https://d.example/mcp', 1, 'x')`);
    const bases = await (await call({ DB }, ADMIN, 'GET', '/api/kb')).json();
    assert.deepEqual(bases.bases.map((b) => [b.repo, b.entries, b.tools]), [
      ['kb-team-helix', 0, 3], ['kb-org-acme', 3, 1], ['kb-org-initech', null, 3],
    ]);
  });
});
