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
import { api } from '../src/api.js';
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
      res = await call(env, ADMIN, 'DELETE', '/api/kb/file', { repo: 'kb-team-helix', path: 'notes/x.md', base: concept.hash });
      assert.equal(res.status, 200);
      assert.deepEqual(srv.files('kb-team-helix'), ['index.md', 'log.md', 'systemprompt.md']);

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
