-- The agents' computers have one shell, GNU bash on the SLICC kernel (src/agent/kernel.js):
-- just-bash is gone, and with it the choice between them. A team's Computer tool keeps one
-- option, `image`, the programs of its kernels (src/agent/image.js).
DELETE FROM agent_tool_options WHERE tool = 'computer' AND name = 'runtime';
