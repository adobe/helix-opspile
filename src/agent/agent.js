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
import {
  attachKernel, compiledTlsEngine, createCloudflareKernel, fetchTransport, inProcessMount,
  sliccBackend,
} from '@ai-ecoverse/slicc-kernel/cloudflare';
import { connect } from 'cloudflare:sockets';
import createTlsEngine from '@ai-ecoverse/wasm-tls-engine';
// wrangler compiles a `.wasm` import when it builds the Worker: a WebAssembly.Module.
import tlsWasm from '@ai-ecoverse/wasm-tls-engine/slicc-tls-engine.wasm';
import { agentSubject, modelUsage, objectMeter } from '../cogs/meter.js';
import { entryOf } from '../drafts.js';
import { customerTeams } from '../shares.js';
import { armModel, armTags, cacheRetention } from '../experiments.js';
import { pinnedArm } from './arms.js';
import { toolsFor } from './agenttools.js';
import {
  bashDeadline, bashWatchdog, denyBash, runBash, runScript,
} from './bashrequest.js';
import { deliver, idle, verdictsOf } from './delivery.js';
import { discarded, discardNote } from './discard.js';
import { answered } from './question.js';
import { dream, dreamOf, dreamState } from './dream.js';
import { setWakeup, wakeupDue } from './wakeups.js';
import { removeWatch, setWatch, watchUpdate } from './watches.js';
import { armCompact, compactIdle } from './idlecompact.js';
import {
  COMPUTER_CWD, computerEnv, ensureCwd, KERNEL_OUTPUT_DIR, readComputerFile,
} from './computer.js';
import {
  commandsOf, DEFAULT_IMAGE, IMAGE_COMMANDS, IMAGE_ROOT, imageDriver, imageTree, readImage,
} from './image.js';
import {
  CURL_HOME, CURLRC, gatewayFetch, imageFor, imageSpec, KERNEL_ENV,
} from './kernel.js';
import { computerBrowser } from './browser.js';
import { AgentMcp, codemodeExtension, mcpExtension } from './mcp.js';
import { agentProvider, modelProblem, modelRef } from './model.js';
import { forward } from './secrets.js';
import { DOH, socketUplink } from './uplink.js';
import { seed, seedPin } from './seed.js';
import {
  chatOf, chatState, keepChats, talkInChat,
} from './kbchat.js';
import {
  currentSidebar, inSidebar, keepAnswers, talk,
} from './sidebar.js';
import {
  agentToolsExtension, kbChatExtension, opspileExtension, staffExtension,
} from './tools.js';
import {
  keepThreadFiles, mountList, UPLOADS_DIR, uploadsMount,
} from '../threadfiles.js';
import { keepLive, keepTurn, liveDue } from './kept.js';
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
 * `denyBash` and their schedules: src/agent/bashrequest.js), and a script it asked a person to
 * run as themselves (`runScript`, src/agent/scriptrequest.js), and what a person on the team says
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
 * Its shell is the SLICC kernel (src/agent/kernel.js), which runs in this object, on that
 * Workspace, with the programs of the team's image from the `IMAGES` bucket
 * (src/agent/image.js), its processes in Dynamic Workers. Its requests go through the gateway's
 * `forward` (src/agent/secrets.js), which adds the team's and the customer's secrets where a
 * request names them.
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
// How long an idle compaction is waited for, in its schedule callback: summaries take a minute or
// two; one still running after this is placed when it is done, unwatched.
const COMPACT_WAIT_MS = 10 * 60 * 1000;
const SIZE_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Meters the agent's model use after each round of tools and each answer, and keeps the turn
 * for the inbox: what it is doing after each round of tools, and the turn an answer, or a failed
 * request, ends.
 */
const cogsExtension = (agent) => defineExtension({
  name: 'opspile-cogs',
  hooks: [hook(GenerationTask, {
    afterTools: () => {
      agent.meterSoon();
      agent.keepTurnSoon();
    },
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
        // The prompt cache's retention and the model, per request: the cache experiment's arm
        // while it runs, and the model the thread is pinned to (src/agent/arms.js, decided below,
        // before any request), else the `long` asked for below and AGENT_MODEL.
        models.setProvider(agentProvider(env, {
          cacheRetention: () => cacheRetention(this.name),
          model: () => armModel(env, this.modelArm),
        }));
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
          // Which sidebar message it answers, for what it files for its author.
          sidebarMessage: () => currentSidebar(this),
          pinned: (session) => seedPin(this, session),
          // Which dream a session is, if one (src/agent/dream.js).
          dreamOf: (session) => dreamOf(this, session),
          // Which conversation of its knowledge base's sidebar a session is (src/agent/kbchat.js).
          chatOf: (session) => chatOf(this, session),
          // For request_bash and request_codemode: the deadline of what it asks for.
          schedule: (when, callback, payload) => this.schedule(when, callback, payload),
          // wakeup_after and wakeup_after_idle (src/agent/wakeups.js).
          wakeup: (kind, args) => setWakeup(this, kind, args),
          // watch_related and unwatch_related (src/agent/watches.js), through this context.
          watch: {
            set: (args) => setWatch(agent, args),
            remove: (args) => removeWatch(agent, args),
          },
          // What the computer's shell is and has, for the agent's prompt.
          shell: () => this.shellInfo(),
          // A file of the computer, for the tools that take one (src/agent/computer.js).
          computerFile: (path, options) => this.computerFile(path, options),
        };
        this.agentContext = agent;
        // In this order, which is the system prompt's: opspile, the tools the team turned on,
        // code mode, the MCP servers, and the staff's instructions last. A reinstall replaces
        // an extension in place.
        this.registry.install(opspileExtension(agent));
        // A knowledge-base agent talks on its knowledge base's page too, and reads every thread
        // there (src/kbchat.js).
        if (!agent.hasThread) {
          this.registry.install(kbChatExtension(agent));
        }
        await this.currentArm();
        await this.currentImage();
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
    // Work accepted (new messages, a sidebar message, a seed, the wrap-up, a command's outcome):
    // the turn is working now, and GET /api/agent hears it from D1 (`keepTurn`).
    const submit = this.harness.submit.bind(this.harness);
    this.harness.submit = async (...args) => {
      const receipt = await submit(...args);
      this.keepTurnSoon();
      return receipt;
    };
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

  /** The model experiment's arm this thread is pinned to, or null (src/agent/arms.js). */
  async currentArm() {
    if (this.modelArm === undefined) {
      this.modelArm = await pinnedArm({
        storage: this.ctx.storage, env: this.env, name: this.name,
      });
    }
    return this.modelArm;
  }

  /** The switchable tools last installed (src/agent/agenttools.js), from storage at first. */
  async currentTools() {
    this.tools ??= (await this.ctx.storage.get('tools')) || [];
    return this.tools;
  }

  /** The image of the computer's kernel last installed (src/agent/image.js), stored at first. */
  async currentImage() {
    this.image ??= (await this.ctx.storage.get('image')) || DEFAULT_IMAGE;
    return this.image;
  }

  /**
   * Before the agent is told something: are its switchable tools still the ones turned on, and
   * its computer's image the one its team chose? A change is installed at once when Pi is open,
   * else when it opens. A failure keeps them.
   */
  async syncTools() {
    try {
      const before = await this.currentTools();
      const current = await this.currentImage();
      const target = await this.target();
      const now = await toolsFor(this.env, target);
      // Asked only where there is a computer: its image is nothing to an agent without one.
      const image = now.includes('computer') ? await imageFor(this.env, target) : current;
      const same = image === current;
      if (now.join(',') === before.join(',') && same) {
        return;
      }
      if (!same) {
        await this.changeImage(image);
      }
      this.tools = now;
      await this.ctx.storage.put('tools', now);
      if (this.agentContext) {
        this.registry.install(agentToolsExtension(this.agentContext, now));
      }
      console.log(JSON.stringify({ route: 'agent', tools: now, image }));
    } catch (e) {
      console.log(JSON.stringify({ route: 'agent', tools: 'sync failed', error: e.message }));
    }
  }

  /**
   * The computer's kernel gets another image (or the same one again) with the next command: a
   * new Workspace over the same files. A kernel that ran here is ended; its own root (/root,
   * /tmp) stays in this object's SQLite, for the next one.
   */
  async changeImage(image = this.image) {
    const kernel = await (this.booting || Promise.resolve(null)).catch(() => null);
    if (this.ws && kernel) {
      await this.ws.close().catch(() => {});
    }
    this.ws = null;
    this.computerReady = false;
    this.booting = undefined;
    this.imageInfo = null;
    await this.endBrowser();
    if (kernel) {
      kernel.terminate();
    }
    this.image = image;
    await this.ctx.storage.put('image', image);
  }

  /**
   * What the agent is told its shell is: its `image`, what the image says it has (`tools`) and
   * its commands, from the bucket (kept for a few minutes). Without the image (no bucket, or it
   * is gone), the agent is told to look for itself.
   */
  async shellInfo() {
    await this.currentImage();
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
    return { image: name, ...(tools ? { tools, commands } : {}) };
  }

  /**
   * A file of the computer's working directory, for a tool that takes one (view_image, a
   * draft's or a post's files): `{ path, name, bytes }`, or `{ error }`. Only where the team
   * turned the computer on.
   */
  async computerFile(path, options) {
    if (!(await this.currentTools()).includes('computer')) {
      return { error: 'you have no computer in this channel' };
    }
    return readComputerFile((await this.readyWorkspace()).fs, path, options);
  }

  /** The agent's computer, as pi's environment: a Workspace in this object, made on first use. */
  computer() {
    this.computerEnv ??= computerEnv(() => this.readyWorkspace());
    return this.computerEnv;
  }

  /** The Workspace of the computer, ready to run a command in its working directory. */
  async readyWorkspace() {
    await this.currentImage();
    const ws = this.workspace();
    await ws.ready();
    if (!this.computerReady) {
      await ensureCwd(ws.fs);
      this.computerReady = true;
    }
    return ws;
  }

  /**
   * The browser of the computer (src/agent/browser.js): Browser Run, with its session's id in
   * this object's storage, so that a computer evicted meanwhile finds its tabs again.
   */
  computerCdp() {
    const { storage } = this.ctx;
    this.cdp ??= computerBrowser(this.env, {
      // Browser Run's time, for COGS (src/cogs/meter.js).
      used: (ms) => this.env.meter?.add('browser_run', 'browser_ms', '', ms),
      store: {
        get: () => storage.get('browser-session'),
        put: (id) => storage.put('browser-session', id),
        delete: () => storage.delete('browser-session'),
      },
    });
    return this.cdp;
  }

  /**
   * The CDP host of the kernel about to boot (its `cdp` option: `SLICC_CDP_URL`,
   * ws://127.0.0.1:9222) from Browser Run, for an image with the browser's programs
   * (`hasBrowser`) where this deployment has Browser Run (`browserConfigured`); else none, and
   * the programs are told no browser is attached (503). A host that fails answers them 502.
   */
  browserFor(image) {
    return this.computerCdp().attach(image);
  }

  /**
   * Ends the computer's browser, with its kernel: its Chromium session, also the one an evicted
   * object left in storage, before this object attached a host.
   */
  async endBrowser() {
    await this.computerCdp().end();
  }

  /** The answer to a request of the kernel's programs: the gateway's (src/agent/secrets.js). */
  kernelFetch(request) {
    return forward(this.env, { agent: this.name }, request);
  }

  /**
   * The SLICC kernel of the computer (src/agent/kernel.js), made with the first command: its
   * root in this object's SQLite, its processes in Dynamic Workers without a network of their
   * own, and the team's image from the `IMAGES` bucket mounted read-only at IMAGE_ROOT, where
   * it finds its commands (src/agent/image.js: a boot without the bucket or the image fails,
   * and says so). What its programs ask of the network goes through the gateway's `forward`
   * (src/agent/secrets.js), and they follow redirects themselves, through it again. For
   * `https://` the kernel's proxy ends a program's TLS itself, with the TLS engine this Worker
   * carries (a Worker cannot compile one at run time), and hands the request to the same
   * transport. A program's own TCP leaves through the uplink (src/agent/uplink.js), the
   * Worker's sockets, to port 443 only, past the gateway: for a site's own TLS. A Worker's
   * clock stands still while it computes; the kernel waits on a timer before each timed wait,
   * which moves it. It must not call into this object for the time (it did up to 1.188): each
   * such call raised the request's subrequest depth, until R2 failed in the same request and a
   * program read from the image failed to start with EIO.
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
      const gateway = gatewayFetch((request) => this.kernelFetch(request));
      const kernel = await createCloudflareKernel({
        loader: this.env.LOADER,
        sql: storage.sql,
        sqlite: { transaction: (fn) => storage.transactionSync(fn) },
        commands: { append: [IMAGE_COMMANDS] },
        // The browser, for an image with playwright-cli (src/agent/browser.js).
        ...this.browserFor(image),
        // curl's configuration (CURL_HOME), and tar's options.
        env: KERNEL_ENV,
        // How much of a Dynamic Worker's 128 MB the kernel fills with processes: by default
        // 64 MiB, too little for git's clone, which is three processes deep (git, git
        // remote-https, git-remote-https) and forks a fourth to read the pack. The kernel
        // runs no more Dynamic Workers (8) than a Durable Object may (10).
        isolates: { memory: 96 * 2 ** 20 },
        network: {
          transport: fetchTransport({ fetch: gateway, redirect: 'manual' }),
          tlsEngine: compiledTlsEngine(createTlsEngine, tlsWasm),
          // TCP out, to port 443 only (src/agent/uplink.js): a site's own TLS.
          uplink: socketUplink({ connect }),
          // Outside names, for getaddrinfo and the kernel's DNS (127.0.0.53: dig, host,
          // nslookup) alike, through the gateway.
          doh: DOH,
        },
      });
      try {
        // The mount point, in the kernel's own root, as root.
        const client = await attachKernel(await kernel.connect(), { locks: null });
        try {
          await client.fs.mkdir(IMAGE_ROOT);
          // Written at each boot: the computer's own root keeps what a program changed there.
          await client.fs.mkdir(CURL_HOME);
          await client.fs.writeFile(`${CURL_HOME}/.curlrc`, CURLRC);
        } finally {
          await client.close();
        }
        await kernel.mount(inProcessMount(
          imageSpec(image, IMAGE_ROOT),
          imageDriver(this.env.IMAGES, tree),
        ));
      } catch (e) {
        await this.endBrowser();
        kernel.terminate();
        throw e;
      }
      console.log(JSON.stringify({
        route: 'agent',
        kernel: 'booted',
        image: image.name,
        layers: image.layers.length,
        browser: this.computerCdp().attached,
        ms: Date.now() - started,
      }));
      return kernel;
    })().catch((e) => {
      this.booting = undefined;
      throw e;
    });
    return this.booting;
  }

  /** The shell of the computer, as the backend of its Workspace: the kernel. */
  backend() {
    // A file is in the Workspace when its program closed it, not a second later.
    return sliccBackend({
      kernel: () => this.kernel(),
      mountPoint: COMPUTER_CWD,
      writeBehind: false,
    });
  }

  /**
   * The Workspace of the computer: files in this object's SQLite, and its shell (`backend`),
   * which reaches the internet (curl) without a filter, with its secrets (the kernel's
   * transport). Made once `currentImage` is known.
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
      output: { dir: KERNEL_OUTPUT_DIR },
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
    await this.currentImage();
    await this.workspace().ready();
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
      const about = kb[2] && await this.env.DB.prepare('SELECT name, type FROM orgs WHERE slug = ?')
        .bind(kb[2]).first().catch(() => null);
      value = {
        key: null,
        team: kb[1] || null,
        org: kb[2] || null,
        threads: [],
        ...(about ? { orgName: about.name || null, orgType: about.type || 'customer' } : {}),
        // A customer's own agent (its page's, `kb::<org>`): the teams that work with it, whose
        // knowledge bases it reads first (src/agent/repos.js).
        ...(!kb[1] && kb[2]
          ? { owners: await customerTeams(this.env, kb[2]).catch(() => []) } : {}),
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
        // The teams that follow a technology the thread shows (src/follows.js), whose knowledge
        // bases it has as those of the teams its channel is shared with.
        follows: entry ? entry.follows : [],
      };
    }
    this.cachedTarget = { at: Date.now(), value };
    return value;
  }

  /** The target is read again next time: its threads changed (a root was folded into it). */
  forgetTarget() {
    this.cachedTarget = null;
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

  /** Schedule callback: a wake-up the agent set itself (src/agent/wakeups.js). */
  async wakeupDue(payload) {
    this.meterModel();
    return wakeupDue(this, payload);
  }

  /** Something the agent watches changed (src/agent/watches.js). */
  async watchUpdate(update) {
    this.meterModel();
    return watchUpdate(this, update);
  }

  /** A turn ended: compact after an idle hour, in the compaction experiment (idlecompact.js). */
  async armCompact() {
    try {
      await armCompact(this);
    } catch (e) {
      console.log(JSON.stringify({ route: 'agent', compact: 'arm failed', error: e.message }));
    }
  }

  /** Schedule callback: the thread has been idle since its turn ended (idlecompact.js). */
  async compactIdle(payload) {
    const r = await compactIdle(this, payload).catch((e) => ({ error: e.message }));
    console.log(JSON.stringify({ route: 'agent', compact: 'idle', ...r }));
    // What the summary cost, under the arm it ran in.
    this.meterModel();
    return r;
  }

  /**
   * Compacts the thread's conversation with `instructions` (pi-durable's manual compaction: the
   * summary is placed at once, the agent being idle) and waits for it, a while: its outcome's
   * status (`completed`, `failed`, …), `running` when it took longer.
   */
  async compactRoot(instructions) {
    const conversation = await this.harness.conversation(ROOT_SESSION);
    const id = await conversation.compact(instructions, BACKGROUND_CONTEXT);
    const pi = await this.harness.pi();
    let timer;
    const settled = await Promise.race([
      pi.waitForTask(id, BACKGROUND_CONTEXT),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), COMPACT_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    const outcome = settled && settled.state && settled.state.outcome;
    if (!outcome) {
      return 'running';
    }
    const error = outcome.error && String(outcome.error.message || outcome.error).slice(0, 200);
    return error ? `${outcome.status}: ${error}` : outcome.status;
  }

  /** Knowledge shared by a staff member, to be filed in the knowledge bases. */
  async seed(note) {
    return seed(this, note);
  }

  /** A dream of the customer's knowledge base starts (src/agent/dream.js, src/dreams.js). */
  async dream(note) {
    return dream(this, note);
  }

  /** Where a dream stands (src/agent/dream.js). */
  async dreamState(query) {
    return dreamState(this, query);
  }

  /**
   * A person talks to the knowledge-base agent on its knowledge base's page, in a conversation
   * of their own (src/agent/kbchat.js).
   */
  async chat(note) {
    return talkInChat(this, note);
  }

  /** What the knowledge-base agent is doing in a conversation of its page (src/agent/kbchat.js). */
  async chatState(query) {
    return chatState(this, query);
  }

  /** A person on the team talks to the agent in the inbox's sidebar (src/agent/sidebar.js). */
  async sidebar(note) {
    return talk(this, note);
  }

  /** A person answered a question the agent asked them (src/agent/question.js). */
  async answered(note) {
    return answered(this, note);
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

  /**
   * A person runs a script the agent asked for as themselves (src/agent/scriptrequest.js):
   * `call` runs an inbox tool as them, in the Worker, for as long as this call lasts.
   */
  async runScript(request) {
    return runScript(this, request);
  }

  /**
   * The sandbox of one script a person runs, with only the `tools` it may call: on this
   * object's thread, as the agent's own code mode, up to the same interrupt budget.
   */
  // eslint-disable-next-line class-methods-use-this
  scriptSandbox(tools) {
    return createInlineCodemodeSandbox({
      tools,
      timeoutMs: SCRIPT_TIMEOUT_MS,
      interruptBudget: SCRIPT_INTERRUPT_BUDGET,
    });
  }

  /** A person denies a command, or a script, the agent asked for. */
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
    // The customer, for the experiments by customer (the dreams'); none when it cannot be read.
    const org = await this.target().then((t) => t.org).catch(() => null);
    const { now, adds } = modelUsage(
      await this.ctx.storage.get('cogs:usage'),
      ledger,
      armModel(this.env, await this.currentArm()) || this.env.AGENT_MODEL,
      armTags(this.name, Date.now(), this.env, { model: await this.currentArm() }, org),
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

  /**
   * The thread's latest turn (src/agent/turn.js), and what is pending. `cut`: there is none
   * because a compaction summarized it (its input was before the entries kept as they were).
   */
  async latestTurn() {
    const pending = await this.harness.pending();
    // The turn is the thread's; a pinned seed session works beside it, and is in `pending`.
    // A compaction's summary waits in it to be placed (`compaction:<task>`): not the turn's work.
    const busy = pending.some((p) => p.session === ROOT_SESSION && p.status !== 'parked'
      && !String(p.operationId || '').startsWith('compaction:'));
    const entries = await this.harness.messages().catch(() => []);
    const turn = latestTurn(entries, { busy });
    return { pending, turn, cut: !turn && Boolean(entries[0] && entries[0].kind === 'pi.compaction') };
  }

  /**
   * Keeps `turn` for the inbox (src/agent/kept.js), as the transcript was at `at`: whatever it is
   * as what the agent is doing now (`agent_live`, GET /api/agent), and a finished one for the
   * thread (`agent_turns`, GET /api/thread), each once: what was kept last is in storage, so a
   * woken object does not write it again. A turn that answers a sidebar message is the
   * sidebar's (src/agent/sidebar.js): the turn kept for the thread stays the one before it.
   * Every finished sidebar answer in the transcript is kept first, also while a turn queued
   * behind it works. A turn a compaction cut off (`cut`) stays as it was kept. A
   * knowledge-base agent has no thread to keep a turn for: it keeps the answers of its
   * knowledge base's sidebar instead (src/agent/kbchat.js), and notes whether one still works
   * (`chatsWorking`), for keepTurnSoon to look again.
   */
  async keepTurn(turn, at = new Date().toISOString(), { cut = false } = {}) {
    if (this.name.startsWith('kb:')) {
      const chats = await keepChats(this).catch((e) => {
        console.log(JSON.stringify({ route: 'agent', keep: 'chats failed', error: e.message }));
        return { working: false };
      });
      this.chatsWorking = chats.working;
      return;
    }
    await keepAnswers(this).catch((e) => console.log(JSON.stringify({ route: 'agent', keep: 'sidebar failed', error: e.message })));
    if (!turn && cut) {
      return;
    }
    await this.keepLive(turn, at).catch((e) => console.log(JSON.stringify({ route: 'agent', keep: 'live failed', error: e.message })));
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

  /**
   * Keeps `turn` as what the agent is doing (`agent_live`) when it changed since it was last
   * kept, or the one kept is a third of STUCK_MS old: GET /api/agent asks the agent itself about
   * a turn that has been working that long without a word from it.
   */
  async keepLive(turn, at) {
    this.liveSig ??= (await this.ctx.storage.get('live-turn')) || null;
    const last = { sig: this.liveSig, at: this.liveAt };
    if (!liveDue(last, turn, at)) {
      return;
    }
    await keepLive(this.env, this.name, turn, at);
    this.liveSig = JSON.stringify(turn || null);
    this.liveAt = at;
    await this.ctx.storage.put('live-turn', this.liveSig);
  }

  /**
   * `keepTurn` of the latest turn, shortly: the answer is committed after the hooks run. Asked
   * again while it waits, it looks once more after that, so the last change is never missed.
   */
  keepTurnSoon(tries = KEEP_TRIES) {
    if (this.keepTimer) {
      this.keepAgain = true;
      return;
    }
    this.keepAgain = false;
    this.keepTimer = setTimeout(async () => {
      let working = false;
      try {
        const at = new Date().toISOString();
        const { turn, cut } = await this.latestTurn();
        // The sidebar answers before it, even while the turn behind them works.
        await this.keepTurn(turn, at, { cut });
        working = Boolean(turn && turn.state === 'working') || Boolean(this.chatsWorking);
        if (!working) {
          await this.armCompact();
        }
      } catch (e) {
        console.log(JSON.stringify({ route: 'agent', keep: 'turn failed', error: e.message }));
      }
      this.keepTimer = null;
      if (this.keepAgain) {
        this.keepTurnSoon();
      } else if (working && tries > 1) {
        this.keepTurnSoon(tries - 1);
      }
    }, KEEP_DELAY_MS);
  }

  /** What the agent is doing, for the inbox and for checks. */
  async status() {
    // Called without agentStub's startup call first (GET /api/agent, src/agent/stub.js): one
    // round trip to the object for the inbox, not two.
    // eslint-disable-next-line no-underscore-dangle
    await this.__unsafe_ensureInitialized();
    this.meterModel();
    const catalog = await this.servers.current();
    const at = new Date().toISOString();
    const { pending, turn, cut } = await this.latestTurn();
    // A turn the inbox does not have yet (what it is doing, for an agent that has not written
    // it since this was deployed; one that stopped half way and counts as failed now): kept
    // behind the answer.
    this.keepTurn(turn, at, { cut }).catch((e) => console.log(JSON.stringify({ route: 'agent', keep: 'turn failed', error: e.message })));
    return {
      name: this.name,
      model: armModel(this.env, await this.currentArm()) || this.env.AGENT_MODEL || null,
      problem: modelProblem(this.env),
      mark: (await this.ctx.storage.get('mark')) || null,
      pending,
      turn,
      tools: await this.currentTools(),
      image: await this.currentImage(),
      mcp: catalog.servers.map((s) => ({
        name: s.name, scope: s.scope, tools: s.tools.length, error: s.error,
      })),
    };
  }
}
