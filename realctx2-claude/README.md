# realctx2 for Claude Code

realctx2 is a context and memory manager for coding agents. This plugin connects it to Claude
Code: it tracks what Claude is working on, keeps long-term memory in three scopes (global,
project-personal, project-shared), delivers path-anchored rules when Claude touches a file, and
re-injects its consolidated state after Claude Code compacts. It shares its stores with the pi
extension of the same name, so both harnesses on one machine see the same memory.

## Setup

The plugin is part of the `realctx2` package and needs that package's built `dist/`:

```bash
cd /path/to/realctx2 && npm install        # builds dist/ and the skills
claude --plugin-dir /path/to/realctx2/realctx2-claude
```

If this directory is copied somewhere else, set `REALCTX2_PACKAGE` to the package directory, or
install the package globally (`npm i -g`).

On the first session realctx2 turns off Claude Code's auto memory, so the two memory systems do
not compete, and tells you. `/realctx2:uninstall` restores the setting.

## What it adds

- **Tools** for Claude: `search`, `recall`, `inspect`, `remember`, `forget`
  (`mcp__plugin_realctx2_realctx2__<tool>`).
- **Commands**: `/realctx2:<command>`. `/realctx2:realctx2` lists them; start with
  `/realctx2:status` and `/realctx2:doctor`.
- **Hooks** on session start and end, prompts, tool calls, compaction and file changes. Each
  hook forwards its input to the plugin's MCP server over a local socket. If the server is not
  there or does not answer in time, the hook prints nothing and Claude Code carries on.

## Limits in Claude Code

Claude Code's context is append-only for plugins. realctx2 consolidates in the background and
its result takes effect when Claude Code compacts; until then the original turns stay in the
window. Commands cannot open dialogs here, so confirmations take `--yes`.

Configuration and stores are described in the package's main README, and the design in
`docs/realctx2-design.md`.
