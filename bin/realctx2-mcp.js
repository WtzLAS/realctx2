#!/usr/bin/env node
// realctx2's MCP server for Claude Code (design §4.6.1): agent tools + engine host.
import("../dist/adapters/claude-code/server.js")
  .then((m) => m.main())
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`realctx2: ${String(e?.stack ?? e)}\n`);
    process.exit(1);
  });
