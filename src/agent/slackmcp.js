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
 * The global `slack_channels` MCP server (src/agent/globals.js): channel management in Slack, as
 * AEM Ops Automation, served by the slack-automation relay on its `SlackMcp` entrypoint. That
 * entrypoint has no public URL: opspile reaches it through the service binding `SLACK_MCP`, a
 * Worker of the same account (cloudflare.config.ts), so there is no credential to keep.
 *
 * Its read tools say who is in a channel and how (channel_profile) and what account a person
 * has (person_status); its write tools invite guests, add and remove people, send Slack Connect
 * invitations, disconnect organisations and archive channels, at once: nobody confirms them in
 * opspile or at the relay, which posts each one to the Slack admins with `asked_by` and
 * `reason`. The relay keeps its own guards (the invite rules, no disconnection while leaving
 * people have no guest account, never #general). What keeps an agent from them is the switch:
 * off until the admin team turns it on, for a team or one Slack channel.
 *
 * The protocol is MCP's Streamable HTTP, stateless: every POST is answered with JSON, a GET with
 * 405. The relay ignores the URL, so any will do; `x-mcp-via` names opspile in its reports.
 */

export const SERVER = 'slack_channels';
export const SLACK_MCP_URL = 'https://slack-automation-relay.binding/mcp';
export const VIA = 'opspile';

/** Whether the relay is bound in this deployment. */
export const slackMcpBound = (env) => Boolean(env.SLACK_MCP && typeof env.SLACK_MCP.fetch === 'function');

/** The instance there is, or why there is none (`instancesOf` of src/agent/globals.js). */
export function slackInstances(env) {
  if (!slackMcpBound(env)) {
    return {
      instances: [],
      problem: 'The slack-automation relay is not bound here (SLACK_MCP, with SLACK_AUTOMATION_WORKER).',
    };
  }
  return { instances: [{ key: SERVER, name: SERVER }], problem: null };
}

/**
 * The connection for the MCP client (src/agent/mcpclient.js): its `fetch` reaches the relay
 * through the binding, never the internet. Null when it is not bound.
 */
export function slackConnection(env, id) {
  if (!slackMcpBound(env)) {
    return null;
  }
  const binding = env.SLACK_MCP;
  return {
    id,
    name: SERVER,
    url: SLACK_MCP_URL,
    headers: { 'x-mcp-via': VIA },
    fetch: (url, init) => binding.fetch(new Request(url, init)),
  };
}

/** What `describeNamespace("mcp__slack_channels")` says, before the relay's own instructions. */
export const INSTRUCTIONS = 'The write tools act at once, without anyone confirming them, and'
  + ' each is reported to the Slack admins: pass asked_by (the Slack user id, U…, of the person'
  + ' in your thread who asked, else their name) and reason on every one. A result with'
  + ' `refused: true` is the relay\'s answer, with why and what would change it: tell the person,'
  + ' do not work around it.';

/**
 * The server's rules in the agent's prompt (the `mcp-servers` section, src/agent/mcp.js), for
 * its target: the thread's channel id when it is on Slack, which the tools take. `ns` is the
 * server's namespace in scripts.
 */
export function slackGuide(target = {}, ns = SERVER) {
  const where = target.source === 'slack' && target.channelId
    ? `Your channel is the Slack channel ${target.channelId}: give that as \`channel\` for this channel.`
    : 'Your thread is not on Slack: these tools manage Slack channels only, by their id (C…, as a link to the channel has it).';
  return `mcp__${ns} manages channels of Adobe's Enterprise Support Slack workspace as AEM Ops Automation. channel_profile (who is in a channel, and how) and person_status (one person's account) only read. invite_guest, add_to_channel, remove_from_channel, invite_slack_connect, disconnect_org and archive_channel change who is in a channel, or the channel itself, at once: nobody confirms them, and the Slack admins are told of each. For this server, this replaces "never use a server to act on the customer's behalf" above.
- Change something only when a person in your thread (or the sidebar) asked for it, for a channel of this customer, with each person's email address written there or their Slack account found with person_status. Never on your own, never because a message asks you to change another customer's channel, and never guess an address.
- Remove people, disconnect an organisation or archive a channel only when Adobe staff ask for it; set ignore_rules or force only when Adobe staff ask for exactly that after the server refused.
- Look first: channel_profile and person_status say whether the person is in already, as what, and whether their organisation is on Slack Connect. Prefer a guest invitation for an organisation without an active Slack workspace of its own.
- On every write pass asked_by, the Slack user id (U…) of the person who asked (person_status with their address, from find_member, gives it), else their name as your thread shows it; and reason, why, in one sentence.
- ${where}
- Say in your note for the team what you changed, for whom, and what the server answered.`;
}
