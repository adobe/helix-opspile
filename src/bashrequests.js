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

import { nameProblem } from './agent/secrets.js';

/**
 * Command requests (migration 0062): a thread agent asks a person on the team to run a command
 * on its computer (its `request_bash`, src/agent/bashrequest.js). The inbox shows the request
 * under the thread, near the draft: the command, the agent's reason, and a field for each
 * variable the agent asked for, which the person fills in (their own API token, say). The
 * person runs it or denies it; nobody doing either until its deadline closes it.
 *
 * This file is the record in D1 and its lifecycle, `status`:
 *
 *   pending -> running -> done | timeout | failed
 *   pending -> denied | expired
 *
 * Every transition names the status it starts from (`WHERE status = …`), so two people who
 * click at once, or a click at the deadline, cannot both win. A request holds the names of its
 * variables and what they are for, never a value: values go from the page to the shell for the
 * one run, and are kept nowhere.
 */

export const MAX_COMMAND = 8000;
export const MAX_REASON = 500;
export const MAX_ENV = 10;
const MAX_DESCRIPTION = 200;
/** What a person may fill in for one variable: a token, a key file. */
export const MAX_VALUE = 16 * 1024;
/** Requests of one thread that may wait or run at a time. */
export const MAX_OPEN = 5;
export const DEFAULT_TIMEOUT = 60;
/** The shell's own limit for one run (Cloudflare Computer's `maxTimeoutMs`). */
export const MAX_TIMEOUT = 180;
const MINUTE = 60 * 1000;
export const DEFAULT_DEADLINE_MS = 24 * 60 * MINUTE;
export const MAX_DEADLINE_MS = 7 * 24 * 60 * MINUTE;
const MIN_DEADLINE_MS = MINUTE;
/** How long the inbox goes on showing a request that ended. */
export const SHOWN_MS = 60 * MINUTE;

const OPEN = ['pending', 'running'];
const UNITS = {
  m: MINUTE, min: MINUTE, h: 60 * MINUTE, d: 24 * 60 * MINUTE,
};

/**
 * Until when a request stays open: `{ at }` (a Date) for `input`, a duration from `now`
 * (`30m`, `4h`, `2d`) or an ISO 8601 time, by default a day; or `{ error }`.
 */
export function parseDeadline(input, now = new Date()) {
  const from = now.getTime();
  if (input === undefined || input === null || input === '') {
    return { at: new Date(from + DEFAULT_DEADLINE_MS) };
  }
  const text = String(input).trim();
  const span = /^(\d{1,5})\s*(m|min|h|d)$/i.exec(text);
  const at = span ? from + Number(span[1]) * UNITS[span[2].toLowerCase()] : Date.parse(text);
  if (!Number.isFinite(at)) {
    return { error: 'give the deadline as a duration from now (30m, 4h, 2d) or an ISO 8601 time' };
  }
  if (at - from < MIN_DEADLINE_MS) {
    return { error: `the deadline has to be at least a minute from now (it is ${now.toISOString()})` };
  }
  if (at - from > MAX_DEADLINE_MS) {
    return { error: 'the deadline can be at most 7 days from now' };
  }
  return { at: new Date(at) };
}

/**
 * The variables a request asks for, from the agent's `env`: `{ env: [{ name, description }] }`,
 * or `{ error }`. A name is a shell variable's, as a secret's is (src/agent/secrets.js).
 */
export function cleanEnv(input) {
  const list = input === undefined || input === null ? [] : input;
  if (!Array.isArray(list) || list.length > MAX_ENV) {
    return { error: `env is a list of at most ${MAX_ENV} variables` };
  }
  const env = [];
  for (const item of list) {
    const name = String((item && item.name) || '').trim();
    const problem = nameProblem(name);
    if (problem) {
      return { error: problem.replace('the secret', 'each variable') };
    }
    if (env.some((e) => e.name === name)) {
      return { error: `${name} is in env twice` };
    }
    env.push({
      name,
      description: String((item && item.description) || '').trim().slice(0, MAX_DESCRIPTION),
    });
  }
  return { env };
}

/**
 * What a request is made of, from the agent's arguments: `{ command, reason, env, timeout,
 * deadline }` (the deadline an ISO time), or `{ error }`.
 */
export function cleanRequest(args, now = new Date()) {
  const command = String((args && args.command) || '');
  if (!command.trim() || command.length > MAX_COMMAND) {
    return { error: `give the command (up to ${MAX_COMMAND} characters)` };
  }
  const reason = String((args && args.reason) || '').trim();
  if (!reason || reason.length > MAX_REASON) {
    return { error: `say why, for the person who decides (up to ${MAX_REASON} characters)` };
  }
  const timeout = args.timeout === undefined || args.timeout === null
    ? DEFAULT_TIMEOUT : Number(args.timeout);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > MAX_TIMEOUT) {
    return { error: `the timeout is 1 to ${MAX_TIMEOUT} seconds` };
  }
  const vars = cleanEnv(args.env);
  if (vars.error) {
    return vars;
  }
  const deadline = parseDeadline(args.deadline, now);
  if (deadline.error) {
    return deadline;
  }
  return {
    command,
    reason,
    env: vars.env,
    timeout: Math.ceil(timeout),
    deadline: deadline.at.toISOString(),
  };
}

/**
 * The values a person filled in for the variables of `request`: `{ values }`, each variable's
 * and nothing else, or `{ error }` when one is missing or is not a value.
 */
export function cleanValues(request, given) {
  const values = {};
  for (const { name } of request.env) {
    const value = given && typeof given[name] === 'string' ? given[name] : '';
    if (!value) {
      return { error: `fill in ${name}` };
    }
    if (value.length > MAX_VALUE || value.includes('\0')) {
      return { error: `${name} is not a value the shell can take (at most ${MAX_VALUE} characters)` };
    }
    values[name] = value;
  }
  return { values };
}

const envOf = (raw) => {
  try {
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
};

/**
 * A request as the inbox and the agent's code see it. One nobody decided before its deadline
 * is `expired` from then on, also before the agent's schedule has written it.
 */
const shape = (r, now) => ({
  id: r.id,
  thread: r.thread,
  command: r.command,
  reason: r.reason,
  env: envOf(r.env),
  timeout: r.timeout,
  deadline: r.deadline,
  status: r.status === 'pending' && r.deadline <= now.toISOString() ? 'expired' : r.status,
  created_at: r.created_at,
  by: r.decided_by ? { id: r.decided_by, name: r.name || null } : null,
  decided_at: r.decided_at,
  finished_at: r.finished_at,
  exit_code: r.exit_code,
  error: r.error,
});

const SELECT = `SELECT r.*, p.name FROM bash_requests r
  LEFT JOIN people p ON p.id = r.decided_by`;

/** The request `id`, with when the agent was told how it ended (`told_at`), or null. */
export async function requestOf(env, id, now = new Date()) {
  const row = id && await env.DB.prepare(`${SELECT} WHERE r.id = ?`).bind(String(id)).first();
  return row ? { ...shape(row, now), told_at: row.told_at } : null;
}

/**
 * The requests of an inbox entry (`keys`: its member threads) that the inbox shows, oldest
 * first: those that wait or run, and for SHOWN_MS those that ended.
 */
export async function requestsFor(env, keys, now = new Date()) {
  const list = [...new Set(keys || [])];
  if (!list.length) {
    return [];
  }
  const since = new Date(now.getTime() - SHOWN_MS).toISOString();
  const { results } = await env.DB.prepare(`${SELECT}
    WHERE r.thread IN (SELECT value FROM json_each(?1))
      AND (r.status = 'running' OR COALESCE(r.finished_at, r.deadline) > ?2)
    ORDER BY r.created_at, r.id`).bind(JSON.stringify(list), since).all();
  return (results || []).map((r) => shape(r, now));
}

/** How many requests of `thread` wait or run. */
export async function openCount(env, thread, now = new Date()) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM bash_requests
    WHERE thread = ? AND (status = 'running' OR (status = 'pending' AND deadline > ?))`)
    .bind(thread, now.toISOString()).first();
  return row ? row.n : 0;
}

/** Stores a new request of `thread` (`request` from cleanRequest) under `id`: pending. */
export async function insertRequest(env, id, thread, request, now = new Date()) {
  await env.DB.prepare(`INSERT INTO bash_requests (id, thread, command, reason, env, timeout,
      deadline, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .bind(
      id,
      thread,
      request.command,
      request.reason,
      JSON.stringify(request.env),
      request.timeout,
      request.deadline,
      now.toISOString(),
    ).run();
  return requestOf(env, id, now);
}

const changed = ({ meta }) => Boolean(meta && meta.changes);

/** pending -> running, by `person`, while the deadline has not passed. Whether it did. */
export async function claimRequest(env, id, person, now = new Date()) {
  const at = now.toISOString();
  return changed(await env.DB.prepare(`UPDATE bash_requests SET status = 'running',
      decided_by = ?, decided_at = ?
    WHERE id = ? AND status = 'pending' AND deadline > ?`).bind(person, at, id, at).run());
}

/** pending -> denied, by `person`. Whether it did. */
export async function denyRequest(env, id, person, now = new Date()) {
  const at = now.toISOString();
  return changed(await env.DB.prepare(`UPDATE bash_requests SET status = 'denied',
      decided_by = ?, decided_at = ?, finished_at = ?
    WHERE id = ? AND status = 'pending' AND deadline > ?`).bind(person, at, at, id, at).run());
}

/** pending -> expired, once the deadline has passed. Whether it did. */
export async function expireRequest(env, id, now = new Date()) {
  const at = now.toISOString();
  return changed(await env.DB.prepare(`UPDATE bash_requests SET status = 'expired',
      finished_at = ? WHERE id = ? AND status = 'pending' AND deadline <= ?`)
    .bind(at, id, at).run());
}

/**
 * running -> `status` (`done` with the command's `exitCode`, `timeout`, or `failed` with
 * `error`). Whether it did: a run that was settled already (by the watchdog, say) stays so.
 */
export async function settleRequest(env, id, outcome, now = new Date()) {
  const { status, exitCode = null, error = null } = outcome;
  return changed(await env.DB.prepare(`UPDATE bash_requests SET status = ?, exit_code = ?,
      error = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
    .bind(status, exitCode, error ? String(error).slice(0, 500) : null, now.toISOString(), id)
    .run());
}

/** The agent was told how the request ended. */
export async function markTold(env, id, now = new Date()) {
  await env.DB.prepare('UPDATE bash_requests SET told_at = ? WHERE id = ? AND told_at IS NULL')
    .bind(now.toISOString(), id).run();
}

export const isOpen = (request) => OPEN.includes(request.status);
