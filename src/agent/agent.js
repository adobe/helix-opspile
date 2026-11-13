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
import {
  attachKernel, compiledTlsEngine, createCloudflareKernel, fetchTransport, sliccBackend,
} from '@ai-ecoverse/slicc-kernel/cloudflare';
import createTlsEngine from '@ai-ecoverse/wasm-tls-engine';
// wrangler compiles a `.wasm` import when it builds the Worker: a WebAssembly.Module.
import tlsWasm from '@ai-ecoverse/wasm-tls-engine/slicc-tls-engine.wasm';
import { agentSubject, modelUsage, objectMeter } from '../cogs/meter.js';
import { entryOf } from '../drafts.js';
import { armTag, cacheRetention } from '../experiments.js';
import { toolsFor } from './agenttools.js';
import {
  bashDeadline, bashWatchdog, denyBash, runBash,
} from './bashrequest.js';
import { deliver, idle, verdictsOf } from './delivery.js';
import { discarded, discardNote } from './discard.js';
import {
  COMPUTER_CWD, computerEnv, ensureCwd, KERNEL_OUTPUT_DIR,
} from './computer.js';
import {
  commandsOf, DEFAULT_IMAGE, IMAGE_COMMANDS, IMAGE_ROOT, imageDriver, imageTree, readImage,
} from './image.js';
import {
  DEFAULT_RUNTIME, gatewayFetch, imageMount, overWorkspace, shellFor,
} from './kernel.js';
import { AgentMcp, codemodeExtension, mcpExtension } from './mcp.js';
import { agentProvider, modelProblem, modelRef } from './model.js';
import { forward } from './secrets.js';
import { seed, seedPin } from './seed.js';
import { inSidebar, keepAnswers, talk } from './sidebar.js';
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
 * when staff chose the knowledge base: src/agent/seed.js), about a draft of its that a person
 * discarded (`discarded`), about how a command it asked a person to run ended (`runBash`,
 * `denyBash` and their schedules: src/agent/bashrequest.js), and what a person on the team says
 * to it in the inbox's sidebar (`sidebar`, src/agent/sidebar.js), which it answers there, and
 * never in the channel.
 *
 * Code mode: the agent can write JavaScript that calls its tools (`codemode`, QuickJS), and
 * the MCP servers of its team and customer are reachable only that way (src/agent/mcp.js).
 * The scripts run on this object's thread (`createInlineCodemodeSandbox`): one object per
 * thread, so a script that computes holds up only its own agent, and only up to the
 * interrupt budget.
 *
 * Tools the team turns on (src/agent/agenttools.js): `post_message` (with `add_reaction`), and
 * `computer`, pi's bash tool on Cloudflare Computer, whose Workspace lives in this object's
 * SQLite (src/agent/computer.js), with `request_bash`, a command a person runs there for it.
 * Its shell, in a Dynamic Worker, reaches the files back through
 * `__getWorkspaceStub()` (the Worker exports WorkspaceServiceProxy for that), and the network
 * through SecretGateway (src/agent/gateway.js), which adds the team's and the customer's
 * secrets where the shell names them. Where the team chose the SLICC kernel as the computer's
 * shell (src/agent/kernel.js), the kernel runs in this object, on the same Workspace, with the
 * programs of the team's image from the `IMAGES` bucket (src/agent/image.js), and its requests
 * go through the same gateway code.
 */

const TARGET_TTL_MS = 5 * 60 * 1000;
// How long what the agent is told of its image is taken from memory, not from the bucket.
const IMAGE_TTL_MS = 5 * 60 * 1000;
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
    // The commands a person started here that are still running (src/agent/bashrequest.js).
    this.bashRuns = new Map();
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
          // Whether the turn answers a sidebar message: then nothing goes to the channel.
          inSidebar: () => inSidebar(this),
          pinned: (session) => seedPin(this, session),
          // For request_bash: the deadline of what it asks for.
          schedule: (when, callback, payload) => this.schedule(when, callback, payload),
          // What the computer's shell is and has, for the agent's prompt.
          shell: () => this.shellInfo(),
        };
        this.agentContext = agent;
        // In this order, which is the system prompt's: opspile, the tools the team turned on,
        // code mode, the MCP servers, and the staff's instructions last. A reinstall replaces
        // an extension in place.
        this.registry.install(opspileExtension(agent));
        await this.currentRuntime();
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
   * The shell of the computer last installed (src/agent/kernel.js), and with the kernel its
   * image, from storage at first.
   */
  async currentRuntime() {
    this.runtime ??= (await this.ctx.storage.get('runtime')) || DEFAULT_RUNTIME;
    this.image ??= (await this.ctx.storage.get('image')) || DEFAULT_IMAGE;
    return this.runtime;
  }

  /**
   * Before the agent is told something: are its switchable tools still the ones turned on, and
   * its computer's shell and image the ones its team chose? A change is installed at once when
   * Pi is open, else when it opens. A failure keeps them.
   */
  async syncTools() {
    try {
      const before = await this.currentTools();
      const runtime = await this.currentRuntime();
      const target = await this.target();
      const now = await toolsFor(this.env, target);
      // Asked only where there is a computer: its shell is nothing to an agent without one.
      const shell = now.includes('computer') ? await shellFor(this.env, target) : { runtime };
      const image = shell.image || this.image;
      const same = shell.runtime === runtime && image === this.image;
      if (now.join(',') === before.join(',') && same) {
        return;
      }
      if (!same) {
        await this.changeShell(shell.runtime, image);
      }
      this.tools = now;
      await this.ctx.storage.put('tools', now);
      if (this.agentContext) {
        this.registry.install(agentToolsExtension(this.agentContext, now));
      }
      console.log(JSON.stringify({
        route: 'agent', tools: now, runtime: shell.runtime, ...(shell.image ? { image } : {}),
      }));
    } catch (e) {
      console.log(JSON.stringify({ route: 'agent', tools: 'sync failed', error: e.message }));
    }
  }

  /**
   * The computer gets another shell, or its kernel another image, with the next command: a new
   * Workspace over the same files. A kernel that ran here is ended; its own root (/root,
   * /tmp) stays in this object's SQLite, for when the team chooses the kernel again.
   */
  async changeShell(runtime, image = this.image) {
    const kernel = await (this.booting || Promise.resolve(null)).catch(() => null);
    if (this.ws && kernel) {
      await this.ws.close().catch(() => {});
    }
    this.ws = null;
    this.computerReady = false;
    this.booting = undefined;
    this.imageInfo = null;
    if (kernel) {
      kernel.terminate();
    }
    this.runtime = runtime;
    this.image = image;
    await this.ctx.storage.put('runtime', runtime);
    await this.ctx.storage.put('image', image);
  }

  /**
   * What the agent is told its shell is: `{ runtime }`, and with the kernel `image`, what the
   * image says it has (`tools`) and its commands, from the bucket (kept for a few minutes).
   * Without the image (no bucket, or it is gone), the agent is told to look for itself.
   */
  async shellInfo() {
    const runtime = await this.currentRuntime();
    if (runtime !== 'slicc-kernel') {
      return { runtime };
    }
    const kept = this.imageInfo;
    if (!kept || kept.name !== this.image || Date.now() - kept.at > IMAGE_TTL_MS) {
      const image = await readImage(this.env.IMAGES, this.image).catch(() => null);
      this.imageInfo = {
        at: Date.now(),
        name: this.image,
        ...(image ? { tools: image.tools, commands: commandsOf(image) } : {}),
      };
    }
    const { name, tools, commands } = this.imageInfo;
    return {
      runtime, image: name, ...(tools ? { tools, commands } : {}),
    };
  }

  /** The agent's computer, as pi's environment: a Workspace in this object, made on first use. */
  computer() {
    this.computerEnv ??= computerEnv(() => this.readyWorkspace(), { runtime: () => this.runtime });
    return this.computerEnv;
  }

  /** The Workspace of the computer, ready to run a command in its working directory. */
  async readyWorkspace() {
    await this.currentRuntime();
    const ws = this.workspace();
    await ws.ready();
    if (!this.computerReady) {
      await ensureCwd(ws.fs);
      this.computerReady = true;
    }
    return ws;
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

  /** The time, for the kernel: a call into this object refreshes its clock (see `kernel`). */
  // eslint-disable-next-line class-methods-use-this
  now() {
    return Date.now();
  }

  /**
   * The SLICC kernel of the computer (src/agent/kernel.js), made with the first command: its
   * root in this object's SQLite, its processes in Dynamic Workers without a network of their
   * own, and the team's image from the `IMAGES` bucket mounted read-only at IMAGE_ROOT, where
   * it finds its commands (src/agent/image.js: a boot without the bucket or the image fails,
   * and says so). What its programs ask of the network goes
   * through the gateway's `forward`, as just-bash's does (src/agent/secrets.js), and they
   * follow redirects themselves, through it again. For `https://` the kernel's proxy ends a
   * program's TLS itself, with the TLS engine this Worker carries (a Worker cannot compile
   * one at run time), and hands the request to the same transport. A Worker's clock stands
   * still while it computes, so the kernel asks this object for the time before each timed wait.
   */
  kernel() {
    this.booting ??= (async () => {
      const { storage } = this.ctx;
      const started = Date.now();
      const image = await readImage(this.env.IMAGES, this.image);
      if (!image) {
        throw new Error(`there is no image ${this.image} in the images bucket (IMAGES)`);
      }
      const tree = await imageTree(this.env.IMAGES, image);
      const kernel = await createCloudflareKernel({
        loader: this.env.LOADER,
        sql: storage.sql,
        sqlite: { transaction: (fn) => storage.transactionSync(fn) },
        clock: () => this.env.AGENTS.get(this.ctx.id).now(),
        commands: { append: [IMAGE_COMMANDS] },
        network: {
          transport: fetchTransport({
            fetch: gatewayFetch((request) => forward(this.env, { agent: this.name }, request)),
            redirect: 'manual',
          }),
          tlsEngine: compiledTlsEngine(createTlsEngine, tlsWasm),
        },
      });
      try {
        // The mount point, in the kernel's own root, as root.
        const client = await attachKernel(await kernel.connect(), { locks: null });
        try {
          await client.fs.mkdir(IMAGE_ROOT);
        } finally {
          await client.close();
        }
        await kernel.mount(imageMount(image, IMAGE_ROOT, imageDriver(this.env.IMAGES, tree)));
      } catch (e) {
        kernel.terminate();
        throw e;
      }
      console.log(JSON.stringify({
        route: 'agent',
        kernel: 'booted',
        image: image.name,
        layers: image.layers.length,
        ms: Date.now() - started,
      }));
      return kernel;
    })().catch((e) => {
      this.booting = undefined;
      throw e;
    });
    return this.booting;
  }

  /** The shell of the computer, as a backend of its Workspace: the one its team chose. */
  backend() {
    if (this.runtime === 'slicc-kernel') {
      // A file is in the Workspace when its program closed it, not a second later: writing
      // into the read-only uploads fails where it happens.
      return overWorkspace(sliccBackend({
        kernel: () => this.kernel(),
        mountPoint: COMPUTER_CWD,
        writeBehind: false,
      }));
    }
    return new WorkerShellBackend({
      id: 'shell',
      loader: this.env.LOADER,
      workspace: { binding: 'AGENTS', id: this.ctx.id.toString(), name: this.name },
      ctx: this.ctx,
      commands: [jqModules, curlModules],
      egress: this.egress(),
    });
  }

  /**
   * The Workspace of the computer: files in this object's SQLite, and its shell (`backend`),
   * which reaches the internet (curl) without a filter, with its secrets (`egress`, or the
   * kernel's transport). Made once `currentRuntime` is known.
   */
  workspace() {
    this.ws ??= new Workspace({
      storage: this.ctx.storage,
      backends: [this.backend()],
      ...(this.env.FILES ? {
        mounts: {
          [`${COMPUTER_CWD}/${UPLOADS_DIR}`]: uploadsMount(this.env.FILES, () => this.ctx.storage.get('uploads')),
        },
      } : {}),
      ...(this.runtime === 'slicc-kernel' ? { output: { dir: KERNEL_OUTPUT_DIR } } : {}),
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
    await this.currentRuntime();
    await this.workspace().ready();
  }

  /** For the shell in the Dynamic Worker (through WorkspaceServiceProxy): the files. */
  async __getWorkspaceStub() {
    await this.currentRuntime();
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

  /** A person on the team talks to the agent in the inbox's sidebar (src/agent/sidebar.js). */
  async sidebar(note) {
    return talk(this, note);
  }

  /** A person discarded the agent's draft (src/agent/discard.js). */
  async discarded(note) {
    return discarded(this, note);
  }

  /** Schedule callback: tells the agent who discarded its draft, unless it came back. */
  async discardNote(payload) {
    return discardNote(this, payload);
  }

  /** A person runs a command the agent asked for (src/agent/bashrequest.js). */
  async runBash(request) {
    return runBash(this, request);
  }

  /** A person denies a command the agent asked for. */
  async denyBash(request) {
    return denyBash(this, request);
  }

  /** Schedule callback: the deadline of a command the agent asked for. */
  async bashDeadline(payload) {
    return bashDeadline(this, payload);
  }

  /** Schedule callback: a command a person started should have ended by now. */
  async bashWatchdog(payload) {
    return bashWatchdog(this, payload);
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
   * storage, so a woken object does not write it again. A turn in progress keeps nothing. One
   * that answers a sidebar message is the sidebar's (src/agent/sidebar.js): the turn kept for
   * the thread stays the one before it. Every finished sidebar answer in the transcript is kept
   * first, also while a turn queued behind it works.
   */
  async keepTurn(turn) {
    if (this.name.startsWith('kb:')) {
      return;
    }
    await keepAnswers(this).catch((e) => console.log(JSON.stringify({ route: 'agent', keep: 'sidebar failed', error: e.message })));
    if (turn && turn.state === 'working') {
      return;
    }
    const sig = JSON.stringify(turn || null);
    this.keptSig ??= (await this.ctx.storage.get('kept-turn')) || null;
    if (this.keptSig === sig) {
      return;
    }
    if (!(turn && turn.sidebar)) {
      await keepTurn(this.env, this.name, turn);
    }
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
        // The sidebar answers before it, even while the turn behind them works.
        await this.keepTurn(turn);
        if (turn && turn.state === 'working' && tries > 1) {
          this.keepTurnSoon(tries - 1);
        }
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
      runtime: await this.currentRuntime(),
      ...(this.runtime === 'slicc-kernel' ? { image: this.image } : {}),
      mcp: catalog.servers.map((s) => ({
        name: s.name, scope: s.scope, tools: s.tools.length, error: s.error,
      })),
    };
  }
}
