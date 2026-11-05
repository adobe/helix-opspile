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
import { forward } from './secrets.js';

/**
 * Where the shells of the agents' computers reach the network: Cloudflare Computer's
 * `http-gateway` egress, the Dynamic Worker's `globalOutbound` (src/agent/agent.js). Every
 * `fetch` of the shell, curl's too, arrives here, and goes on with the agent's secrets put in
 * where it names them (src/agent/secrets.js). `props.agent` is the agent's name, set by its
 * ThreadAgent object, out of the shell's reach. The Worker exports it (src/index.js). It has no
 * `connect`: the shell opens no sockets.
 */
export class SecretGateway extends WorkerEntrypoint {
  async fetch(request) {
    return forward(this.env, this.ctx.props || {}, request);
  }
}
