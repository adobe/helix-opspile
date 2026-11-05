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

import { entryOf } from '../drafts.js';
import { unseal } from '../post.js';

/**
 * The secrets of the agents' computers (migration 0060): API keys and tokens of a team or a
 * customer that the agents use from their shell without ever holding them.
 *
 * The shell (src/agent/computer.js) has each as a variable, `$NAME`, whose value is only a
 * placeholder (`opspile-secret-NAME`). Every request the shell makes goes through the Worker's
 * SecretGateway (src/agent/gateway.js; Cloudflare Computer's `http-gateway` egress, the Dynamic
 * Worker's `globalOutbound`), which runs `forward` on it:
 *
 * - a request that names no secret goes out as it is;
 * - one that names secrets, in its URL, its headers (a Basic `Authorization` decoded too) or a
 *   textual body of up to 1 MiB, gets their values in place of the placeholders, escaped as the
 *   place needs (percent-encoded in the URL and a form, in a JSON string or XML), but only over
 *   HTTPS to the hosts each secret lists, and without following redirects, so that the shell
 *   asks again, through here, for wherever it is sent next;
 * - one that names a secret it may not send there, or one there is none of, is refused (403)
 *   and nothing is sent;
 * - what comes back has the values replaced by their placeholders again, in its headers and
 *   its body, as they are or escaped, should the host repeat them.
 *
 * The gateway knows the agent by name only (its props, set by the ThreadAgent object) and reads
 * its team's and customer's secrets from D1 on every request that names one, so a change, or a
 * thread moved to another team, counts at once. Values are sealed with TOKEN_KEY, unsealed
 * only here, and never shown again: not to the agent, not in the editor.
 */

export const PREFIX = 'opspile-secret-';
const FIND = /opspile-secret-([A-Z][A-Z0-9_]{0,63})/g;

export const NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
/** Variables the shell has, or needs, itself. */
const RESERVED = new Set(['PATH', 'HOME', 'PWD', 'OLDPWD', 'SHELL', 'USER', 'IFS', 'TERM', 'LANG',
  'HOSTNAME', 'PS1', 'PS2', 'PS4', 'TMPDIR', 'OPTIND', 'OPTARG', 'RANDOM', 'SECONDS', 'LINENO']);
export const MAX_SECRETS = 30;
export const MAX_VALUE = 4096;
const MAX_HOSTS = 10;
const MAX_BODY = 1024 * 1024;
const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const TEXTUAL = /^(text\/|application\/(json|x-www-form-urlencoded|xml|graphql|[a-z0-9.+-]*\+(json|xml))\b)/i;
const NULL_BODY = new Set([101, 204, 205, 304]);

/** What the shell has in `$NAME`: the gateway puts the value in its place. */
export const placeholder = (name) => `${PREFIX}${name}`;

/** Why `name` cannot be a secret's, or null. */
export function nameProblem(name) {
  if (!NAME.test(name)) {
    return 'give the secret a name of capitals, digits and _, starting with a capital (ACME_API_KEY), at most 64';
  }
  if (RESERVED.has(name) || name.startsWith('BASH')) {
    return `${name} is a variable the shell has itself`;
  }
  return null;
}

/** Why `value` cannot be a secret's, or null. */
export function valueProblem(value) {
  if (!value || value.length > MAX_VALUE || /[\r\n]/.test(value)) {
    return `give the value on one line, at most ${MAX_VALUE} characters`;
  }
  if (value.includes(PREFIX)) {
    return 'that is a placeholder, not a value';
  }
  return null;
}

/**
 * The hosts of `input` (a list, or a string separated by commas or spaces), lowercased:
 * `{ hosts }`, or `{ error }`. A host is a name (`api.example.com`), or `*.` and a name of at
 * least two labels for any host below it (`*.example.com`, not `example.com` itself); a URL
 * stands for its host.
 */
export function parseHosts(input) {
  // A URL pasted in stands for its host.
  const bare = (h) => {
    const m = /^https?:\/\/([^/?#:@]+)(:\d+)?([/?#].*)?$/i.exec(h);
    return m ? m[1] : h;
  };
  const list = (Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/))
    .map((h) => bare(String(h || '').trim()).toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
  const hosts = [...new Set(list)];
  if (!hosts.length) {
    return { error: 'give the hosts it may be sent to: api.example.com, or *.example.com for any below it' };
  }
  if (hosts.length > MAX_HOSTS) {
    return { error: `at most ${MAX_HOSTS} hosts` };
  }
  const wrong = hosts.find((h) => !HOST.test(h) || h.length > 253
    || (h.startsWith('*.') && h.split('.').length < 3));
  if (wrong) {
    return { error: `${wrong} is not a host name (api.example.com, or *.example.com)` };
  }
  return { hosts };
}

/** Whether `hostname` is one of `hosts` (see parseHosts). */
export function hostAllowed(hostname, hosts) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return hosts.some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
}

const hostsOf = (s) => String(s || '').split(',').filter(Boolean);

/**
 * The secrets of a team and a customer, a team's first: `Map<name, row>`, the team's winning
 * over the customer's of the same name. With `value`, sealed, only when `values` is set.
 */
async function secretRows(env, { team, org }, { values = false } = {}) {
  if (!env.DB || (!team && !org)) {
    return new Map();
  }
  const { results } = await env.DB.prepare(`SELECT scope, name, hosts, description
      ${values ? ', value' : ''} FROM agent_secrets
    WHERE (scope = 'team' AND slug = ?) OR (scope = 'org' AND slug = ?)
    ORDER BY CASE scope WHEN 'team' THEN 0 ELSE 1 END, name`).bind(team || '', org || '').all();
  const out = new Map();
  for (const r of results || []) {
    if (!out.has(r.name)) {
      out.set(r.name, { ...r, hosts: hostsOf(r.hosts) });
    }
  }
  return out;
}

/**
 * What an agent of `target` (its team and customer) may use: `[{ name, scope, hosts,
 * description }]`, by name, without values.
 */
export async function secretsFor(env, target) {
  const rows = await secretRows(env, target || {});
  return [...rows.values()].map((r) => ({
    name: r.name, scope: r.scope, hosts: r.hosts, description: r.description || '',
  }));
}

/** The shell's variables for `list` (secretsFor): `{ NAME: placeholder }`. */
export const shellEnv = (list) => Object.fromEntries(list.map((s) => [s.name,
  placeholder(s.name)]));

/** What the agent is told about `list` (secretsFor), for the computer's section; '' for none. */
export function secretsNote(list) {
  if (!list.length) {
    return '';
  }
  const lines = list.map((s) => `- $${s.name}, sent to ${s.hosts.join(', ')}${s.description ? `: ${s.description}` : ''}`);
  return `Secrets: the team keeps API keys for you, as variables of your shell. Use them as they are, quoted, where the API wants the key: in a header (curl -H "Authorization: Bearer $NAME"), the URL, a JSON or form body, or curl -u, as $NAME and not encoded: the value is escaped for where it goes (the URL, a form, a JSON string). Your shell only has a placeholder (${PREFIX}NAME): the value is put in on the way out, in HTTPS requests to the hosts listed and nowhere else, and taken out again from what comes back. A request that names a secret for another host is refused, and nothing is sent. You never see a value, so do not try to find one out or ask anyone for it, and never write a placeholder into a draft or a note.
${lines.join('\n')}`;
}

/** The team and customer of the agent named `name` (a thread key, or `kb:<team>:<org>`). */
export async function agentScope(env, name) {
  const kb = /^kb:([^:]*):(.*)$/.exec(String(name || ''));
  if (kb) {
    return { team: kb[1] || null, org: kb[2] || null };
  }
  const entry = name && env.DB ? await entryOf(env, name) : null;
  return { team: entry ? entry.team : null, org: entry ? entry.org : null };
}

const namesIn = (s) => [...String(s || '').matchAll(FIND)].map((m) => m[1]);

const enc = new TextEncoder();
const b64 = (s) => btoa(String.fromCharCode(...enc.encode(s)));
const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

/** The `user:password` of a Basic `Authorization`, or null. */
function basicOf(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(String(header || ''));
  if (!m) {
    return null;
  }
  try {
    return unb64(m[1]);
  } catch {
    return null;
  }
}

/** A textual body of up to MAX_BODY, read from a copy of `request`; null otherwise. */
async function bodyText(request) {
  if (!request.body || !TEXTUAL.test(request.headers.get('content-type') || '')) {
    return null;
  }
  const reader = request.clone().body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > MAX_BODY) {
      // eslint-disable-next-line no-await-in-loop
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * A stream that replaces each `[from, to]` of `pairs` (strings) in the bytes going through it,
 * also where one is split between chunks.
 */
export function scrubber(pairs) {
  const needles = pairs.filter(([from]) => from)
    .map(([from, to]) => [enc.encode(from), enc.encode(to)]);
  const keep = Math.max(1, ...needles.map(([n]) => n.length)) - 1;
  const at = (buf, i, n) => {
    if (i + n.length > buf.length) {
      return false;
    }
    for (let k = 0; k < n.length; k += 1) {
      if (buf[i + k] !== n[k]) {
        return false;
      }
    }
    return true;
  };
  let carry = new Uint8Array(0);
  const run = (chunk, final, controller) => {
    const buf = new Uint8Array(carry.length + chunk.length);
    buf.set(carry);
    buf.set(chunk, carry.length);
    // A needle that starts before `limit` fits in `buf`; the rest waits for the next chunk.
    const limit = final ? buf.length : buf.length - keep;
    let start = 0;
    let i = 0;
    const hitAt = (j) => needles.find(([n]) => at(buf, j, n));
    while (i < limit) {
      const hit = hitAt(i);
      if (hit) {
        if (i > start) {
          controller.enqueue(buf.slice(start, i));
        }
        controller.enqueue(hit[1]);
        i += hit[0].length;
        start = i;
      } else {
        i += 1;
      }
    }
    const end = Math.min(Math.max(i, start), buf.length);
    if (end > start) {
      controller.enqueue(buf.slice(start, end));
    }
    carry = buf.slice(end);
  };
  return new TransformStream({
    transform(chunk, controller) {
      run(typeof chunk === 'string' ? enc.encode(chunk) : new Uint8Array(chunk), false, controller);
    },
    flush(controller) {
      run(new Uint8Array(0), true, controller);
    },
  });
}

/**
 * How a value is written where its placeholder was: as it is in a header, percent-encoded in
 * the URL and in a form body (a `+` would arrive as a space), escaped in a JSON string or XML.
 */
const ESCAPE = {
  raw: (v) => v,
  url: (v) => encodeURIComponent(v),
  json: (v) => JSON.stringify(v).slice(1, -1),
  xml: (v) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
};

/** The escape of a body of `type` (a content type). */
function bodyEscape(type) {
  const t = String(type || '').toLowerCase();
  if (t.startsWith('application/x-www-form-urlencoded')) {
    return 'url';
  }
  if (/^application\/([a-z0-9.+-]*\+)?json\b/.test(t)) {
    return 'json';
  }
  return /xml\b/.test(t) ? 'xml' : 'raw';
}

const refuse = (host, why) => new Response(
  `opspile: nothing was sent to ${host}: ${why.join('; ')}.\n`,
  { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-opspile-secrets': 'refused' } },
);

/**
 * The gateway's answer to `request`, a request of the shell of the agent `props.agent`: sent
 * with the secrets it names put in, or refused (see above). `fetch` sends it.
 */
export async function forward(env, props, request, { fetch: send = fetch } = {}) {
  const headerList = [...request.headers];
  const basic = basicOf(request.headers.get('authorization'));
  const body = await bodyText(request);
  const named = new Set([
    ...namesIn(request.url),
    ...headerList.flatMap(([, v]) => namesIn(v)),
    ...namesIn(basic),
    ...namesIn(body),
  ]);
  if (!named.size) {
    return send(request);
  }
  const url = new URL(request.url);
  const rows = await secretRows(env, await agentScope(env, props && props.agent), { values: true });
  const why = [];
  for (const name of named) {
    const s = rows.get(name);
    if (!s) {
      why.push(`there is no secret ${name} here`);
    } else if (url.protocol !== 'https:' || !hostAllowed(url.hostname, s.hosts)) {
      why.push(`${name} is only sent to ${s.hosts.join(', ')}, over HTTPS`);
    }
  }
  if (why.length) {
    console.log(JSON.stringify({ route: 'gateway', secrets: [...named], sent: false }));
    return refuse(url.host, why);
  }
  const values = new Map();
  for (const name of named) {
    // eslint-disable-next-line no-await-in-loop
    values.set(name, await unseal(env, rows.get(name).value));
  }
  const put = (s, how = 'raw') => s.replace(FIND, (m, name) => (values.has(name)
    ? ESCAPE[how](values.get(name)) : m));
  const headers = new Headers();
  for (const [k, v] of headerList) {
    headers.append(k, put(v));
  }
  if (basic && namesIn(basic).length) {
    headers.set('authorization', `Basic ${b64(put(basic))}`);
  }
  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.body) {
    if (body !== null && namesIn(body).length) {
      init.body = put(body, bodyEscape(request.headers.get('content-type')));
      headers.delete('content-length');
    } else {
      init.body = request.body;
      init.duplex = 'half';
    }
  }
  console.log(JSON.stringify({ route: 'gateway', secrets: [...named], sent: true }));
  const res = await send(new Request(put(request.url, 'url'), init));
  // The value, and how it may come back escaped: the longest first, as they may overlap.
  const back = [...values].flatMap(([name, value]) => [...new Set(Object.values(ESCAPE)
    .map((e) => e(value)))].map((v) => [v, placeholder(name)]))
    .sort((x, y) => y[0].length - x[0].length);
  const scrub = (s) => back.reduce((out, [value, ph]) => out.split(value).join(ph), s);
  const out = new Headers();
  for (const [k, v] of res.headers) {
    out.append(k, scrub(v));
  }
  out.delete('content-length');
  const stream = res.body && !NULL_BODY.has(res.status)
    ? res.body.pipeThrough(scrubber(back)) : null;
  return new Response(stream, { status: res.status, statusText: res.statusText, headers: out });
}
