-- The global `browser` MCP server (Cloudflare's hosted Browser Run one) is gone: the agents'
-- computers have the browser instead (the `browser`, `data-browser` and `github-browser` images,
-- src/agent/browser.js). Its switches and its checked tools go with it. Tool requests that named
-- it (`global:browser`) stay as their history; a grant of it gives nothing.
DELETE FROM mcp_global_switches WHERE server = 'browser';
DELETE FROM mcp_global_tools WHERE server = 'browser';
