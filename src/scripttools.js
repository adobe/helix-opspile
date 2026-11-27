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
 * The tools of the inbox a thread agent's script may call as the person who runs it (its
 * `request_codemode`, src/agent/scriptrequest.js): tools of the inbox's MCP server
 * (src/mcp-tools.js), by the same names, that only read, and that every person has. Through
 * them a script sees what that person sees: the threads of all their teams, their knowledge
 * bases, where the agent sees only its own channel.
 *
 * Declared here, not taken from src/mcp-tools.js, which the agent's code must not import (it
 * imports the whole inbox API): `args` is what the agent is told of each tool's arguments (a
 * trailing `?` for one it may leave out), `about` what it does. test/scriptrequests.test.js
 * keeps them to the real tools: each of them, read-only, with those arguments.
 */
export const SCRIPT_TOOLS = [
  {
    name: 'search_threads',
    args: ['query', 'team?', 'limit?'],
    about: 'threads of every team of the person about `query` (meaning, full text, facts such as URLs and tickets), best match first, each with `thread`, title, customer, channel, `link` and the best-matching message as `snippet`; and `knowledge`, knowledge-base entries about it (`repo`, `path` for get_knowledge)',
  },
  {
    name: 'list_threads',
    args: ['team?', 'customer?', 'waiting_on?', 'resolved?', 'kind?', 'platform?', 'unread_only?', 'offset?', 'limit?'],
    about: 'threads of the person\'s inboxes, latest activity first, by filters (customer names as list_threads shows them; `team` a slug from whoami)',
  },
  {
    name: 'get_thread',
    args: ['thread', 'limit?'],
    about: 'a thread by its `thread` key (as the other tools give it, or slack:<workspace>:<channel>:<ts> from a link) with its latest messages, oldest first, and its draft',
  },
  {
    name: 'get_message',
    args: ['message'],
    about: 'one message whole, by its `message` id from get_thread, for one get_thread cut',
  },
  {
    name: 'get_knowledge',
    args: ['repo', 'path'],
    about: 'a knowledge-base entry that search_threads found, as markdown',
  },
  {
    name: 'whoami',
    args: [],
    about: 'the person: their name and their teams (slugs)',
  },
];

export const SCRIPT_TOOL_NAMES = SCRIPT_TOOLS.map((t) => t.name);

/** `name({ a, b? })`, as the agent is told a tool's signature. */
export const scriptSignature = (t) => `${t.name}(${t.args.length ? `{ ${t.args.join(', ')} }` : ''})`;
