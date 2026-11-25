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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { toolsFor } from '../src/agent/agenttools.js';
import { agentToolsExtension, opspileExtension } from '../src/agent/tools.js';
import { agentLabelsFor, applyAgentLabels, setAgentLabels } from '../src/agentlabels.js';
import { inbox } from '../src/api.js';
import { resolve } from '../src/react.js';
import { resolution, resolutionFacts } from '../src/resolve.js';
import { d1 } from './d1.js';
import { quiet } from './fakes.js';

// Made-up people, teams, channels and ids only.
const ME = {
  id: 1, email: 'ada@staff.example', name: 'Ada', teams: [{ slug: 'helix' }],
};
const SLACK = 'slack:E1:C1:1.1';
const inTeam = (t) => [].concat(t).includes('helix');

function env() {
  const DB = d1({
    teams: [{ slug: 'helix', name: 'Helix' }],
    people: [{
      id: 1, email: 'ada@staff.example', name: 'Ada', staff: 1, teams: ['helix'],
    }],
  });
  const sql = (q, ...a) => DB.sqlite.prepare(q).run(...a);
  sql(`INSERT INTO threads (thread, source, tenant, channel_id, root_id, org, team, kind,
      channel_name, path, root_at, last_at, any_at, updated_at)
    VALUES (?, 'slack', 'E1', 'C1', '1.1', 'acme', 'helix', 'channel', 'aem-acme', 'p/',
      '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z',
      '2026-10-21T10:00:00Z')`, SLACK);
  sql(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff, counted)
    VALUES ('slack', 'E1', 'C1', '1.1', ?, '2026-10-21T10:00:00Z', 0, 1)`, SLACK);
  sql(`INSERT INTO labels (thread, next_actor, next_actor_p, kind, kind_p, urgency, resolved_p,
      labeled_through, model, labeled_at)
    VALUES (?, 'us', 0.9, 'question', 0.8, 1, 0.1, '2026-10-21T10:00:00Z', 'clef',
      '2026-10-21T10:02:00Z')`, SLACK);
  return { DB, STAFF_DOMAINS: 'staff.example' };
}

/** A customer (or, with `staff`, Adobe) posts in the thread at `at`. */
function posts(e, id, at, staff = 0) {
  e.DB.sqlite.prepare(`INSERT INTO messages (source, tenant, channel_id, id, thread, at, staff,
    counted) VALUES ('slack', 'E1', 'C1', ?, ?, ?, ?, 1)`).run(id, SLACK, at, staff);
  e.DB.sqlite.prepare('UPDATE threads SET last_at = ?, any_at = ? WHERE thread = ?').run(at, at, SLACK);
}

describe('the agent\'s labels', () => {
  it('replace Clef\'s: a kind until the agent changes it, the rest until a person posts', async () => {
    const e = env();
    await setAgentLabels(e.DB, SLACK, [SLACK], { kind: 'access', urgency: 3, next_actor: 'customer' }, 'x', new Date('2026-10-21T10:01:00Z'));
    const model = e.DB.rows('SELECT * FROM labels')[0];
    let label = applyAgentLabels(model, await agentLabelsFor(e.DB, [SLACK]));
    assert.deepEqual([label.kind, label.urgency, label.next_actor, label.agent], ['access', 3, 'customer', ['kind', 'next_actor', 'urgency']]);

    posts(e, '1.2', '2026-10-21T10:05:00Z', 1);
    label = applyAgentLabels(model, await agentLabelsFor(e.DB, [SLACK]));
    assert.deepEqual([label.kind, label.urgency, label.next_actor, label.agent], ['access', 1, 'us', ['kind']]);
    // No label of Clef's yet: nothing to show.
    assert.equal(applyAgentLabels(null, [{ question: 'kind', value: 'access' }]), null);
  });

  it('show in the inbox, and the agent\'s resolution counts as a staff ✅ until a customer writes', async () => {
    const e = env();
    await setAgentLabels(e.DB, SLACK, [SLACK], { kind: 'access', resolved: 'yes' }, 'confirmed', new Date('2026-10-21T10:01:00Z'));
    const { threads: [entry] } = await inbox(e, ME, 'helix');
    assert.equal(entry.label.kind, 'access');
    assert.deepEqual([entry.resolution.state, entry.resolution.agent, entry.resolution.mine, entry.resolution.by], ['resolved', true, false, ['opspile agent']]);

    posts(e, '1.2', '2026-10-21T10:05:00Z');
    const facts = await resolutionFacts(e, [SLACK]);
    assert.equal(resolution(facts.get(SLACK), null, 1).verdict, 'open');
  });

  it('are taken back with the ✅ button, without an account on the platform', async () => {
    const e = env();
    await setAgentLabels(e.DB, SLACK, [SLACK], { resolved: 'yes' }, 'done');
    const res = await quiet(() => resolve(e, ME, { thread: SLACK, undo: true }, inTeam));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, resolved: false, agent: true });
    assert.deepEqual(e.DB.rows('SELECT * FROM agent_labels'), []);
    // Nothing of the agent's or the person's to take off now.
    const again = await quiet(() => resolve(e, ME, { thread: SLACK, undo: true }, inTeam));
    assert.equal(again.status, 409);
  });
});

describe('resolve_thread and label_thread', () => {
  it('are on by the team\'s switches, and resolve and label the thread in the inbox', async () => {
    const e = env();
    const target = {
      key: SLACK, team: 'helix', org: 'acme', channelId: 'C1', source: 'slack', threads: [SLACK],
    };
    assert.deepEqual(await toolsFor(e, target), []);
    e.DB.sqlite.exec(`INSERT INTO agent_tool_switches (tool, scope, target, enabled, changed_at)
      VALUES ('resolve', 'team', 'helix', 1, '2026-10-21T10:00:00Z'),
        ('label', 'team', 'helix', 1, '2026-10-21T10:00:00Z')`);
    assert.deepEqual(await toolsFor(e, target), ['label', 'resolve']);

    const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-model' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    const agent = {
      env: e, hasThread: true, target: async () => target, verdicts: async () => new Map(),
    };
    registry.install(opspileExtension(agent));
    registry.install(agentToolsExtension(agent, ['label', 'resolve']));
    const ctx = BACKGROUND_CONTEXT;
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
    const root = await harness.root(ctx, { agent: { model: { provider: 'faux', modelId: 'faux-model' } } });
    const results = [];
    let system = '';
    const step = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
    const capture = (next) => (context) => {
      const last = context.messages[context.messages.length - 1];
      results.push({ text: last.content.map((c) => c.text).join(''), error: last.isError });
      return next;
    };
    faux.setResponses([
      (context) => {
        system = context.messages.filter((m) => m.role === 'system')
          .map((m) => Object.values(m.sections || {}).join('\n\n') || m.content).join('\n');
        return step('label_thread', {});
      },
      capture(step('label_thread', { kind: 'access' })),
      capture(step('label_thread', { kind: 'access', waiting_on: 'customer', reason: 'An access request; we asked for the address' })),
      capture(step('resolve_thread', { reason: 'The customer confirmed they are in' })),
      capture(step('resolve_thread', { reason: 'They wrote again', undo: true })),
      capture(step('resolve_thread', { reason: 'Again', undo: true })),
      capture(fauxAssistantMessage('Labeled it.')),
    ]);
    const sub = await root.submit({ type: 'input', content: 'New message in the thread' }, ctx);
    assert.equal((await quiet(() => sub.wait(ctx))).status, 'done');
    await harness.close(ctx);

    assert.match(system, /<resolving>\nThe team turned on resolve_thread/);
    assert.match(system, /<labeling>\nThe team turned on label_thread[^]*- incident: Something is broken/);
    const [shown, noReason, labeled, resolved, undone, nothing] = results;
    assert.equal(shown.text, 'Clef: kind question (80%), urgency normal, waiting on us (90%), resolved no (10%).\nYours: none.');
    assert.ok(noReason.error);
    assert.match(labeled.text, /^Labeled in the inbox\.\nClef: kind question[^\n]*\nYours: kind access \(since [^)]+\), waiting on customer \(since [^)]+\)\.$/);
    assert.match(resolved.text, /^Resolved in the inbox\. Nothing was posted/);
    assert.match(undone.text, /^Your resolution is taken back/);
    assert.ok(nothing.error);
    assert.deepEqual(e.DB.rows('SELECT thread, question, value, reason FROM agent_labels ORDER BY question'), [
      {
        thread: SLACK, question: 'kind', value: 'access', reason: 'An access request; we asked for the address',
      },
      {
        thread: SLACK, question: 'next_actor', value: 'customer', reason: 'An access request; we asked for the address',
      },
    ]);
  });
});
