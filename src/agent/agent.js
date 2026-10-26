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

import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { Agent } from 'agents';
import { PiHarness } from 'agents/harness/pi';
import { createInlineCodemodeSandbox } from '@earendil-works/pi-codemode/cloudflare';
import { entryOf } from '../drafts.js';
import {
  agentEnabled, deliveryText, entryMessages, markOf, screen, untrusted,
} from './deliver.js';
import { AgentMcp, codemodeExtension, mcpExtension } from './mcp.js';
import { agentProvider, modelProblem, modelRef } from './model.js';
import { opspileExtension, staffExtension } from './tools.js';

/**
 * One agent per inbox entry (a thread, or a re-threaded group under its first thread's key),
 * in a Durable Object named by that key, running Pi (pi-durable) through the Agents SDK's
 * PiHarness: its transcript, tool calls and retries live in this object's SQLite and survive
 * evictions and deploys. An agent named `kb:<team>:<org>` has no thread; it only files
 * knowledge that staff share with it.
 *
 * It is told about new messages (`deliver`, poked by the NORMALIZE queue), about a day
 * without any (`idle`, a schedule), and about knowledge staff share (`seed`).
 *
 * Code mode: the agent can write JavaScript that calls its tools (`codemode`, QuickJS), and
 * the MCP servers of its team and customer are reachable only that way (src/agent/mcp.js).
 * The scripts run on this object's thread (`createInlineCodemodeSandbox`): one object per
 * thread, so a script that computes holds up only its own agent, and only up to the
 * interrupt budget.
 */

export const IDLE_SECONDS = 24 * 60 * 60;
const TARGET_TTL_MS = 5 * 60 * 1000;
const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;
// QuickJS interrupt polls a script may compute for between tool calls: about 5 s on Workers.
const SCRIPT_INTERRUPT_BUDGET = 50_000;

const IDLE_PROMPT = 'Nothing has been posted in the thread for a day. Look at where it stands:'
  + ' if something worth remembering came out of it, put it into the knowledge bases; if the'
  + ' team owes the customer an answer or a follow-up, make sure the draft has it; otherwise'
  + ' change nothing.';

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class ThreadAgent extends Agent {
  constructor(ctx, env) {
    super(ctx, env);
    this.registry = createRegistry();
    this.mcp = new AgentMcp(env, ctx.storage, { agent: () => this.name });
    this.harness = new PiHarness({
      harness: async ({ storage, context, onWake }) => {
        const models = createModels();
        models.setProvider(agentProvider(env));
        const agent = {
          env,
          hasThread: !this.name.startsWith('kb:'),
          target: () => this.target(),
          verdicts: (messages) => this.verdicts(messages),
        };
        // In this order, which is the system prompt's: opspile, code mode, the MCP servers,
        // and the staff's instructions last. A reinstall replaces an extension in place.
        this.registry.install(opspileExtension(agent));
        this.installMcp(await this.mcp.current());
        this.registry.install(staffExtension(agent));
        this.mcpInstalled = true;
        return Harness.open(storage, {
          models,
          registry: this.registry,
          onWake,
          settings: {
            retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
            afterFailedRun: 'continue',
          },
        }, context);
      },
      defaults: env.AGENT_MODEL ? { model: modelRef(env), thinkingLevel: 'medium' } : {},
    });
    this.lifecycle.use(this.harness);
  }

  /** Code mode and the MCP tools of `catalog`. */
  installMcp(catalog) {
    this.sandbox ??= createInlineCodemodeSandbox({
      timeoutMs: SCRIPT_TIMEOUT_MS,
      interruptBudget: SCRIPT_INTERRUPT_BUDGET,
    });
    this.registry.install(codemodeExtension(catalog, this.sandbox));
    this.registry.install(mcpExtension(catalog, (...args) => this.mcp.call(...args)));
  }

  /**
   * Before the agent is told something: are its MCP servers still the configured ones? A
   * change is installed at once when Pi is open, else when it opens. A failure keeps the
   * servers it had.
   */
  async syncMcp() {
    try {
      const { changed, catalog } = await this.mcp.refresh(await this.target());
      if (changed && this.mcpInstalled) {
        this.installMcp(catalog);
      }
      if (changed) {
        console.log(JSON.stringify({
          route: 'agent',
          mcp: 'catalog',
          servers: catalog.servers.length,
          tools: catalog.servers.reduce((n, s) => n + s.tools.length, 0),
          unavailable: catalog.servers.filter((s) => s.error).length,
        }));
      }
    } catch (e) {
      console.log(JSON.stringify({ route: 'agent', mcp: 'sync failed', error: e.message }));
    }
  }

  /** What this agent works on: the inbox entry, its team and customer. Cached briefly. */
  async target() {
    if (this.cachedTarget && Date.now() - this.cachedTarget.at < TARGET_TTL_MS) {
      return this.cachedTarget.value;
    }
    let value;
    const kb = /^kb:([^:]*):(.*)$/.exec(this.name);
    if (kb) {
      value = {
        key: null, team: kb[1] || null, org: kb[2] || null, threads: [],
      };
    } else {
      const entry = await entryOf(this.env, this.name);
      const row = entry && await this.env.DB.prepare(`SELECT org, kind, channel_id, channel_name, source
        FROM threads WHERE thread = ?`).bind(entry.key).first();
      const root = entry && await this.env.DB.prepare(`SELECT permalink FROM messages
        WHERE thread = ? AND permalink IS NOT NULL ORDER BY at LIMIT 1`).bind(entry.key).first();
      const about = row && await this.env.DB.prepare('SELECT name, type FROM orgs WHERE slug = ?')
        .bind(row.org).first().catch(() => null);
      value = {
        key: entry ? entry.key : this.name,
        orgName: (about && about.name) || null,
        orgType: (about && about.type) || 'customer',
        team: entry ? entry.team : null,
        org: row ? row.org : null,
        kind: row ? row.kind : null,
        channelId: row ? row.channel_id : null,
        channelName: row ? row.channel_name : null,
        source: row ? row.source : null,
        permalink: root ? root.permalink : null,
        threads: entry ? entry.keys : [],
      };
    }
    this.cachedTarget = { at: Date.now(), value };
    return value;
  }

  /** Clef verdicts for the untrusted ones among `messages`, by message id, checked once each. */
  async verdicts(messages) {
    const out = new Map();
    const checks = messages.filter(untrusted);
    for (let i = 0; i < checks.length; i += 100) {
      const batch = checks.slice(i, i + 100);
      // eslint-disable-next-line no-await-in-loop
      const stored = await this.ctx.storage.get(batch.map((m) => `verdict:${m.id}`));
      for (const m of batch) {
        let v = stored.get(`verdict:${m.id}`);
        if (!v) {
          // eslint-disable-next-line no-await-in-loop
          v = await screen(this.env, m);
          // eslint-disable-next-line no-await-in-loop
          await this.ctx.storage.put(`verdict:${m.id}`, v);
          console.log(JSON.stringify({
            route: 'agent', check: 'injection', message: m.id, p: v.p, flagged: v.flagged,
          }));
        }
        out.set(m.id, v);
      }
    }
    return out;
  }

  /** Tells the agent about the messages it has not seen. Called for every new message. */
  async deliver() {
    const problem = modelProblem(this.env);
    if (problem) {
      return { result: 'skip', reason: problem };
    }
    const t = await this.target();
    if (!t.key || t.kind !== 'channel' || !await agentEnabled(this.env, t.channelId)) {
      return { result: 'skip', reason: 'no agent for this thread' };
    }
    const entry = await entryMessages(this.env, t.key);
    const mark = await this.ctx.storage.get('mark');
    const fresh = (entry ? entry.messages : []).filter((m) => !mark || markOf(m) > mark);
    if (!fresh.length) {
      return { result: 'unchanged' };
    }
    const verdicts = await this.verdicts(fresh);
    const last = markOf(fresh[fresh.length - 1]);
    const input = deliveryText(entry, fresh, verdicts, { first: !mark });
    await this.syncMcp();
    const receipt = await this.harness.submit(input, {
      operationId: `messages:${last}`,
      whenBusy: 'steer',
    });
    await this.ctx.storage.put('mark', last);
    await this.armIdle(last);
    const flagged = [...verdicts.values()].filter((v) => v.flagged).length;
    return {
      result: 'delivered', messages: fresh.length, flagged, accepted: receipt.accepted,
    };
  }

  /** Wakes the agent a day after the latest message, unless another one comes first. */
  async armIdle(mark) {
    const previous = await this.ctx.storage.get('idle');
    if (previous) {
      await this.cancelSchedule(previous).catch(() => false);
    }
    const s = await this.schedule(IDLE_SECONDS, 'idle', { mark });
    await this.ctx.storage.put('idle', s.id);
  }

  /** Schedule callback: a day without messages. */
  async idle(payload) {
    const mark = await this.ctx.storage.get('mark');
    if (!payload || payload.mark !== mark || modelProblem(this.env)) {
      return;
    }
    // Turned off since: no wrap-up either.
    const t = await this.target();
    if (!t.key || !await agentEnabled(this.env, t.channelId)) {
      return;
    }
    await this.ctx.storage.delete('idle');
    await this.syncMcp();
    await this.harness.submit(IDLE_PROMPT, { operationId: `idle:${mark}`, whenBusy: 'followUp' });
  }

  /** Knowledge shared by a staff member, to be filed in the knowledge bases. */
  async seed({ by, text }) {
    const problem = modelProblem(this.env);
    if (problem) {
      return { error: problem };
    }
    const note = `${by} (Adobe staff) shares this knowledge. It is trusted. File what is worth`
      + ' keeping in the right knowledge base (kb-org for this customer, kb-team for everyone),'
      + ` extending existing concepts where they fit, with ${by} as the source`
      + ` (author: human:${by}). Do not change the draft because of it unless it changes what`
      + ` the customer should be told.\n\n<staff-note>\n${text}\n</staff-note>`;
    await this.syncMcp();
    const receipt = await this.harness.submit(note, {
      operationId: `seed:${(await sha256(`${by}\n${text}`)).slice(0, 32)}`,
      whenBusy: 'followUp',
    });
    return { ok: true, accepted: receipt.accepted };
  }

  /** What the agent is doing, for the inbox and for checks. */
  async status() {
    const catalog = await this.mcp.current();
    return {
      name: this.name,
      model: this.env.AGENT_MODEL || null,
      problem: modelProblem(this.env),
      mark: (await this.ctx.storage.get('mark')) || null,
      pending: await this.harness.pending(),
      mcp: catalog.servers.map((s) => ({
        name: s.name, scope: s.scope, tools: s.tools.length, error: s.error,
      })),
    };
  }
}
