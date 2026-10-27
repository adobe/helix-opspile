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
 * The agent's latest turn, as the inbox shows it under the thread: what it is doing while it
 * works, and its closing note for the team once it is done. Read from the transcript: a turn
 * starts with the last input (`pi.user`: new messages, the day-later wrap-up, a staff note)
 * and runs through the assistant entries and tool results after it.
 */

const MAX_TEXT = 1200;

const DOING = {
  read_thread: 'Reading the thread',
  get_draft: 'Reading the draft',
  read_file: 'Reading an attached file',
  update_draft: 'Updating the draft',
  kb_write: 'Filing what it learned in the knowledge bases',
};

/** What a tool call is doing, in a few words. */
function doing({ name, arguments: args }) {
  if (DOING[name]) {
    return DOING[name];
  }
  if (/^git_/.test(name)) {
    return 'Looking things up in the knowledge bases and repositories';
  }
  if (name !== 'codemode') {
    return 'Working';
  }
  const code = String((args && args.code) || '');
  if (/mcp__browser/.test(code)) {
    return 'Checking a web page';
  }
  return /mcp__github/.test(code) ? 'Looking at GitHub' : 'Running a script';
}

const texts = (m) => (Array.isArray(m.content) ? m.content : [])
  .filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n\n').trim();

const calls = (m) => (Array.isArray(m.content) ? m.content : []).filter((c) => c.type === 'toolCall');

/**
 * `{ state: 'working' | 'done' | 'failed', text, startedAt, endedAt }` for the latest turn of
 * `entries` (the transcript), or null before the first. `busy`: a run is pending.
 */
export function latestTurn(entries, { busy = false } = {}) {
  const list = entries || [];
  const start = list.map((e) => e.kind).lastIndexOf('pi.user');
  if (start < 0) {
    return null;
  }
  const at = (m) => (m && m.timestamp ? new Date(m.timestamp).toISOString() : null);
  const input = (list[start].model || [])[0];
  const assistant = list.slice(start + 1).filter((e) => e.kind === 'pi.assistant')
    .map((e) => (e.model || [])[0]).filter(Boolean);
  const last = assistant[assistant.length - 1];
  const turn = { startedAt: at(input), endedAt: null };
  if (busy || !last || last.stopReason === 'toolUse') {
    const call = last && calls(last).pop();
    return {
      ...turn,
      state: 'working',
      text: call ? doing(call) : 'Reading the new messages',
    };
  }
  if (last.stopReason === 'error' || last.stopReason === 'aborted') {
    return {
      ...turn,
      state: 'failed',
      endedAt: at(last),
      text: `The turn did not finish${last.errorMessage ? `: ${String(last.errorMessage).slice(0, 200)}` : '.'}`,
    };
  }
  const changed = assistant.flatMap(calls).map((c) => c.name);
  const fallback = changed.includes('update_draft') ? 'Updated the draft.' : 'Nothing to change.';
  return {
    ...turn,
    state: 'done',
    endedAt: at(last),
    text: (texts(last) || fallback).slice(0, MAX_TEXT),
  };
}
