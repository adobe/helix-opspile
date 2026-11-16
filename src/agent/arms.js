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

import { armOf, MODEL } from '../experiments.js';

/** Where an agent keeps its pin: `{ arm, at, recorded }` (`arm` null: in no arm). */
export const ARM_KEY = 'arm:model';

/**
 * The model experiment's arm the agent `name` is pinned to (`opus`, `sonnet`), or null, decided
 * once and kept in its storage: an agent that first starts inside the window (nothing delivered
 * or metered yet) is pinned to its thread's arm; one that started before it, or after, to none.
 * So a thread never changes model, at the window's edges or after. The pin is kept first, then
 * written to D1 (`agent_arms`, for the dashboard's drafts), then marked recorded: a failed write
 * is tried again the next time, and the pin it guards is never decided twice.
 */
export async function pinnedArm({
  storage, env, name, now = Date.now(),
}) {
  let pin = await storage.get(ARM_KEY);
  if (!pin) {
    const started = Boolean(await storage.get('mark')) || Boolean(await storage.get('cogs:usage'));
    const arm = started ? null : armOf(MODEL, name, now, env);
    pin = { arm: arm ? arm.id : null, at: new Date(now).toISOString(), recorded: !arm };
    await storage.put(ARM_KEY, pin);
  }
  if (pin.arm && !pin.recorded) {
    try {
      await env.DB.prepare(`INSERT INTO agent_arms (name, experiment, arm, at) VALUES (?, ?, ?, ?)
        ON CONFLICT (experiment, name) DO NOTHING`).bind(name, MODEL.id, pin.arm, pin.at).run();
      pin = { ...pin, recorded: true };
      await storage.put(ARM_KEY, pin);
    } catch (e) {
      console.log(JSON.stringify({ route: 'agent', experiment: 'pin not recorded', error: e.message }));
    }
  }
  return pin.arm;
}
