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
 * uploads among them, read-only, in a mount of their own (`overWorkspace`). The kernel's own
 * root (/root, /tmp, /etc, and its programs under /node_modules) is in the object's SQLite
 * too, in tables of its own (`slicc_*`).
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
 * Where and as what a kernel mounts one of the Workspace's read-only mounts, at `root` (the
 * uploads): read-only, the Workspace's own files there. `overWorkspace` mounts it.
 */
export function readOnlySpec(root) {
  return {
    type: 'workspace',
    source: `workspace:${root}`,
    target: root,
    options: { ro: '' },
  };
}

/** The roots of a Workspace's `mounts` (its option) that are read-only. */
export function readOnlyRoots(mounts = {}) {
  return Object.entries(mounts)
    .filter(([, mount]) => mount && mount.mode === 'read-only')
    .map(([root]) => root);
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

/** The read-only mounts `overWorkspace` made in a kernel: `{ owner, targets }`. */
const readOnlyMounts = new WeakMap();

/**
 * Takes the read-only mounts of `kernel` away, those of the connection `owner` only when it
 * is given: the targets that are still mounted (one in use stays).
 */
async function unmountReadOnly(kernel, owner) {
  const held = readOnlyMounts.get(kernel);
  if (!held || (owner && held.owner !== owner)) {
    return [];
  }
  readOnlyMounts.delete(kernel);
  const left = [];
  for (const target of held.targets) {
    // eslint-disable-next-line no-await-in-loop
    await kernel.umount(target).catch(() => left.push(target));
  }
  return left;
}

async function isDirectory(fs, path) {
  try {
    return Boolean((await fs.stat(path)).isDirectory);
  } catch (e) {
    if (e.code === 'ENOENT') {
      return false;
    }
    throw e;
  }
}

/**
 * `backend` (the kernel's `sliccBackend`), connected to a Workspace through `patientFs`.
 *
 * The Workspace's read-only mounts (`readOnly`, their roots: the uploads) are mounts of their
 * own in the kernel, read-only (`readOnlySpec`), over the same files: `workspaceDriver` and
 * `inProcessMount` are the kernel's (@ai-ecoverse/slicc-kernel/cloudflare), and `kernel` the
 * backend's. The backend's own mount would open a file there for writing and fail only when it
 * is closed, which is too late: bash does not look at what `close` answers, so
 * `echo x > uploads/a.log` exited 0 and said nothing. The kernel refuses a read-only mount's
 * changes where they start, as Linux does (EROFS: "Read-only file system"). Each connection
 * mounts them anew, after the backend closed the one before it, and takes them away when it
 * is closed.
 */
export function overWorkspace(backend, {
  readOnly = [], kernel, workspaceDriver, inProcessMount,
} = {}) {
  const mountReadOnly = async (k, fs, owner) => {
    const left = await unmountReadOnly(k);
    const held = { owner, targets: [] };
    readOnlyMounts.set(k, held);
    for (const root of readOnly) {
      // A mount still in use is still read-only, over the same files.
      // eslint-disable-next-line no-await-in-loop
      if (!left.includes(root) && await isDirectory(fs, root)) {
        const driver = workspaceDriver(fs, { root });
        // eslint-disable-next-line no-await-in-loop
        await k.mount(inProcessMount(readOnlySpec(root), {
          handlers: driver, capabilities: driver.capabilities, served: driver.served,
        }));
        held.targets.push(root);
      }
    }
    held.targets.push(...left);
  };
  return {
    id: backend.id,
    type: backend.type,
    callable: backend.callable,
    description: backend.description,
    async connect(host) {
      const fs = patientFs(host.fs);
      const handle = await backend.connect(new Proxy(host, {
        get: (target, prop) => (prop === 'fs' ? fs : Reflect.get(target, prop)),
      }));
      if (readOnly.length === 0) {
        return handle;
      }
      const owner = {};
      let k;
      try {
        k = await kernel();
        await mountReadOnly(k, fs, owner);
      } catch (e) {
        if (k) {
          await unmountReadOnly(k, owner);
        }
        await handle.close().catch(() => {});
        throw e;
      }
      return {
        ...handle,
        close: async () => {
          await unmountReadOnly(k, owner);
          return handle.close();
        },
      };
    },
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
