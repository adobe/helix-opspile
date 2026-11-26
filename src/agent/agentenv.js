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

import { agentSubject, objectMeter } from '../cogs/meter.js';
import { patientDatabase } from '../d1batch.js';

/**
 * The environment a `ThreadAgent` (src/agent/agent.js) runs with, made of the object's own
 * (`raw`): its bindings counted for COGS as its thread's (src/cogs/meter.js; `name` gives the
 * object's name, which is known only once it runs), and its D1 asking a read again once when D1
 * turned it away as overloaded (`patientDatabase`, src/d1batch.js), as `/api/*` and `/mcp` do,
 * so that a tool does not fail on a few seconds of it. Its queries go to D1 as they are asked,
 * not in batches. `retry` is for tests (`pause`, `wait`). Returns the meter's
 * `{ meter, env, scope }`, with that `env`.
 */
export function agentEnv(raw, name = () => null, retry = {}) {
  const cogs = objectMeter(raw, {
    via: 'agent',
    subject: () => {
      try {
        return agentSubject(name());
      } catch {
        return {};
      }
    },
  });
  const { env } = cogs;
  return {
    ...cogs,
    env: env && env.DB ? { ...env, DB: patientDatabase(env.DB, retry) } : env,
  };
}
