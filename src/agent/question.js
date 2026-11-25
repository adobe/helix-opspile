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

import { entryOf } from '../drafts.js';
import { isStaffDomain } from '../lookup.js';
import { announceRequest } from '../requestkeys.js';
import {
  cleanItems, createQuestion, MAX_WHY, PURPOSES,
} from '../questions.js';
import { modelProblem } from './model.js';
import { sidebarAuthor } from './channelrequest.js';
import { personOf } from './memberrequest.js';

/**
 * The agent's side of questions (the record is src/questions.js): `ask_teammate` asks a person
 * on the thread's teams what neither the knowledge bases nor the thread say, with its best guess
 * at each question. The person answers in their inbox (src/requestthreads.js, kind `question`),
 * and the agent is told as an input of its own (`answerNote`, `answered`), trusted as a staff
 * member's: that turn finishes the runbook, the reply or the fact it asked for, and tells whoever
 * it was answering in the sidebar then. Unlike a request for a tool or a change, a question may be
 * asked in any turn: it changes nothing, and only who may work the thread can be asked.
 */

const PURPOSE_TEXT = { runbook: 'a runbook', reply: 'a reply to the customer', fact: 'a fact to file' };

/** The entry's title, as the inbox shows it. */
async function titleOf(env, key) {
  const row = await env.DB.prepare(`SELECT COALESCE(l.title, t.title) AS title FROM threads t
    LEFT JOIN labels l ON l.thread = t.thread WHERE t.thread = ?`).bind(key).first();
  return (row && row.title) || null;
}

/** `email`, a person on one of `teams`, with the name the inbox knows them by; or null. */
async function onTeams(env, email, teams) {
  return env.DB.prepare(`SELECT p.email, p.name FROM team_members m JOIN people p ON p.id = m.person
    WHERE LOWER(p.email) = ? AND m.team IN (SELECT value FROM json_each(?)) LIMIT 1`)
    .bind(email, JSON.stringify(teams)).first();
}

/**
 * The agent's `ask_teammate`: stores the question and tells the inboxes of the thread's teams,
 * where the person sees it. `ctx` is the tools' context. `{ question }`, or `{ error, question? }`.
 */
export async function askTeammate(ctx, args = {}, now = new Date()) {
  const { env } = ctx;
  const t = await ctx.target();
  const entry = t && t.key ? await entryOf(env, t.key) : null;
  if (!entry) {
    return { error: 'Your thread is not in the inbox: nobody was asked.' };
  }
  if (!args.email && !String(args.name || '').trim()) {
    return { error: 'Say whom to ask, by their email address or their name: nobody was asked.' };
  }
  const who = await personOf(env, { email: '', name: '' }, { email: args.email, name: args.name });
  if (who.error) {
    return { error: `Nobody was asked: ${who.error}.` };
  }
  if (!isStaffDomain(env, who.email)) {
    return { error: `${who.email} is not a staff address: only colleagues are asked, never customers. Nobody was asked.` };
  }
  const member = await onTeams(env, who.email, entry.teams);
  if (!member) {
    return { error: `${who.name || who.email} is on none of the teams whose inbox has this thread (${entry.teams.join(', ')}), so they could not open it. Suggest them with suggest_expert instead. Nobody was asked.` };
  }
  const sidebar = ctx.sidebarMessage ? await ctx.sidebarMessage() : null;
  const asker = sidebar ? await sidebarAuthor(env, t.key, sidebar) : null;
  if (asker && asker.email.toLowerCase() === who.email) {
    return { error: `${asker.name || asker.email} is the person you are answering: ask them in your answer. Nobody was asked.` };
  }
  const purpose = PURPOSES.includes(args.purpose) ? args.purpose : null;
  if (!purpose) {
    return { error: `Say what the answer is for: ${PURPOSES.join(', ')}. Nobody was asked.` };
  }
  const why = String(args.why || '').trim();
  if (!why || why.length > MAX_WHY) {
    return { error: `Say why you ask, in up to ${MAX_WHY} characters. Nobody was asked.` };
  }
  const cleaned = cleanItems(args.questions);
  if (cleaned.error) {
    return { error: `Nobody was asked: ${cleaned.error}.` };
  }
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const res = await createQuestion(env, id, {
    thread: entry.key,
    team: entry.team,
    title: await titleOf(env, entry.key),
    person: { email: who.email, name: member.name || who.name || null },
    purpose,
    why,
    items: cleaned.items,
    sidebar: asker ? sidebar : null,
  }, now);
  if (res.error) {
    return { error: `Nobody was asked: ${res.error}.`, question: res.question || null };
  }
  console.log(JSON.stringify({
    route: 'agent', action: 'question', id, purpose, items: cleaned.items.length, team: entry.team,
  }));
  await announceRequest(env, 'question', id, { teams: entry.teams });
  return { question: res.question };
}

/** One answered question, as the agent reads it. */
function answerLine(item, answer, i) {
  const a = answer || {};
  const said = [a.pick, a.text && a.pick ? `"${a.text}"` : a.text].filter(Boolean).join(', and wrote ');
  let verdict = '';
  if (item.guess && a.pick) {
    verdict = a.pick === item.guess ? ' (your guess)' : ` (not your guess, ${item.guess})`;
  }
  return `${i + 1}. ${item.text}\n   ${said ? `→ ${said}${verdict}` : '→ no answer to this one'}`;
}

/** Whom the agent tells, when it asked while answering a sidebar message. */
const sidebarLine = (q) => (q.sidebar
  ? `\n\nYou asked while you answered ${q.askedFor || 'someone'} in the sidebar (message ${q.sidebar}): tell them what came of it with sidebar_followup (message ${q.sidebar}), not in your note, which does not reach them.`
  : '');

const DO = {
  runbook: 'Write the runbook now (kb-team, `runbooks/`), or finish the one you drafted, with what they said, and check what you can check yourself first. Cite them as its source (author: human:{by}).',
  reply: 'Update the draft with it, if the thread still needs the reply.',
  fact: 'File it where it belongs (kb-org for this customer, kb-team for everyone), with them as its source (author: human:{by}).',
};

/** What the agent is told of question `q`, closed by `by` (a name). */
export function answerNote(q, by) {
  const head = `${by} (Adobe staff, on the team) answered your question ${q.id}, asked for ${PURPOSE_TEXT[q.purpose]}. It is trusted.`;
  const note = q.note ? `\n\nThey added: ${q.note}` : '';
  if (q.status === 'passed') {
    return `${by} (Adobe staff, on the team) does not know the answer to your question ${q.id} and says ${q.passedTo ? `to ask ${q.passedTo}` : 'to ask someone else'}.${note}\n\nAsk the person they named with ask_teammate, if they are on the team; else say in your note whom the team should ask.${sidebarLine(q)}`;
  }
  if (q.status === 'unknown') {
    return `${by} (Adobe staff, on the team) does not know the answer to your question ${q.id}.${note}\n\nDo not ask them about it again. Leave the gap open where you keep it (say so in the knowledge base, not as a guess), and say in your note who else might know.${sidebarLine(q)}`;
  }
  const lines = q.items.map((item, i) => answerLine(item, q.answers[i], i)).join('\n');
  return `${head}\n\n${lines}${note}\n\n${DO[q.purpose].replace('{by}', by)}${sidebarLine(q)}`;
}

/** ThreadAgent.answered: the answer to one of its questions, as an input of its own. */
export async function answered(agent, { id, text }) {
  const problem = modelProblem(agent.env);
  if (problem) {
    return { error: problem };
  }
  const receipt = await agent.harness.submit(text, { operationId: `question:${id}`, whenBusy: 'followUp' });
  return { ok: true, accepted: receipt.accepted };
}
