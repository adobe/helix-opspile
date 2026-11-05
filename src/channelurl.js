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
 * Links to a channel (not to a message in it) on Slack, Teams or Discord, in a message of any
 * of them: a Teams channel's link in a Slack message, a Slack channel's in a Teams post.
 * Pure: the inbox and the Worker both use it (src/channelrefs.js resolves them).
 *
 * - Slack: `https://<workspace>.slack.com/archives/C…` and `https://app.slack.com/client/T…/C…`
 *   (a message's permalink has `/p…` after the channel: src/slackurl.js)
 * - Teams: `https://teams.microsoft.com/l/channel/<channel id>/<name>?groupId=…&tenantId=…`
 *   (also on `teams.cloud.microsoft`), the channel id URL-encoded (`19%3A…%40thread.tacv2`)
 * - Discord: `https://discord.com/channels/<guild>/<channel>` (a message's has a third id)
 */

/** Code (fenced or inline): what was typed, not a link to follow. */
const CODE = /```[\s\S]*?```|`[^`\n]+`/g;
/** A link in markdown or plain text: up to a space, a bracket or a quote. */
const URL_IN_TEXT = /https:\/\/[^\s<>()[\]"'`]+/g;
const SLACK_CHANNEL = '[CG][A-Z0-9]{8,}';
const SLACK_HOST = /^(?:([a-z0-9-]+)\.)*slack\.com$/;
const SLACK_ARCHIVES = new RegExp(`^/archives/(${SLACK_CHANNEL})/?$`);
const SLACK_CLIENT = new RegExp(`^/client/([TE][A-Z0-9]{8,})/(${SLACK_CHANNEL})/?$`);
const TEAMS_HOST = /^teams\.(?:microsoft\.com|cloud\.microsoft)$/;
const TEAMS_CHANNEL = /^\/l\/channel\/([^/]+)(?:\/[^/]*)?\/?$/;
const DISCORD_HOST = /^(?:(?:ptb|canary)\.)?discord(?:app)?\.com$/;
const DISCORD_CHANNEL = /^\/channels\/(\d+)\/(\d+)\/?$/;
/** At most this many distinct channels are looked up per thread. */
const MAX_REFS = 50;

const decodeAmp = (url) => String(url || '').replace(/&amp;/gi, '&').trim();

function decoded(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * The channel one link (the whole string, an href) is to: `{ source, channel, tenant, host }`,
 * or null. `tenant` is the workspace the link says (Slack's `app.slack.com` links, Teams' and
 * Discord's always), else null; `host` is a Slack workspace's host name, which names it too.
 */
export function channelUrlRef(url) {
  let u;
  try {
    u = new URL(decodeAmp(url));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (SLACK_HOST.test(host)) {
    const archives = SLACK_ARCHIVES.exec(u.pathname);
    if (archives) {
      return {
        source: 'slack', channel: archives[1], tenant: null, host,
      };
    }
    const client = host === 'app.slack.com' && SLACK_CLIENT.exec(u.pathname);
    return client ? {
      source: 'slack', channel: client[2], tenant: client[1], host: null,
    } : null;
  }
  if (TEAMS_HOST.test(host)) {
    const m = TEAMS_CHANNEL.exec(u.pathname);
    const channel = m && decoded(m[1]);
    return channel ? {
      source: 'teams', channel, tenant: u.searchParams.get('tenantId') || null, host: null,
    } : null;
  }
  if (DISCORD_HOST.test(host)) {
    const m = DISCORD_CHANNEL.exec(u.pathname);
    return m ? {
      source: 'discord', channel: m[2], tenant: m[1], host: null,
    } : null;
  }
  return null;
}

/** `${source}:${channel}` for a channel link, or null: two links to one channel share it. */
export function channelUrlKey(url) {
  const ref = channelUrlRef(url);
  return ref ? `${ref.source}:${ref.channel}` : null;
}

/**
 * The channel links in markdown texts, outside code: `[{ source, channel, tenant, host }]`,
 * in order, at most MAX_REFS distinct channels.
 *
 * @param {string[]} texts
 */
export function channelUrlRefs(texts) {
  const seen = new Set();
  const refs = [];
  for (const text of texts || []) {
    const bare = String(text || '').replace(CODE, ' ');
    for (const [url] of bare.matchAll(URL_IN_TEXT)) {
      const ref = channelUrlRef(url.replace(/[.,;:!?*_~]+$/, ''));
      const key = ref && `${ref.source}:${ref.channel}`;
      if (key && !seen.has(key) && refs.length < MAX_REFS) {
        seen.add(key);
        refs.push(ref);
      }
    }
  }
  return refs;
}
