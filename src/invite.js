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
 * A colleague mentioned in a Slack channel they are not in is added to it before the message
 * goes out, so the mention reaches them: Slack notifies no one of a mention in a channel they
 * are not in. This is for whatever the inbox posts, as a person (src/post.js) or as the
 * opspile app (src/agent/posting.js), not for messages written in Slack, which asks there.
 *
 * Only Adobe people (`staff`) are added: anyone else may be a customer, and is never put in
 * another customer's channel. The opspile Slack app adds them (`conversations.invite`, bot
 * scopes `channels:write.invites` and `groups:write.invites` for a private channel), so nobody
 * has to connect their account again for it. It is in every channel opspile reads.
 *
 * Slack says who is in already (`already_in_channel`), so nothing is looked up first, and a
 * listing of members that is out of date does not matter. Nothing here stops the post: a
 * refusal is logged, and what Slack refused for a person is told to whoever posted.
 */

// Up to this many people are added for one message (a post mentions up to 20).
const MAX_INVITES = 10;

// Slack refusing the person, rather than the call as such. (`no_permission` is not: Slack also
// says it when the app is not in the channel.)
const PERSONAL = new Set([
  'cant_invite', 'user_is_restricted', 'org_user_not_in_team', 'invitee_cant_see_channel',
  'ura_max_channels', 'no_external_invite_permission', 'user_not_found',
]);

/**
 * The Adobe people among `mentions` (accounts as src/post.js `knownMentions` gives them) of
 * Slack thread or channel `t`, but not `except` (the account posting).
 */
async function staffMentioned(env, t, mentions, except) {
  const ids = [...new Set(mentions.filter((m) => m && m.kind !== 'bot' && m.id && m.id !== except)
    .map((m) => m.id))];
  if (!ids.length) {
    return [];
  }
  const { results } = await env.DB.prepare(`SELECT i.user_id AS id, COALESCE(p.name, i.name) AS name
    FROM identities i LEFT JOIN people p ON p.id = i.person
    WHERE i.source = 'slack' AND i.tenant = ? AND i.kind = 'person'
      AND MAX(COALESCE(p.staff, 0), COALESCE(i.staff, 0)) = 1
      AND i.user_id IN (SELECT value FROM json_each(?))`)
    .bind(t.tenant, JSON.stringify(ids)).all();
  return results || [];
}

/**
 * Adds the Adobe people `mentions` name to the channel of Slack thread `t` where they are not
 * in it yet: `{ invited, refused }`, each `[{ id, name }]` (`refused` with Slack's `error`), or
 * null when nobody was asked for. `refused` only has what Slack said about a person; a call
 * that failed as such (the app without the scope, Slack away) is logged and refuses nobody.
 *
 * @param {object} env
 * @param {{ source: string, tenant: string, channel_id: string }} t
 * @param {{ id: string, name?: string, kind?: string }[]} mentions
 * @param {{ except?: string, fetch?: typeof fetch }} [options]
 */
export async function inviteMentioned(env, t, mentions, options = {}) {
  if (!t || t.source !== 'slack' || !env.SLACK_BOT_TOKEN || !mentions || !mentions.length) {
    return null;
  }
  const { except, fetch: fetcher = fetch } = options;
  const people = (await staffMentioned(env, t, mentions, except)).slice(0, MAX_INVITES);
  if (!people.length) {
    return null;
  }
  // One person a call: Slack then says of each whether they were added, are in already, or
  // cannot be, where a call for several answers for all of them at once.
  const answers = await Promise.all(people.map(async (p) => {
    try {
      const res = await fetcher('https://slack.com/api/conversations.invite', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel: t.channel_id, users: p.id }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: `http ${res.status}` }));
      return data.ok ? null : String(data.error || 'refused');
    } catch (e) {
      return e.message;
    }
  }));
  const failed = [...new Set(answers.filter((a) => a && a !== 'already_in_channel'
    && !PERSONAL.has(a)))];
  if (failed.length) {
    // The app without the scope, not in the channel, Slack away: about nobody in particular.
    console.warn(JSON.stringify({ route: 'invite', platform: 'slack', error: failed.join(',') }));
  }
  const invited = people.filter((p, i) => answers[i] === null);
  const refused = people.map((p, i) => ({ ...p, error: answers[i] }))
    .filter((p) => PERSONAL.has(p.error));
  if (invited.length || refused.length) {
    console.log(JSON.stringify({
      route: 'invite',
      platform: 'slack',
      invited: invited.length,
      refused: refused.map((p) => p.error),
    }));
  }
  return invited.length || refused.length ? { invited, refused } : null;
}

/** The fields of an answer that say who was added (`invited`) or refused (`uninvited`). */
export const invitedFields = (result) => ({
  ...(result && result.invited.length
    ? { invited: result.invited.map(({ id, name }) => ({ id, name })) } : {}),
  ...(result && result.refused.length
    ? { uninvited: result.refused.map(({ id, name, error }) => ({ id, name, error })) } : {}),
});

/**
 * What an answer's `invited` and `uninvited` (`invitedFields`) say, for an agent or an MCP
 * client, starting with a space: '' for nobody.
 */
export function invitedNote({ invited = [], uninvited = [] } = {}) {
  const name = (p) => p.name || 'someone';
  return [
    invited.length ? ` Added to the channel first, so they see the mention: ${invited.map(name).join(', ')}.` : '',
    uninvited.length ? ` Not in the channel, and Slack would not add them, so they may not see it: ${uninvited.map((p) => `${name(p)} (${p.error})`).join(', ')}.` : '',
  ].join('');
}
