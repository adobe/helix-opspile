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
  ensureChannelKnowledgeBases, ensureKnowledgeBase, ensureTeamKnowledgeBases, repoName,
} from '../src/kb.js';
import { d1 } from './d1.js';
import { fakeArtifacts, quiet } from './fakes.js';

const REMOTE = (name) => `https://account.artifacts.example/git/ns/${name}.git`;

const env = (artifacts, teams = []) => ({ ARTIFACTS: artifacts, DB: d1({ teams }) });

describe('knowledge bases', () => {
  it('names repos after org and team slugs, never internal ones', () => {
    assert.equal(repoName('org', 'acme'), 'kb-org-acme');
    assert.equal(repoName('team', 'helix'), 'kb-team-helix');
    assert.equal(repoName('org', '_unassigned'), null);
    assert.equal(repoName('org', ''), null);
  });

  it('creates a repo once and records it', async () => {
    const e = env(fakeArtifacts());
    const now = new Date('2026-10-22T10:00:00Z');
    assert.deepEqual(await ensureKnowledgeBase(e, 'org', 'acme', now), { repo: 'kb-org-acme', result: 'created' });
    assert.deepEqual(await ensureKnowledgeBase(e, 'org', 'acme', now), { repo: 'kb-org-acme', result: 'exists' });
    assert.deepEqual(e.ARTIFACTS.calls, [['create', 'kb-org-acme', {
      description: 'opspile knowledge base: org acme', setDefaultBranch: 'main',
    }]]);
    assert.deepEqual(e.DB.rows('SELECT * FROM knowledge_bases'), [{
      repo: 'kb-org-acme', kind: 'org', slug: 'acme', remote: REMOTE('kb-org-acme'), created_at: now.toISOString(),
    }]);
  });

  it('records a repo that exists in Artifacts but not in D1', async () => {
    const e = env(fakeArtifacts({ existing: ['kb-team-helix'] }));
    assert.deepEqual(await ensureKnowledgeBase(e, 'team', 'helix'), { repo: 'kb-team-helix', result: 'exists' });
    assert.deepEqual(e.DB.rows('SELECT remote FROM knowledge_bases'), [{ remote: REMOTE('kb-team-helix') }]);
  });

  it('does nothing without the binding or for internal slugs', async () => {
    assert.equal(await ensureKnowledgeBase(env(undefined), 'org', 'acme'), null);
    const e = env(fakeArtifacts());
    assert.equal(await ensureKnowledgeBase(e, 'org', '_unassigned'), null);
    assert.deepEqual(await ensureChannelKnowledgeBases(env(undefined), { org: 'acme', team: 'helix' }), []);
    assert.equal(e.ARTIFACTS.calls.length, 0);
  });

  it('gives a channel its org and team repos, asking once per batch', async () => {
    const e = env(fakeArtifacts());
    const cache = {};
    const first = await ensureChannelKnowledgeBases(e, { org: 'acme', team: 'helix' }, cache);
    assert.deepEqual(first.map((r) => r.repo), ['kb-org-acme', 'kb-team-helix']);
    assert.deepEqual(await ensureChannelKnowledgeBases(e, { org: 'acme', team: 'helix' }, cache), []);
    assert.deepEqual(await ensureChannelKnowledgeBases(e, { org: 'acme', team: 'helix' }, {}), []);
    await ensureChannelKnowledgeBases(e, { org: '_unassigned', team: 'helix' }, {});
    assert.equal(e.ARTIFACTS.calls.length, 2);
  });

  it('logs a failure instead of failing the message, and tries again later', async () => {
    const e = env(fakeArtifacts({ fail: true }));
    const r = await quiet(() => ensureChannelKnowledgeBases(e, { org: 'acme', team: 'helix' }));
    assert.deepEqual(r, []);
    assert.deepEqual(e.DB.rows('SELECT * FROM knowledge_bases'), []);
  });

  it('gives every team a repo from the cron, including teams added by hand', async () => {
    const e = env(fakeArtifacts(), [{ slug: 'helix', name: 'Helix' }, { slug: 'admin', name: 'Admin' }]);
    assert.deepEqual(await ensureTeamKnowledgeBases(e), { created: 2 });
    assert.deepEqual(await ensureTeamKnowledgeBases(e), { created: 0 });
    assert.deepEqual([...e.ARTIFACTS.repos].sort(), ['kb-team-admin', 'kb-team-helix']);
    assert.deepEqual(await ensureTeamKnowledgeBases(env(undefined)), { created: 0 });
  });
});
