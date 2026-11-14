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

import { DEFAULT_IMAGE, isImageName } from './image.js';

/**
 * The second shell of the agents' computers (the `computer` tool, src/agent/computer.js): GNU
 * bash and real programs on the SLICC kernel (@ai-ecoverse/slicc-kernel/cloudflare), where a
 * team chose it over just-bash (`shellFor`, the knowledge-base editor's Computer tool).
 *
 * The kernel runs in the ThreadAgent object, its processes in Dynamic Workers (env.LOADER)
 * that have no network of their own. It is a backend of the same Workspace as just-bash
 * (`sliccBackend`), so the thread's files are the same ones, mounted at /workspace, the
 * uploads among them. The kernel's own root (/root, /tmp, /etc, and its programs under
 * /node_modules) is in the object's SQLite too, in tables of its own (`slicc_*`).
 *
 * Its programs are an image (src/agent/image.js): the team's choice among those in the
 * `IMAGES` bucket, a stack of layers the kernel mounts read-only when it boots (`imageSpec`).
 * The agent's object keeps no copy of it.
 *
 * Its programs reach the network through the kernel's proxy, which hands every request to a
 * transport: here `gatewayFetch`, the same `forward` as just-bash's SecretGateway
 * (src/agent/secrets.js), so the team's secrets go in where a request names them, and nowhere
 * else. Redirects are the program's to follow (curl -L), each hop through the gateway again.
 *
 * This file has what needs no Workers runtime, so that it is tested in Node; the kernel
 * itself is made in src/agent/agent.js.
 */

export const RUNTIMES = [
  {
    runtime: 'just-bash',
    title: 'just-bash',
    description: 'A bash interpreter in JavaScript, with its own cat, grep, sed, awk, jq, rg and'
      + ' curl. It has no real programs: what is not built in does not run.',
  },
  {
    runtime: 'slicc-kernel',
    title: 'SLICC kernel (experimental)',
    description: 'GNU bash with real programs (WebAssembly), with processes, pipes and signals,'
      + ' on the same files, with curl and the secrets as in just-bash. Which programs is the'
      + ' image\'s choice, below. A command takes about a tenth of a second longer.',
  },
];
export const DEFAULT_RUNTIME = 'just-bash';
export const isRuntime = (runtime) => RUNTIMES.some((r) => r.runtime === runtime);

/** An option of a team's Computer tool (`agent_tool_options`): its row, or null. */
const option = async (env, team, name) => (team && env.DB ? env.DB.prepare(`SELECT value,
    changed_by, changed_at FROM agent_tool_options WHERE tool = 'computer' AND team = ?
    AND name = ?`).bind(team, name).first() : null);

async function setOption(env, {
  team, name, value, by,
}) {
  const at = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO agent_tool_options (tool, team, name, value, changed_by,
      changed_at) VALUES ('computer', ?, ?, ?, ?, ?)
    ON CONFLICT (tool, team, name) DO UPDATE SET value = excluded.value,
      changed_by = excluded.changed_by, changed_at = excluded.changed_at`)
    .bind(team, name, value, by, at).run();
  return { by, at };
}

/**
 * The shell of a team's computers: `{ runtime, by, at }`, `by` and `at` only once someone
 * chose. A value this deployment does not know (an older one, after a rollback) is the default.
 */
export async function teamRuntime(env, team) {
  const row = await option(env, team, 'runtime');
  return row && isRuntime(row.value)
    ? { runtime: row.value, by: row.changed_by, at: row.changed_at }
    : { runtime: DEFAULT_RUNTIME };
}

/** Sets the shell of a team's computers, as `by` (a name), now: `{ runtime, by, at }`. */
export async function setTeamRuntime(env, { team, runtime, by }) {
  return {
    runtime,
    ...await setOption(env, {
      team, name: 'runtime', value: runtime, by,
    }),
  };
}

/**
 * The image of a team's computers on the kernel (src/agent/image.js): `{ image, by, at }`,
 * `by` and `at` only once someone chose. Whether the bucket has it is asked where it is used.
 */
export async function teamImage(env, team) {
  const row = await option(env, team, 'image');
  return row && isImageName(row.value)
    ? { image: row.value, by: row.changed_by, at: row.changed_at }
    : { image: DEFAULT_IMAGE };
}

/** Sets the image of a team's computers, as `by` (a name), now: `{ image, by, at }`. */
export async function setTeamImage(env, { team, image, by }) {
  return {
    image,
    ...await setOption(env, {
      team, name: 'image', value: image, by,
    }),
  };
}

/**
 * The shell of an agent's computer, by its target's team (src/agent/agent.js `target`):
 * `{ runtime, image }`, `image` only with the kernel.
 */
export async function shellFor(env, target) {
  const team = target && target.team;
  const { runtime } = await teamRuntime(env, team);
  return runtime === 'slicc-kernel'
    ? { runtime, image: (await teamImage(env, team)).image } : { runtime };
}

/** `shellFor`'s runtime alone. */
export async function runtimeFor(env, target) {
  return (await shellFor(env, target)).runtime;
}

/**
 * The `fetch` of the kernel's transport (`fetchTransport({ fetch })`) over `send`, which
 * answers a Request with a Response (the gateway's `forward`). The transport asks as a page
 * would (`mode`, `credentials`), which Workers do not take.
 */
export function gatewayFetch(send) {
  return (url, init = {}) => {
    const rest = { ...init };
    delete rest.mode;
    delete rest.credentials;
    return send(new Request(url, rest));
  };
}

/**
 * Where and as what a kernel mounts `image` (a manifest) at `target`: read-only, named by the
 * image and the start of its digest, as `/proc/mounts` and `df` show it. The agent's object
 * serves it (`imageDriver`, src/agent/image.js) through the kernel's `inProcessMount`.
 */
export function imageSpec(image, target) {
  return {
    type: 'image',
    source: `${image.name}@${image.digest.slice(0, 12)}`,
    target,
    options: { ro: '' },
  };
}

/**
 * `fs` (a Workspace's) whose `mkdir -p` of a directory that is there does nothing. The
 * kernel's driver makes its mount point that way with every connection, and a Workspace
 * refuses any change to a directory a read-only mount is in, even that one (EROFS): the
 * uploads are such a mount in /workspace (see `ensureCwd`, src/agent/computer.js).
 */
export function patientFs(fs) {
  const mkdir = async (path, options) => {
    if (options && options.recursive) {
      try {
        if ((await fs.stat(path)).isDirectory) {
          return undefined;
        }
      } catch (e) {
        if (e.code !== 'ENOENT') {
          throw e;
        }
      }
    }
    return fs.mkdir(path, options);
  };
  return new Proxy(fs, {
    get(target, prop) {
      if (prop === 'mkdir') {
        return mkdir;
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** `backend` (the kernel's `sliccBackend`), connected to a Workspace through `patientFs`. */
export function overWorkspace(backend) {
  return {
    id: backend.id,
    type: backend.type,
    callable: backend.callable,
    description: backend.description,
    connect: (host) => backend.connect(new Proxy(host, {
      get: (target, prop) => (prop === 'fs' ? patientFs(target.fs) : Reflect.get(target, prop)),
    })),
  };
}

/** How the kernel ends a run whose time is up: bash, by SIGTERM, and by SIGKILL after it. */
const KILLED = [143, 137];

/**
 * Whether the shell stopped a run at `timeout` (seconds), which took `seconds`. just-bash
 * answers 124 and its word is taken (a person's run also asks whether the time was up,
 * src/agent/bashrequest.js). The kernel only ends bash with a signal, as a command can end by
 * itself: its exit code says so, and its time was up.
 */
export function timedOut(runtime, exitCode, seconds, timeout) {
  return runtime === 'slicc-kernel'
    ? KILLED.includes(exitCode) && seconds >= timeout
    : exitCode === 124;
}
