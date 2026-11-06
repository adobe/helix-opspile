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
import {
  createRegistry, defineExtension, GenerationTask, Harness, hook,
} from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Agent } from 'agents';
import { PiHarness, ROOT_SESSION } from 'agents/harness/pi';
import { createInlineCodemodeSandbox } from '@earendil-works/pi-codemode/cloudflare';
import { Workspace } from '@cloudflare/computer';
import { WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell';
import curlModules from '@cloudflare/computer/shell/curl';
import jqModules from '@cloudflare/computer/shell/jq';
import { agentSubject, modelUsage, objectMeter } from '../cogs/meter.js';
import { entryOf } from '../drafts.js';
import { armTag, cacheRetention } from '../experiments.js';
import { toolsFor } from './agenttools.js';
import { deliver, idle, verdictsOf } from './delivery.js';
import { discarded, discardNote } from './discard.js';
import { COMPUTER_CWD, computerEnv, ensureCwd } from './computer.js';
import { AgentMcp, codemodeExtension, mcpExtension } from './mcp.js';
import { agentProvider, modelProblem, modelRef } from './model.js';
import { seed, seedPin } from './seed.js';
import { agentToolsExtension, opspileExtension, staffExtension } from './tools.js';
import {
  keepThreadFiles, mountList, UPLOADS_DIR, uploadsMount,
} from '../threadfiles.js';
import { keepTurn } from './kept.js';
import { traceSteps } from './trace.js';
import { latestTurn } from './turn.js';

/**
 * One agent per inbox entry (a thread, or a re-threaded group under its first thread's key),
 * in a Durable Object named by that key, running Pi (pi-durable) through the Agents SDK's
 * PiHarness: its transcript, tool calls and retries live in this object's SQLite and survive
 * evictions and deploys. An agent named `kb:<team>:<org>` has no thread; it only files
 * knowledge that staff share with it. `kb:<team>:` is the same with no customer: it has no
 * kb-org at all.
 *
 * It is told about new messages (`deliver`, poked by the NORMALIZE queue), about a day
 * without any (`idle`, a schedule), about knowledge staff share (`seed`, in a session of its own
 * when staff chose the knowledge base: src/agent/seed.js), and about a draft of its that a person
 * discarded (`discarded`).
 *
 * Code mode: the agent can write JavaScript that calls its tools (`codemode`, QuickJS), and
 * the MCP servers of its team and customer are reachable only that way (src/agent/mcp.js).
 * The scripts run on this object's thread (`createInlineCodemodeSandbox`): one object per
 * thread, so a script that computes holds up only its own agent, and only up to the
 * interrupt budget.
 *
 * Tools the team turns on (src/agent/agenttools.js): `post_message` (with `add_reaction`), and
 * `computer`, pi's bash tool on Cloudflare Computer, whose Workspace lives in this object's
 * SQLite (src/agent/computer.js). Its shell, in a Dynamic Worker, reaches the files back through
 * `__getWorkspaceStub()` (the Worker exports WorkspaceServiceProxy for that), and the network
 * through SecretGateway (src/agent/gateway.js), which adds the team's and the customer's
 * secrets where the shell names them.
 */

const TARGET_TTL_MS = 5 * 60 * 1000;
const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;
// QuickJS interrupt polls a script may compute for between tool calls: about 5 s on Workers.
const SCRIPT_INTERRUPT_BUDGET = 50_000;

// The platform ids of the agent's latest posts: they come back as messages, which it is not told.
const MAX_POSTED = 50;

// The model's tokens, from pi's ledger, a little after each model round (the round's commit
// lands after its hooks), and at most this often for the object's storage.
const METER_DELAY_MS = 2000;
// The finished turn is kept for the inbox (src/agent/kept.js) a little after the answer, once its
// run has ended; asked again a few times while the transcript still says it works.
const KEEP_DELAY_MS = 2000;
const KEEP_TRIES = 3;
const SIZE_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Meters the agent's model use after each round of tools and each answer, and keeps the turn
 * an answer, or a failed request, ends for the inbox.
 */
const cogsExtension = (agent) => defineExtension({
  name: 'opspile-cogs',
  hooks: [hook(GenerationTask, {
    afterTools: () => { agent.meterSoon(); },
    afterResponse: (message) => {
      if (message && (message.stopReason === 'error' || message.stopReason === 'aborted')) {
        agent.keepTurnSoon();
      }
    },
    onYield: () => {
      agent.meterSoon();
      agent.keepTurnSoon();
      return undefined;
    },
  })],
});

export class ThreadAgent extends Agent {
  constructor(ctx, rawEnv) {
    // Its work is counted for COGS as its thread's (src/cogs/meter.js): the bindings, and the
    // model's tokens (`meterModel`).
    const self = {};
    const cogs = objectMeter(rawEnv, {
      via: 'agent',
      subject: () => {
        try {
          return agentSubject(self.agent && self.agent.name);
        } catch {
          return {};
        }
      },
    });
    const { env } = cogs;
    super(ctx, env);
    self.agent = this;
    this.cogs = cogs;
    this.registry = createRegistry();
    // Not `this.mcp`: the Agents SDK's own MCP client manager lives there, and the SDK calls it
    // (listPrompts, listTools) when the agent starts.
    this.servers = new AgentMcp(env, ctx.storage, { target: () => this.target() });
    this.harness = new PiHarness({
      harness: async ({ storage, context, onWake }) => {
        const models = createModels();
        // The prompt cache's retention, per request: the thread's arm while the experiment runs
        // (src/experiments.js), else the `long` asked for below.
        models.setProvider(agentProvider(env, { cacheRetention: () => cacheRetention(this.name) }));
        const agent = {
          env,
          // The object's name, which the computer's gateway knows it by (src/agent/secrets.js).
          name: this.name,
          hasThread: !this.name.startsWith('kb:'),
          target: () => this.target(),
          verdicts: (messages) => this.verdicts(messages),
          posted: (id) => this.posted(id),
          pinned: (session) => seedPin(this, session),
        };
        this.agentContext = agent;
        // In this order, which is the system prompt's: opspile, the tools the team turned on,
        // code mode, the MCP servers, and the staff's instructions last. A reinstall replaces
        // an extension in place.
        this.registry.install(opspileExtension(agent));
        this.registry.install(agentToolsExtension(agent, await this.currentTools()));
        this.installMcp(await this.servers.current());
        this.registry.install(staffExtension(agent));
        this.registry.install(cogsExtension(this));
        this.mcpInstalled = true;
        return Harness.open(storage, {
          models,
          registry: this.registry,
          // The bash tool's environment: the computer, while it is on.
          env: () => (this.tools && this.tools.includes('computer') ? this.computer() : undefined),
          onWake,
          settings: {
            retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
            afterFailedRun: 'continue',
            // One-hour prompt cache. Turns on one thread are often minutes apart, past
            // pi's five-minute default, so that cache was rewritten on almost every
            // request. Bedrock bills a 1h write higher and a later hit as a read.
            // Compaction requests ask for none. The provider puts an experiment's arm in
            // its place while one runs.
            stream: { cacheRetention: 'long' },
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
    this.registry.install(mcpExtension(catalog, (...args) => this.servers.call(...args)));
  }

  /**
   * Before the agent is told something: are its MCP servers still the configured ones? A
   * change is installed at once when Pi is open, else when it opens. A failure keeps the
   * servers it had.
   */
  async syncMcp() {
    try {
      const { changed, catalog } = await this.servers.refresh(await this.target());
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

  /** The switchable tools last installed (src/agent/agenttools.js), from storage at first. */
  async currentTools() {
    this.tools ??= (await this.ctx.storage.get('tools')) || [];
    return this.tools;
  }

  /**
   * Before the agent is told something: are its switchable tools still the ones turned on? A
   * change is installed at once when Pi is open, else when it opens. A failure keeps them.
   */
  async syncTools() {
    try {
      const before = await this.currentTools();
      const now = await toolsFor(this.env, await this.target());
      if (now.join(',') === before.join(',')) {
        return;
      }
      this.tools = now;
      await this.ctx.storage.put('tools', now);
      if (this.agentContext) {
        this.registry.install(agentToolsExtension(this.agentContext, now));
      }
      console.log(JSON.stringify({ route: 'agent', tools: now }));
    } catch (e) {
      console.log(JSON.stringify({ route: 'agent', tools: 'sync failed', error: e.message }));
    }
  }

  /** The agent's computer, as pi's environment: a Workspace in this object, made on first use. */
  computer() {
    this.computerEnv ??= computerEnv(async () => {
      const ws = this.workspace();
      await ws.ready();
      if (!this.computerReady) {
        await ensureCwd(ws.fs);
        this.computerReady = true;
      }
      return ws;
    });
    return this.computerEnv;
  }

  /**
   * Where the shell reaches the network: through the Worker's SecretGateway, which puts the
   * team's and the customer's secrets into the requests that name them (src/agent/secrets.js)
   * and lets the others through as they are. It knows this agent by name; the revision is
   * fixed, as the name is.
   */
  egress() {
    const gateway = this.ctx.exports && this.ctx.exports.SecretGateway;
    return gateway
      ? { mode: 'http-gateway', gateway: gateway({ props: { agent: this.name } }), revision: 'secrets-1' }
      : { mode: 'direct' };
  }

  /**
   * The Workspace of the computer: files in this object's SQLite, a shell in a Dynamic Worker
   * that reaches the internet (curl) without a filter, with its secrets (`egress`).
   */
  workspace() {
    this.ws ??= new Workspace({
      storage: this.ctx.storage,
      backends: [
        new WorkerShellBackend({
          id: 'shell',
          loader: this.env.LOADER,
          workspace: { binding: 'AGENTS', id: this.ctx.id.toString(), name: this.name },
          ctx: this.ctx,
          commands: [jqModules, curlModules],
          egress: this.egress(),
        }),
      ],
      ...(this.env.FILES ? {
        mounts: {
          [`${COMPUTER_CWD}/${UPLOADS_DIR}`]: uploadsMount(this.env.FILES, () => this.ctx.storage.get('uploads')),
        },
      } : {}),
    });
    return this.ws;
  }

  /**
   * Puts the files of the thread's messages it may read into its computer: copied if they are
   * not yet, and only where it has a computer. A thread goes on without them if this fails.
   */
  async syncUploads(entry) {
    if (!this.env.FILES || !(this.tools && this.tools.includes('computer'))) {
      return;
    }
    try {
      const messages = entry ? entry.messages : [];
      const verdicts = await this.verdicts(messages);
      const readable = (m) => !(verdicts.get(m.id) && verdicts.get(m.id).flagged);
      const copies = await keepThreadFiles(this.env, messages, { readable });
      await this.setUploads(mountList(copies));
    } catch (e) {
      console.log(JSON.stringify({ route: 'agent', uploads: 'failed', error: e.message }));
    }
  }

  /**
   * Stores what the mount holds. A Workspace fills its mount once, so a change takes a new one,
   * and the copy in this object's SQLite goes when the first of its files expires.
   */
  async setUploads(list) {
    const before = await this.ctx.storage.get('uploads');
    if (JSON.stringify(before || {}) === JSON.stringify(list)) {
      return;
    }
    const previous = await this.ctx.storage.get('uploads-expiry');
    if (previous) {
      await this.cancelSchedule(previous).catch(() => false);
      await this.ctx.storage.delete('uploads-expiry');
    }
    if (Number.isFinite(list.expires)) {
      const s = await this.schedule(new Date(list.expires), 'expireUploads');
      await this.ctx.storage.put('uploads-expiry', s.id);
    }
    // Last: a failure above finds the list as it was and tries again, instead of finding nothing
    // to do with no schedule left to empty the mount.
    await this.ctx.storage.put('uploads', list);
    this.ws = null;
  }

  /** Schedule callback: the oldest file of the thread is 30 days old. */
  async expireUploads() {
    const list = await this.ctx.storage.get('uploads');
    if (!list) {
      return;
    }
    await this.ctx.storage.delete('uploads-expiry');
    const copies = (list.all || []).filter((c) => c.expires > Date.now());
    await this.setUploads(mountList(copies));
    // The computer may be asleep: the expired files leave its SQLite now, not at its next use.
    await this.workspace().ready();
  }

  /** For the shell in the Dynamic Worker (through WorkspaceServiceProxy): the files. */
  async __getWorkspaceStub() {
    const ws = this.workspace();
    await ws.ready();
    return ws.stub();
  }

  /** Remembers a message the agent posted, so that it is not told about it. */
  async posted(id) {
    if (!id) {
      return;
    }
    const list = (await this.ctx.storage.get('posted')) || [];
    await this.ctx.storage.put('posted', [...list.filter((x) => x !== String(id)), String(id)]
      .slice(-MAX_POSTED));
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
      const row = entry && await this.env.DB.prepare(`SELECT org, kind, tenant, channel_id, channel_name, source
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
        tenant: row ? row.tenant : null,
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

  /** Clef verdicts for the untrusted ones among `messages` (src/agent/delivery.js). */
  async verdicts(messages) {
    return verdictsOf(this, messages);
  }

  /** Tells the agent about the messages it has not seen (src/agent/delivery.js). */
  async deliver(options) {
    this.meterModel();
    return deliver(this, options);
  }

  /** Schedule callback: a day without messages. */
  async idle(payload) {
    this.meterModel();
    return idle(this, payload);
  }

  /** Knowledge shared by a staff member, to be filed in the knowledge bases. */
  async seed(note) {
    return seed(this, note);
  }

  /** A person discarded the agent's draft (src/agent/discard.js). */
  async discarded(note) {
    return discarded(this, note);
  }

  /** Schedule callback: tells the agent who discarded its draft, unless it came back. */
  async discardNote(payload) {
    return discardNote(this, payload);
  }

  /**
   * Its trace, for the admin team: what `status` says, and the steps of its active transcript
   * (src/agent/trace.js).
   */
  async trace(options = {}) {
    const entries = await this.harness.messages().catch(() => []);
    const calls = await this.servers.calls().catch(() => []);
    return { status: await this.status(), ...traceSteps(entries, { ...options, calls }) };
  }

  /** `meterModel`, shortly: the ledger has the round once its commit lands. */
  meterSoon() {
    if (this.meterTimer) {
      return;
    }
    this.meterTimer = setTimeout(() => {
      this.meterTimer = null;
      this.meterModel().catch(() => {});
    }, METER_DELAY_MS);
  }

  /**
   * What the model used since the last time, from pi's ledger of the session (`usage`), as
   * Bedrock tokens for COGS; and, once a day, what the object keeps in its SQLite. One at a
   * time, so a round is counted once.
   */
  meterModel() {
    this.metering = (this.metering || Promise.resolve()).then(() => this.meterModelNow())
      .catch(() => {});
    return this.metering;
  }

  async meterModelNow() {
    const { scope } = this.cogs;
    if (!scope || !this.cogs.meter.enabled) {
      return;
    }
    const pi = await this.harness.pi();
    const ledger = await pi.usage(BACKGROUND_CONTEXT);
    const { now, adds } = modelUsage(
      await this.ctx.storage.get('cogs:usage'),
      ledger,
      this.env.AGENT_MODEL,
      armTag(this.name),
    );
    for (const [metric, model, q] of adds) {
      scope.add('bedrock', metric, model, q);
    }
    await this.ctx.storage.put('cogs:usage', now);
    const sizedAt = (await this.ctx.storage.get('cogs:sized')) || 0;
    if (Date.now() - sizedAt > SIZE_EVERY_MS && this.ctx.storage.sql) {
      const t = await this.target();
      await this.env.DB.prepare(`INSERT INTO cogs_objects (name, org, team, bytes, at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET org = excluded.org,
        team = excluded.team, bytes = excluded.bytes, at = excluded.at`)
        .bind(
          this.name,
          t.org || '',
          t.team || '',
          Number(this.ctx.storage.sql.databaseSize) || 0,
          new Date().toISOString(),
        ).run();
      await this.ctx.storage.put('cogs:sized', Date.now());
    }
  }

  /** The thread's latest turn (src/agent/turn.js), and what is pending. */
  async latestTurn() {
    const pending = await this.harness.pending();
    // The turn is the thread's; a pinned seed session works beside it, and is in `pending`.
    const busy = pending.some((p) => p.session === ROOT_SESSION && p.status !== 'parked');
    return { pending, turn: latestTurn(await this.harness.messages().catch(() => []), { busy }) };
  }

  /**
   * Keeps a finished `turn` for the inbox (src/agent/kept.js), once: what was kept last is in
   * storage, so a woken object does not write it again. A turn in progress keeps nothing.
   */
  async keepTurn(turn) {
    if (this.name.startsWith('kb:') || (turn && turn.state === 'working')) {
      return;
    }
    const sig = JSON.stringify(turn || null);
    this.keptSig ??= (await this.ctx.storage.get('kept-turn')) || null;
    if (this.keptSig === sig) {
      return;
    }
    await keepTurn(this.env, this.name, turn);
    await this.ctx.storage.put('kept-turn', sig);
    this.keptSig = sig;
  }

  /** `keepTurn` of the latest turn, shortly: the answer is committed after the hooks run. */
  keepTurnSoon(tries = KEEP_TRIES) {
    if (this.keepTimer) {
      return;
    }
    this.keepTimer = setTimeout(async () => {
      this.keepTimer = null;
      try {
        const { turn } = await this.latestTurn();
        if (turn && turn.state === 'working') {
          if (tries > 1) {
            this.keepTurnSoon(tries - 1);
          }
          return;
        }
        await this.keepTurn(turn);
      } catch (e) {
        console.log(JSON.stringify({ route: 'agent', keep: 'turn failed', error: e.message }));
      }
    }, KEEP_DELAY_MS);
  }

  /** What the agent is doing, for the inbox and for checks. */
  async status() {
    this.meterModel();
    const catalog = await this.servers.current();
    const { pending, turn } = await this.latestTurn();
    // A finished turn the inbox does not have yet (one that ended before this was deployed, or
    // one that stopped half way and counts as failed now): kept behind the answer.
    this.keepTurn(turn).catch((e) => console.log(JSON.stringify({ route: 'agent', keep: 'turn failed', error: e.message })));
    return {
      name: this.name,
      model: this.env.AGENT_MODEL || null,
      problem: modelProblem(this.env),
      mark: (await this.ctx.storage.get('mark')) || null,
      pending,
      turn,
      tools: await this.currentTools(),
      mcp: catalog.servers.map((s) => ({
        name: s.name, scope: s.scope, tools: s.tools.length, error: s.error,
      })),
    };
  }
}
