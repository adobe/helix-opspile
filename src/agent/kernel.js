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
 * The shell of the agents' computers (the `computer` tool, src/agent/computer.js): GNU bash and
 * real programs on the SLICC kernel (@ai-ecoverse/slicc-kernel/cloudflare).
 *
 * The kernel runs in the ThreadAgent object, its processes in Dynamic Workers (env.LOADER)
 * that have no network of their own. It is the backend of the computer's Workspace
 * (`sliccBackend`), so the thread's files are mounted at /workspace, the read-only uploads
 * among them. The kernel's own root (/root, /tmp, /etc, and its programs under /node_modules)
 * is in the object's SQLite too, in tables of its own (`slicc_*`).
 *
 * Its programs are an image (src/agent/image.js): the team's choice among those in the
 * `IMAGES` bucket (`imageFor`, the knowledge-base editor's Computer tool), a stack of layers
 * the kernel mounts read-only when it boots (`imageSpec`). The agent's object keeps no copy.
 *
 * Its programs reach the network through the kernel's proxy, which hands every request to a
 * transport: here `gatewayFetch`, over the gateway's `forward` (src/agent/secrets.js), so the
 * team's secrets go in where a request names them, and nowhere else. Redirects are the
 * program's to follow (curl -L), each hop through the gateway again.
 *
 * This file has what needs no Workers runtime, so that it is tested in Node; the kernel
 * itself is made in src/agent/agent.js.
 */

/**
 * Where curl finds its configuration in the kernel (`CURL_HOME`), and what it says: the
 * proxy's answer to curl's CONNECT (`HTTP/1.1 200 Connection Established`) is not shown with
 * the site's headers (curl -i, -I, -D), which then start with the site's own status line, as
 * they do anywhere else.
 */
export const CURL_HOME = '/etc/opspile/curl';
export const CURLRC = 'suppress-connect-headers\n';

/**
 * What every process of the kernel has in its environment, besides the kernel's own: curl's
 * configuration (CURLRC), and tar that does not try to give the files it unpacks the owners
 * the archive names, which the kernel refuses even root (a warning for each file).
 */
export const KERNEL_ENV = {
  CURL_HOME,
  TAR_OPTIONS: '--no-same-owner',
};

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

/** The image of an agent's computer, by its target's team (src/agent/agent.js `target`). */
export async function imageFor(env, target) {
  return (await teamImage(env, target && target.team)).image;
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

/** How the kernel ends a run whose time is up: bash, by SIGTERM, and by SIGKILL after it. */
const KILLED = [143, 137];

/**
 * Whether the shell stopped a run at `timeout` (seconds), which took `seconds`. The kernel only
 * ends bash with a signal, as a command can end by itself: its exit code says so, and its time
 * was up (a person's run asks the same, src/agent/bashrequest.js).
 */
export function timedOut(exitCode, seconds, timeout) {
  return KILLED.includes(exitCode) && seconds >= timeout;
}
