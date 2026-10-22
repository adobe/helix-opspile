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

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A git smart-HTTP server on localhost (`git http-backend`), standing in for an Artifacts
 * remote, plus an Artifacts-shaped binding over its bare repositories. Only for tests.
 */
export function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function gitServer() {
  const root = mkdtempSync(join(tmpdir(), 'opspile-git-'));
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization || null);
    const url = new URL(req.url, 'http://localhost');
    const cgi = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.receivepack',
        GIT_CONFIG_VALUE_0: 'true',
        REQUEST_METHOD: req.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] || '',
        REMOTE_USER: 'test',
        REMOTE_ADDR: '127.0.0.1',
      },
    });
    req.pipe(cgi.stdin);
    const chunks = [];
    cgi.stdout.on('data', (c) => chunks.push(c));
    cgi.on('close', () => {
      const out = Buffer.concat(chunks);
      const split = out.indexOf('\r\n\r\n');
      const head = out.subarray(0, split).toString();
      let status = 200;
      const headers = {};
      for (const line of head.split('\r\n')) {
        const i = line.indexOf(':');
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') {
          status = Number(v.split(' ')[0]);
        } else if (k) {
          headers[k] = v;
        }
      }
      res.writeHead(status, headers);
      res.end(out.subarray(split + 4));
    });
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const bare = (name) => join(root, `${name}.git`);
  function create(name) {
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare(name)]);
  }
  const head = (name) => {
    try {
      return execFileSync('git', ['-C', bare(name), 'rev-parse', 'main'], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim();
    } catch {
      return null;
    }
  };
  const show = (name, path) => execFileSync('git', ['-C', bare(name), 'show', `main:${path}`]).toString();
  const files = (name) => execFileSync('git', ['-C', bare(name), 'ls-tree', '-r', '--name-only', 'main'])
    .toString().trim().split('\n')
    .filter(Boolean);

  /** Commits a file to the bare repo from outside, like another agent would. */
  function commitElsewhere(name, path, content) {
    const work = mkdtempSync(join(tmpdir(), 'opspile-work-'));
    execFileSync('git', ['clone', '-q', bare(name), work]);
    execFileSync('sh', ['-c', `mkdir -p "$(dirname "${path}")" && cat > "${path}"`], { cwd: work, input: content });
    execFileSync('git', ['-c', 'user.name=other', '-c', 'user.email=other@example.invalid', 'add', '--', path], { cwd: work });
    execFileSync('git', ['-c', 'user.name=other', '-c', 'user.email=other@example.invalid', 'commit', '-q', '-m', 'elsewhere'], { cwd: work });
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: work });
    rmSync(work, { recursive: true, force: true });
  }

  const artifacts = {
    async get(name) {
      return {
        info: async () => ({ name, remote: `${base}/${name}.git` }),
        createToken: async () => ({ plaintext: 'art_v1_made-up?expires=1' }),
        log: async () => (head(name) ? [{ hash: head(name) }] : []),
        [Symbol.dispose]() {},
      };
    },
  };

  return {
    base,
    seen,
    artifacts,
    create,
    head,
    show,
    files,
    commitElsewhere,
    async close() {
      await new Promise((resolve) => {
        server.close(resolve);
      });
      rmSync(root, { recursive: true, force: true });
    },
  };
}
