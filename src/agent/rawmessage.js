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

/**
 * A message as its platform sent it, for an agent's `raw_message` tool: what the markdown of
 * pile 2 cannot show (colours, highlights, cards, embeds) is in pile 1. Only what the message
 * says is shown, not the platform's envelope (ids, OData, tokens' scopes): the Teams body as
 * HTML, Slack's text and blocks, Discord's content and embeds.
 */

/** How much of a raw message the agent gets at once; `offset` reads on. */
export const MAX_RAW = 30000;

/** How many stored versions of a message are looked at for the newest. */
const MAX_VERSIONS = 20;

/** The parts of a Slack payload that say what the message is: the edited one for an edit. */
function slackParts(payload) {
  const event = payload.type === 'backfill' ? payload.message || {} : payload.event || {};
  const m = event.subtype === 'message_changed' && event.message ? event.message : event;
  return {
    text: m.text,
    blocks: m.blocks,
    attachments: m.attachments,
    files: m.files && m.files.map((f) => ({
      name: f.name, title: f.title, mimetype: f.mimetype, permalink: f.permalink,
    })),
  };
}

/** The parts of a platform's payload that say what the message is, by pile-1 key. */
export function rawParts(key, payload) {
  const source = String(key).split('/')[0];
  const p = payload || {};
  if (source === 'teams') {
    const body = p.body || {};
    return {
      subject: p.subject,
      [`body (${body.contentType || 'text'})`]: body.content,
      attachments: p.attachments,
      eventDetail: p.eventDetail,
    };
  }
  if (source === 'slack') {
    return slackParts(p);
  }
  if (source === 'discord') {
    const d = p.d || {};
    return {
      content: d.content,
      embeds: d.embeds,
      attachments: d.attachments,
      components: d.components,
      poll: d.poll,
    };
  }
  return { payload: p };
}

/** The parts as text: a string as it is, anything else as JSON; empty ones left out. */
export function rawText(parts) {
  return Object.entries(parts)
    .filter(([, v]) => v !== undefined && v !== null && v !== ''
      && !(Array.isArray(v) && !v.length))
    .map(([name, v]) => (typeof v === 'string' ? `${name}:\n${v}` : `${name} (JSON):\n${JSON.stringify(v, null, 1)}`))
    .join('\n\n');
}

/** When a pile-1 object was received: as putRaw wrote it, else when R2 has it from. */
const received = (obj) => String((obj.customMetadata && obj.customMetadata.receivedAt)
  || (obj.uploaded && new Date(obj.uploaded).toISOString()) || '');

/**
 * The newest stored version of message `m` (a pile-2 message, its `raw` the pile-1 keys), as
 * its platform sent it: `{ text, versions }`, or `{ error }`.
 */
export async function readRawMessage(env, m) {
  const keys = [].concat(m.raw || []).filter(Boolean).slice(-MAX_VERSIONS);
  if (!keys.length || !env.RAW) {
    return { error: 'opspile kept no copy of it as it was sent' };
  }
  const objects = (await Promise.all(keys.map(async (key) => {
    const obj = await env.RAW.get(key);
    return obj && { key, obj, at: received(obj) };
  }))).filter(Boolean);
  if (!objects.length) {
    return { error: 'its copy as it was sent is gone' };
  }
  // The newest: by when it arrived, then by key (Teams and Slack keys sort by time).
  objects.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
  const { key, obj } = objects[objects.length - 1];
  let payload;
  try {
    payload = JSON.parse(await obj.text());
  } catch {
    return { error: 'its copy as it was sent cannot be read' };
  }
  return { text: rawText(rawParts(key, payload)), versions: objects.length };
}
