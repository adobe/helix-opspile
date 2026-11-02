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
 * Slack message permalinks (`https://….slack.com/archives/C…/p…`), including a workspace
 * host such as `acme.enterprise.slack.com`. Pure: the inbox and the Worker both use it.
 * A message's id in D1 is the Slack `ts` (seconds, a dot, six fractional digits). The `p`
 * segment is that ts with the dot removed.
 */

/** Code (fenced or inline): what was typed, not a link to follow. */
const CODE = /```[\s\S]*?```|`[^`\n]+`/g;
/** A Slack conversation id: public (`C`), private (`G`) or direct (`D`). */
const CHANNEL = '[CDG][A-Z0-9]{8,}';
const HOST = '(?:[a-z0-9-]+\\.)*slack\\.com';
/** One permalink, the whole string (an href). */
const SLACK_ONE = new RegExp(`^https://${HOST}/archives/(${CHANNEL})/p(\\d{7,})/?(?:[?#].*)?$`);
/** Every permalink in a text. The `p` digits end at the first non-digit. */
const SLACK_ANY = new RegExp(`https://${HOST}/archives/(${CHANNEL})/p(\\d{7,})(?!\\d)`, 'g');
/** At most this many distinct messages are looked up per thread. */
const MAX_REFS = 50;

const decodeAmp = (url) => String(url || '').replace(/&amp;/gi, '&').trim();

/** Slack `ts` (`seconds.fraction`) from the `p` segment, or null. */
export function slackMessageId(digits) {
  const s = String(digits || '');
  if (!/^\d{7,}$/.test(s)) {
    return null;
  }
  const sec = s.slice(0, -6).replace(/^0+/, '') || '0';
  return `${sec}.${s.slice(-6)}`;
}

/** `{ channel, id }` for one permalink, or null. The host does not matter. */
export function slackMessageRef(url) {
  const m = SLACK_ONE.exec(decodeAmp(url));
  if (!m) {
    return null;
  }
  const id = slackMessageId(m[2]);
  return id ? { channel: m[1], id } : null;
}

/** `${channel}:${id}`, so two hosts for one message share a key. */
export function slackMessageKey(url) {
  const ref = slackMessageRef(url);
  return ref ? `${ref.channel}:${ref.id}` : null;
}

/**
 * The Slack message permalinks in markdown texts, outside code: `[{ channel, id }]`,
 * in order, at most MAX_REFS distinct messages.
 *
 * @param {string[]} texts
 */
export function slackMessageRefs(texts) {
  const seen = new Set();
  const refs = [];
  for (const text of texts || []) {
    const bare = String(text || '').replace(CODE, ' ');
    for (const m of bare.matchAll(SLACK_ANY)) {
      const id = slackMessageId(m[2]);
      const key = id && `${m[1]}:${id}`;
      if (key && !seen.has(key) && refs.length < MAX_REFS) {
        seen.add(key);
        refs.push({ channel: m[1], id });
      }
    }
  }
  return refs;
}
