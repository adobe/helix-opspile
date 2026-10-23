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

import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';

/**
 * MCP servers in memory, for the tests and the UI preview: `fetch(url, init)` answers for
 * every server in `servers` by its URL, through the official SDK's Streamable HTTP handler.
 * A server is `{ url, name, token?, instructions?, tools: [{ name, description, inputSchema,
 * readOnly?, run(args) }] }`; with a `token`, requests without `Authorization: Bearer <token>`
 * get 401. `calls` records every tool call. Made-up data only.
 */
export function fakeMcpServers(servers) {
  const calls = [];
  const handlers = new Map(servers.map((s) => [new URL(s.url).href, {
    server: s,
    handler: createMcpHandler(() => {
      const mcp = new McpServer(
        { name: s.name, version: '1.0.0' },
        s.instructions ? { instructions: s.instructions } : {},
      );
      for (const t of s.tools) {
        mcp.registerTool(t.name, {
          description: t.description,
          inputSchema: fromJsonSchema(t.inputSchema || { type: 'object', properties: {} }),
          ...(t.readOnly ? { annotations: { readOnlyHint: true } } : {}),
        }, async (args) => {
          calls.push({ server: s.name, tool: t.name, args });
          const out = await t.run(args);
          return typeof out === 'string' ? { content: [{ type: 'text', text: out }] } : out;
        });
      }
      return mcp;
    }),
  }]));
  async function fetchFn(input, init) {
    const request = new Request(input, init);
    const { origin, pathname } = new URL(request.url);
    const hit = handlers.get(`${origin}${pathname}`);
    if (!hit) {
      return new Response('not found', { status: 404 });
    }
    if (hit.server.token && request.headers.get('authorization') !== `Bearer ${hit.server.token}`) {
      return new Response('unauthorized', { status: 401 });
    }
    return hit.handler.fetch(request);
  }
  return { fetch: fetchFn, calls, handles: (url) => handlers.has(new URL(url).href) };
}
