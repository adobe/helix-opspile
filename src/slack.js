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

import { joinOnEvent } from './autojoin.js';
import { text } from './http.js';
import { dayPath, putRaw, segment } from './raw.js';

/** Slack rejects requests older than this; so do we (replay window). */
export const MAX_SKEW_SECONDS = 5 * 60;

const encoder = new TextEncoder();

function hexToBytes(hex) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Verifies a Slack request signature.
 *
 * `v0=` + hex(HMAC-SHA256(secret, `v0:<timestamp>:<raw body>`)), see
 * https://docs.slack.dev/authentication/verifying-requests-from-slack. The comparison is
 * done by `crypto.subtle.verify`, which is constant-time.
 *
 * @returns {Promise<string|null>} null if the request is valid, otherwise the reason
 */
export async function verifySlackSignature({
  secret, timestamp, signature, body, now = Date.now(),
}) {
  if (!secret) {
    return 'no signing secret configured';
  }
  if (!timestamp || !/^\d+$/.test(timestamp)) {
    return 'missing timestamp';
  }
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > MAX_SKEW_SECONDS) {
    return 'stale timestamp';
  }
  const sig = signature && signature.startsWith('v0=') ? hexToBytes(signature.slice(3)) : null;
  if (!sig) {
    return 'missing signature';
  }
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify('HMAC', key, sig, encoder.encode(`v0:${timestamp}:${body}`));
  return ok ? null : 'bad signature';
}

/** The channel an event belongs to, for the event types opspile subscribes to. */
function channelOf(event) {
  if (typeof event.channel === 'string') {
    return event.channel;
  }
  if (event.channel && event.channel.id) {
    return event.channel.id; // channel_created, channel_rename
  }
  if (event.item && event.item.channel) {
    return event.item.channel; // reaction_added, reaction_removed
  }
  return event.channel_id;
}

/**
 * Pile-1 key of an event callback:
 * `slack/<enterprise or team>/<channel>/<yyyy>/<mm>/<dd>/<event_ts>-<event_id>.json`.
 * Workspace-level events without a channel (`tokens_revoked`, `app_uninstalled`) use `_`.
 */
export function slackKey(payload) {
  const event = payload.event || {};
  const ts = event.event_ts || event.ts || String(payload.event_time);
  const seconds = Number(payload.event_time) || Math.floor(Number(ts)) || Date.now() / 1000;
  return [
    'slack',
    segment(payload.enterprise_id || payload.team_id),
    segment(channelOf(event)),
    dayPath(new Date(seconds * 1000)),
    `${segment(ts)}-${segment(payload.event_id)}.json`,
  ].join('/');
}

/**
 * The payload to store: everything Slack sent, except the deprecated verification
 * `token`, which is a credential and is never used (requests are verified by signature).
 */
export function withoutCredentials(payload) {
  return JSON.stringify({ ...payload, token: undefined });
}

/**
 * Metadata of an event callback, for logs. Never includes message text or user ids.
 */
function describe(payload, request) {
  const event = payload.event || {};
  return {
    route: 'slack',
    type: payload.type,
    eventId: payload.event_id,
    eventType: event.type,
    subtype: event.subtype || (event.message && event.message.subtype),
    channelType: event.channel_type,
    channel: channelOf(event),
    reply: Boolean(event.thread_ts && event.thread_ts !== event.ts),
    bot: Boolean(event.bot_id),
    retry: request.headers.get('x-slack-retry-num') || undefined,
  };
}

/**
 * Slack Events API endpoint.
 *
 * Every request, `url_verification` included, must carry a valid signature. Event
 * callbacks are stored in pile 1 as delivered, minus the deprecated verification `token`
 * (a credential), before they are acknowledged; if storing fails, the 500 makes Slack
 * retry with the same `event_id`, which rewrites the same key.
 */
export async function slackEvents(request, env, ctx) {
  const body = await request.text();
  const reason = await verifySlackSignature({
    secret: env.SLACK_SIGNING_SECRET,
    timestamp: request.headers.get('x-slack-request-timestamp'),
    signature: request.headers.get('x-slack-signature'),
    body,
  });
  if (reason) {
    console.warn(JSON.stringify({ route: 'slack', rejected: reason }));
    return text('unauthorized\n', 401);
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return text('bad request\n', 400);
  }
  if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
    return text(payload.challenge);
  }
  const info = describe(payload, request);
  if (payload.type !== 'event_callback') {
    console.log(JSON.stringify(info)); // e.g. app_rate_limited: nothing to store
    return text('', 200);
  }
  try {
    info.key = await putRaw(env, slackKey(payload), withoutCredentials(payload), {
      source: 'slack', via: 'events', retry: info.retry,
    });
  } catch (e) {
    console.error(JSON.stringify({ ...info, error: e.message }));
    return text('storage error\n', 500);
  }
  console.log(JSON.stringify(info));
  // A new public channel: the app joins it (src/autojoin.js), after the event is stored.
  const join = joinOnEvent(env, payload).catch((e) => console.warn(JSON.stringify({
    route: 'slack', join: 'error', error: e.message,
  })));
  if (ctx) {
    ctx.waitUntil(join);
  }
  return text('', 200);
}
