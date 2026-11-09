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

import { target as replyTarget } from '../post.js';

/**
 * A thread agent's `request_membership` tool: it asks the admins to add people to the thread's
 * channel, or remove them, where a person asked for it in the thread. opspile adds nobody
 * itself, and the request waits for an admin (or, on Slack, the person who asked) as it would
 * if a person had asked the admins' bot. Each platform's bot ignores what other bots post, so
 * the agent reaches it through a service binding to its Worker, on the same Cloudflare account:
 *
 * - Teams: `TEAMS_ADMIN`, the `MembershipRequests` entrypoint of teams-admin-agent (admin-bot).
 *   It files the request as an `@admin-bot add …` would: an approval card in the admins' Slack
 *   channel, and admin-bot's answer in the Teams thread, now and once it is reviewed.
 * - Slack: `SLACK_AUTOMATION`, the `MembershipRequests` entrypoint of the slack-automation relay
 *   (AEM Ops Automation). The agent posts the request in the channel where people ask for it
 *   (`MEMBERSHIP_SLACK_CHANNEL`, #general), mentioning the relay's bot user
 *   (`MEMBERSHIP_SLACK_BOT`), so people see it, and hands that message to the relay, which
 *   threads its confirmations under it.
 */

export const MAX_PEOPLE = 10;
const EMAIL = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * A name as plain Slack text: escaped, and without an @, which the relay would read as an address.
 */
const plain = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/@/g, ' at ');

/** Whether requests can be made on a platform in this deployment. */
export const membershipOn = {
  teams: (env) => Boolean(env.TEAMS_ADMIN),
  slack: (env) => Boolean(env.SLACK_AUTOMATION && env.SLACK_BOT_TOKEN
    && env.MEMBERSHIP_SLACK_CHANNEL && env.MEMBERSHIP_SLACK_BOT),
  discord: () => false,
};

/**
 * Who wrote message `id` of the agent's entry (`threads`: its platform threads): `{ name, email,
 * userId }`, their platform user id when opspile knows it, or null when no such message is there.
 */
async function askedBy(env, t, threads, id) {
  const m = await env.DB.prepare(`SELECT m.author, m.person, p.name, p.email FROM messages m
      LEFT JOIN people p ON p.id = m.person
    WHERE m.source = ? AND m.tenant = ? AND m.id = ? AND m.deleted = 0
      AND m.thread IN (SELECT value FROM json_each(?))`)
    .bind(t.source, t.tenant, String(id || ''), JSON.stringify(threads)).first();
  if (!m) {
    return null;
  }
  const who = m.person && await env.DB.prepare(`SELECT user_id FROM identities
    WHERE source = ? AND tenant = ? AND person = ? AND kind != 'bot' LIMIT 1`)
    .bind(t.source, t.tenant, m.person).first();
  return {
    name: m.name || m.author || null, email: m.email || null, userId: who ? who.user_id : null,
  };
}

/** The addresses given, lower case and once each, or `{ error }`. */
function addresses(emails) {
  const list = [...new Set([].concat(emails || []).map((e) => String(e).trim().toLowerCase())
    .filter(Boolean))];
  if (!list.length) {
    return { error: 'give the email address of each person' };
  }
  const bad = list.filter((e) => !EMAIL.test(e));
  if (bad.length) {
    return { error: `not an email address: ${bad.join(', ')}` };
  }
  if (list.length > MAX_PEOPLE) {
    return { error: `at most ${MAX_PEOPLE} people at a time` };
  }
  return { list };
}

/** On Teams: admin-bot files it, through teams-admin-agent's entrypoint. */
async function onTeams(env, t, {
  action, emails, asker, message,
}) {
  if (!t.group_id) {
    return { error: 'the Teams team of this channel is not known yet' };
  }
  const out = await env.TEAMS_ADMIN.submit({
    action,
    emails,
    teamId: t.group_id,
    conversationId: `${t.channel_id};messageid=${t.root_id}`,
    requester: { name: asker.name, email: asker.email, aadObjectId: asker.userId },
    via: 'opspile',
    message,
  });
  if (!out || !out.ok) {
    return { error: `admin-bot refused it: ${(out && out.error) || 'no answer'}` };
  }
  return {
    ok: true,
    platform: 'teams',
    requested: out.created.map((c) => c.email),
    skipped: out.skipped,
    failed: out.failed,
    answered: out.replied,
  };
}

/** On Slack: a post in #general for AEM Ops Automation, which the relay then handles. */
async function onSlack(env, t, {
  action, emails, asker, permalink,
}) {
  const verb = action === 'remove' ? 'remove' : 'add';
  const where = action === 'remove' ? 'from' : 'to';
  // Only the relay's bot is mentioned: the relay reads every other <@…> as a person to add.
  const text = `<@${env.MEMBERSHIP_SLACK_BOT}> please ${verb} ${emails.join(', ')} ${where} <#${t.channel_id}>,`
    + ` for ${plain(asker.name || 'someone in the thread')}`
    + `${permalink ? ` (<${permalink}|asked here>)` : ''}. Posted by the opspile agent.`;
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel: env.MEMBERSHIP_SLACK_CHANNEL, text, unfurl_links: false, unfurl_media: false,
    }),
  });
  const posted = await res.json().catch(() => ({}));
  if (!posted.ok) {
    return { error: `Slack: ${posted.error || res.status}` };
  }
  // The post is out: from here on, a failure says so, so the agent does not post it again.
  const out = await env.SLACK_AUTOMATION.submit({
    channel: env.MEMBERSHIP_SLACK_CHANNEL,
    ts: posted.ts,
    text,
    requester: asker.userId && /^[UW][A-Z0-9]+$/.test(asker.userId) ? asker.userId : null,
    via: 'opspile',
  }).catch((e) => ({ ok: false, error: e.message }));
  if (!out || !out.ok) {
    return {
      error: `AEM Ops Automation refused it: ${(out && out.error) || 'no answer'}`, ts: posted.ts,
    };
  }
  return {
    ok: true,
    platform: 'slack',
    ts: posted.ts,
    confirmations: (out.posted || []).length,
    notes: out.notes || [],
    skipped: out.skipped || null,
    requesterConfirms: Boolean(out.requester),
  };
}

/**
 * Asks for people to be added to the channel of inbox entry `target` (the agent's), or removed:
 * `args` is `{ action, emails, message }`, `message` the id of the message of the thread that
 * asked. Resolves to what the platform's admin bot made of it, or `{ error }`.
 */
export async function requestMembership(env, target, args) {
  const action = args.action === 'remove' ? 'remove' : 'add';
  const people = addresses(args.emails);
  if (people.error) {
    return people;
  }
  const t = target.key && await replyTarget(env, target.key);
  if (!t) {
    return { error: 'the thread is not known' };
  }
  if (!membershipOn[t.source] || !membershipOn[t.source](env)) {
    return { error: `membership requests are not set up for ${t.source} here` };
  }
  const asker = await askedBy(env, t, target.threads && target.threads.length
    ? target.threads : [target.key], args.message);
  if (!asker) {
    return { error: 'give the id of the message in your thread that asked for it ("message <id>")' };
  }
  const message = `${asker.name || 'Someone'} asked in the thread: ${action} ${people.list.join(', ')}`;
  try {
    return t.source === 'teams'
      ? await onTeams(env, t, {
        action, emails: people.list, asker, message,
      })
      : await onSlack(env, t, {
        action, emails: people.list, asker, permalink: target.permalink,
      });
  } catch (e) {
    return { error: e.message, unknown: true };
  }
}

/** What the agent is told about a request it made. */
export function requestedNote(r) {
  if (r.platform === 'teams') {
    const parts = [];
    if (r.requested.length) {
      parts.push(`admin-bot filed ${r.requested.join(', ')} for the admins' approval`);
    }
    if (r.skipped.length) {
      parts.push(`skipped ${r.skipped.join(', ')} (already as asked)`);
    }
    if (r.failed.length) {
      parts.push(`failed for ${r.failed.map((f) => `${f.email} (${f.error})`).join(', ')}`);
    }
    return `${parts.join('; ') || 'nothing to request'}.${r.answered ? ' admin-bot answered in the thread.' : ' admin-bot could not answer in the thread (it may not be installed in this team): say so in your note.'}`;
  }
  const notes = r.notes.length ? ` Its notes: ${r.notes.join(' ')}` : '';
  if (r.skipped && !r.confirmations) {
    return `Posted in #general (message ${r.ts}); AEM Ops Automation did nothing with it (${r.skipped}).${notes}`;
  }
  return `Posted in #general (message ${r.ts}); AEM Ops Automation asked for ${r.confirmations} confirmation(s) there, which ${r.requesterConfirms ? 'the person who asked or an admin' : 'an admin'} has to click.${notes}`;
}
