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

import { text } from './http.js';

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
    channel: event.channel || (event.item && event.item.channel),
    reply: Boolean(event.thread_ts && event.thread_ts !== event.ts),
    bot: Boolean(event.bot_id),
    retry: request.headers.get('x-slack-retry-num') || undefined,
  };
}

/**
 * Slack Events API endpoint.
 *
 * Every request, `url_verification` included, must carry a valid signature. Accepted
 * events are logged as metadata and acknowledged; storing them is #4.
 */
export async function slackEvents(request, env) {
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
  console.log(JSON.stringify(describe(payload, request)));
  return text('', 200);
}
