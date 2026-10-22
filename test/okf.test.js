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
import git from 'isomorphic-git';
import { checkChanges, commitChanges, writeKnowledge } from '../src/agent/kbwrite.js';
import { memfs } from '../src/agent/memfs.js';
import {
  addLogEntry, checkConcept, renderIndex, scalar, splitFrontmatter, stampGenerated,
} from '../src/agent/okf.js';
import { gitServer, hasGit } from './git-server.js';

const CONCEPT = `---
type: Known Issue
title: "CDN purge delay"
description: Purges take up to a minute to reach every edge.
sources:
  - id: t1
    resource: https://chat.example/archives/C1/p1
---

Purges are eventually consistent.[^t1]
`;

describe('OKF', () => {
  it('reads the frontmatter scalars a concept needs', () => {
    const fm = splitFrontmatter(CONCEPT);
    assert.equal(scalar(fm.yaml, 'type'), 'Known Issue');
    assert.equal(scalar(fm.yaml, 'title'), 'CDN purge delay');
    assert.equal(scalar(fm.yaml, 'description'), 'Purges take up to a minute to reach every edge.');
    assert.equal(scalar(fm.yaml, 'sources'), null);
    assert.match(fm.body, /eventually consistent/);
    assert.equal(splitFrontmatter('# no frontmatter'), null);
  });

  it('accepts concepts and refuses what is not one', () => {
    assert.equal(checkConcept('issues/cdn-purge-delay.md', CONCEPT), null);
    assert.match(checkConcept('issues/x.md', '# hello'), /frontmatter/);
    assert.match(checkConcept('issues/x.md', '---\ntitle: x\n---\n'), /type/);
    assert.match(checkConcept('index.md', CONCEPT), /automatically/);
    assert.match(checkConcept('issues/log.md', CONCEPT), /automatically/);
    assert.match(checkConcept('../escape.md', CONCEPT), /paths/);
    assert.match(checkConcept('Issues/X.md', CONCEPT), /paths/);
    assert.match(checkConcept('issues/x.txt', CONCEPT), /paths/);
    assert.match(checkConcept('/abs.md', CONCEPT), /paths/);
  });

  it('stamps who wrote a concept, replacing an earlier stamp', () => {
    const once = stampGenerated(CONCEPT, 'opspile-agent/m', '2026-10-22T10:00:00Z');
    assert.match(once, /^generated: \{ by: opspile-agent\/m, at: 2026-10-22T10:00:00Z \}$/m);
    const block = once.replace(/^generated:.*$/m, 'generated:\n  by: human:ada\n  at: 2026-01-01T00:00:00Z');
    const twice = stampGenerated(block, 'opspile-agent/m', '2026-10-23T10:00:00Z');
    assert.equal((twice.match(/generated/g) || []).length, 1);
    assert.doesNotMatch(twice, /human:ada/);
    assert.match(twice, /eventually consistent/);
  });

  it('writes index files with titles, types and descriptions', () => {
    const index = renderIndex('', [
      { name: 'b.md', yaml: 'type: Site\ntitle: Main site\ndescription: The www site.' },
      { name: 'a-thing.md', yaml: 'type: Reference' },
      { name: 'issues', dir: true, count: 2 },
    ], { root: true });
    assert.match(index, /^---\nokf_version: "0.2"\n---/);
    assert.match(index, /\* \[a thing\]\(a-thing\.md\) \(Reference\)\n\* \[Main site\]\(b\.md\) \(Site\) - The www site\./);
    assert.match(index, /# Directories\n\n\* \[issues\]\(issues\/\) - 2 concepts/);
  });

  it('keeps the log newest first, one heading per day', () => {
    let log = addLogEntry('', '2026-10-21', '**Update**: first');
    log = addLogEntry(log, '2026-10-22', '**Update**: second');
    log = addLogEntry(log, '2026-10-22', '**Update**: third');
    assert.equal(log, '# Update log\n\n## 2026-10-22\n* **Update**: third\n* **Update**: second\n\n## 2026-10-21\n* **Update**: first\n');
  });
});

async function emptyRepo() {
  const fs = memfs();
  await fs.mkdirp('/kb');
  await git.init({ fs, dir: '/kb', defaultBranch: 'main' });
  return fs;
}

const OPTS = {
  message: 'Add CDN purge delay', by: 'opspile-agent/m', at: '2026-10-22T10:00:00.000Z', logEntry: '**Update**: Add CDN purge delay (thread x)',
};

describe('knowledge base writes', () => {
  it('checks a change set before cloning anything', () => {
    assert.match(checkChanges([]), /at least one/);
    assert.match(checkChanges([{ path: 'a.md', content: '# x' }]), /frontmatter/);
    assert.match(checkChanges([{ path: 'index.md', delete: true }]), /automatically/);
    assert.match(checkChanges([{ path: 'a.md', content: CONCEPT }, { path: 'a.md', delete: true }]), /twice/);
    assert.equal(checkChanges([{ path: 'a.md', content: CONCEPT }, { path: 'b.md', delete: true }]), null);
  });

  it('commits a concept with the index and log written by code', async () => {
    const fs = await emptyRepo();
    const r = await commitChanges(fs, [{ path: 'issues/cdn-purge-delay.md', content: CONCEPT }], OPTS);
    assert.match(r.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(await git.listFiles({ fs, dir: '/kb' }), [
      'index.md', 'issues/cdn-purge-delay.md', 'issues/index.md', 'log.md',
    ]);
    const concept = await fs.promises.readFile('/kb/issues/cdn-purge-delay.md', 'utf8');
    assert.match(concept, /generated: \{ by: opspile-agent\/m, at: 2026-10-22T10:00:00.000Z \}/);
    assert.match(await fs.promises.readFile('/kb/issues/index.md', 'utf8'), /\[CDN purge delay\]\(cdn-purge-delay\.md\) \(Known Issue\) - Purges take/);
    assert.match(await fs.promises.readFile('/kb/index.md', 'utf8'), /\[issues\]\(issues\/\) - 1 concept$/m);
    assert.match(await fs.promises.readFile('/kb/log.md', 'utf8'), /## 2026-10-22\n\* \*\*Update\*\*: Add CDN purge delay \(thread x\)/);
    const [c] = await git.log({ fs, dir: '/kb' });
    assert.equal(c.commit.author.email, 'agent@opspile.invalid');
  });

  it('refuses to overwrite a file that changed since it was read', async () => {
    const fs = await emptyRepo();
    await commitChanges(fs, [{ path: 'a.md', content: CONCEPT }], OPTS);
    const current = (await git.hashBlob({ object: await fs.promises.readFile('/kb/a.md') })).oid;
    const stale = await commitChanges(fs, [{ path: 'a.md', content: CONCEPT, base: '0'.repeat(40) }], OPTS);
    assert.match(stale.conflict, /changed since you read it/);
    const ok = await commitChanges(fs, [{ path: 'a.md', content: CONCEPT.replace('minute', 'second'), base: current }], OPTS);
    assert.ok(ok.commit);
  });

  it('removes the index of a directory that a delete left empty', async () => {
    const fs = await emptyRepo();
    await commitChanges(fs, [{ path: 'issues/a.md', content: CONCEPT }], OPTS);
    const r = await commitChanges(fs, [{ path: 'issues/a.md', delete: true }], { ...OPTS, logEntry: 'gone' });
    assert.ok(r.commit);
    assert.deepEqual(await git.listFiles({ fs, dir: '/kb' }), ['index.md', 'log.md']);
    assert.match(await fs.promises.readFile('/kb/index.md', 'utf8'), /Nothing here yet/);
    const missing = await commitChanges(fs, [{ path: 'issues/a.md', delete: true }], OPTS);
    assert.match(missing.conflict, /does not exist/);
  });
});

describe('knowledge base writes over git', { skip: !hasGit() && 'git is not installed' }, () => {
  it('clones, commits and pushes; an empty repo gets its first commit', async () => {
    const srv = await gitServer();
    try {
      srv.create('kb-team-helix');
      const env = { ARTIFACTS: srv.artifacts };
      const first = await writeKnowledge(env, 'kb-team-helix', [{ path: 'playbooks/purge.md', content: CONCEPT }], OPTS);
      assert.equal(first.commit, srv.head('kb-team-helix'));
      assert.deepEqual(srv.files('kb-team-helix'), ['index.md', 'log.md', 'playbooks/index.md', 'playbooks/purge.md']);
      const second = await writeKnowledge(env, 'kb-team-helix', [{ path: 'playbooks/other.md', content: CONCEPT }], { ...OPTS, logEntry: 'two' });
      assert.equal(second.commit, srv.head('kb-team-helix'));
      assert.match(srv.show('kb-team-helix', 'playbooks/index.md'), /other\.md[\s\S]*purge\.md/);
      assert.match(srv.show('kb-team-helix', 'log.md'), /\* two\n\* \*\*Update\*\*/);
      assert.ok(srv.seen.every((a) => a === 'Bearer art_v1_made-up?expires=1'));
    } finally {
      await srv.close();
    }
  });

  it('starts over from the other writer\'s commit when its push is rejected', async () => {
    const srv = await gitServer();
    try {
      srv.create('kb-org-acme');
      const env = { ARTIFACTS: srv.artifacts };
      await writeKnowledge(env, 'kb-org-acme', [{ path: 'a.md', content: CONCEPT }], OPTS);
      // Another agent pushes between our clone and our push.
      const realGet = srv.artifacts.get;
      let raced = false;
      env.ARTIFACTS = {
        async get(name) {
          const repo = await realGet(name);
          return {
            ...repo,
            log: async () => {
              const r = await repo.log();
              if (!raced) {
                raced = true;
                srv.commitElsewhere(name, 'b.md', CONCEPT);
              }
              return r;
            },
          };
        },
      };
      const r = await writeKnowledge(env, 'kb-org-acme', [{ path: 'c.md', content: CONCEPT }], { ...OPTS, logEntry: 'mine' });
      assert.equal(r.commit, srv.head('kb-org-acme'));
      assert.deepEqual(srv.files('kb-org-acme'), ['a.md', 'b.md', 'c.md', 'index.md', 'log.md']);
      assert.match(srv.show('kb-org-acme', 'index.md'), /b\.md/);
    } finally {
      await srv.close();
    }
  });
});
