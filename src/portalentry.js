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

import { WorkerEntrypoint } from 'cloudflare:workers';
import { Meter } from './cogs/meter.js';
import { portalTechnologies, receive } from './portalsource.js';
import { portalStatus } from './portalstatus.js';

/**
 * Where the customer portal (src/portal/worker.js) reaches the inbox: its `OPSPILE` binding is
 * this entrypoint, which the Worker exports (src/index.js). It is the portal's `/slack/events`:
 * only a Worker of the same account can bind it, so what arrives here is the portal's, and
 * nothing else of the inbox is within its reach.
 */
export class PortalSource extends WorkerEntrypoint {
  /**
   * What happened in the portal (src/portal/events.js), in order: stored in pile 1 and queued
   * for normalization. It throws when an event cannot be stored, and the portal sends its
   * batch again.
   */
  async events(list) {
    const meter = new Meter(this.env, { via: 'fetch' });
    const env = meter.env({});
    env.meter?.add('workers', 'requests', '', 1);
    try {
      return await receive(env, list);
    } finally {
      this.ctx.waitUntil(meter.flush().catch(() => {}));
    }
  }

  /** The technologies a lobby picks from: the tech stack's entries marked for the portal. */
  async technologies() {
    return portalTechnologies(this.env);
  }

  /**
   * `{ domain, channel, root? }`: what a customer is told of Adobe's side of a thread, or of a
   * channel (src/portalstatus.js): how many listen, the typical wait for the next answer,
   * whether the thread's agent is at work and whether a draft waits.
   */
  async status(args) {
    return portalStatus(this.env, args);
  }
}
