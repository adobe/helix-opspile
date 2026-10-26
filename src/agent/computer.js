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

import {
  err, ExecutionError, FileError, ok,
} from '@earendil-works/pi-durable/env';

/**
 * The agent's computer (its `computer` tool): pi's own `bash` tool, run on Cloudflare
 * Computer (@cloudflare/computer). The ThreadAgent object holds a Workspace, a filesystem in
 * its own SQLite, with a WorkerShellBackend: just-bash in a Dynamic Worker (env.LOADER) that
 * reads and writes that filesystem over RPC, with jq and curl, and the Dynamic Worker's own
 * network access (egress `direct`, no filter). Each thread keeps its files from one turn to
 * the next, under COMPUTER_CWD.
 *
 * This file is the bridge: an ExecutionEnv for pi-durable whose `exec` runs a command on the
 * workspace. pi's file tools (read, write, edit) are not installed, so the rest of the
 * environment says `not_supported`; the agent works on its files with the shell.
 */

export const COMPUTER_CWD = '/workspace';

const unsupported = async (path) => err(new FileError('not_supported', 'only the shell is available; use bash', path));

/**
 * An ExecutionEnv over `workspace()`, which resolves to a Workspace (or anything with
 * `runtime.exec(source, options)` as @cloudflare/computer's): created on first use.
 */
export function computerEnv(workspace, { id = 'computer' } = {}) {
  return {
    id,
    cwd: COMPUTER_CWD,
    async exec(command, options = {}, context = undefined) {
      if (typeof command !== 'string') {
        return err(new ExecutionError('spawn_error', 'only shell commands run here'));
      }
      if (context && context.abortSignal && context.abortSignal.aborted) {
        return err(new ExecutionError('aborted', 'aborted'));
      }
      let result;
      try {
        const ws = await workspace();
        const run = await ws.runtime.exec(command, {
          cwd: options.cwd || COMPUTER_CWD,
          encoding: 'utf8',
          ...(options.env && Object.keys(options.env).length ? { env: options.env } : {}),
          ...(options.timeout ? { timeoutMs: Math.round(options.timeout * 1000) } : {}),
        });
        try {
          result = await run.result();
        } finally {
          if (run[Symbol.dispose]) {
            run[Symbol.dispose]();
          }
        }
      } catch (e) {
        return err(new ExecutionError('unknown', `the computer failed: ${e.message}`));
      }
      // just-bash answers at the end of a run, stdout first; the window is the tool's.
      const info = (stream) => ({ stream });
      if (result.stdout && options.onOutput) {
        options.onOutput(result.stdout, context, info('stdout'));
      }
      if (result.stderr && options.onOutput) {
        options.onOutput(result.stderr, context, info('stderr'));
      }
      // The shell's answer to a run it stopped at `timeoutMs`.
      if (options.timeout && result.exitCode === 124) {
        return err(new ExecutionError('timeout', 'timed out'));
      }
      const saved = result.truncated && (result.truncated.stdout || result.truncated.stderr);
      return ok({ exitCode: result.exitCode, ...(saved ? { spillPath: saved.path } : {}) });
    },
    // Nothing runs after a command: just-bash answers at the end of each.
    cleanup: async () => undefined,
    absolutePath: async (path) => ok(path.startsWith('/') ? path : `${COMPUTER_CWD}/${path}`),
    joinPath: async (parts) => ok(parts.join('/').replace(/\/+/g, '/')),
    readTextFile: unsupported,
    openTextLineReader: unsupported,
    readTextLines: unsupported,
    readBinaryFile: unsupported,
    openBinaryReader: unsupported,
    writeFile: unsupported,
    appendFile: unsupported,
    truncateFile: unsupported,
    flushFile: unsupported,
    renameFile: unsupported,
    fileInfo: unsupported,
    listDir: unsupported,
    openDirReader: unsupported,
    watch: unsupported,
    canonicalPath: unsupported,
    exists: unsupported,
    createDir: unsupported,
    remove: unsupported,
    createTempDir: unsupported,
    createTempFile: unsupported,
  };
}
