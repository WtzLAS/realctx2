# realctx2 for Claude Code

realctx2 is a context and memory manager for coding agents. This plugin connects it to Claude
Code: it tracks what Claude is working on, keeps long-term memory in three scopes (global,
project-personal, project-shared), delivers path-anchored rules when Claude touches a file, and
re-injects its consolidated state after Claude Code compacts. It shares its stores with the pi
extension of the same name, so both harnesses on one machine see the same memory.

## Setup

Install it from the marketplace in this repository:

```bash
claude plugin install realctx2 --marketplace WtzLAS/realctx2
```

or, inside Claude Code:

```text
/plugin install realctx2 --marketplace WtzLAS/realctx2
```

A marketplace install copies only this directory. On the first session, the plugin's MCP server
installs the `realctx2` package of the same version into the plugin's data directory
(`${CLAUDE_PLUGIN_DATA}/runtime/<version>`): the GitHub tarball of the tag `v<version>`, else of
`main` when `main` is at that version, plus its two runtime dependencies (`loro-crdt`,
`picomatch`) through npm, or Bun when Claude Code runs Bun as `node`. This takes a few seconds and
needs Node 22.6 or later, or Bun. If it outlasts Claude Code's MCP startup timeout, it finishes
in the background: reconnect realctx2 in `/mcp`, or start a new session. Progress and errors go
to `${CLAUDE_PLUGIN_DATA}/runtime/install-<version>.log`. `REALCTX2_PACKAGE_SOURCE` installs from
another `.tar.gz` (URL or file) instead.

From a checkout, the plugin runs the package around it, built or not:

```bash
git clone https://github.com/WtzLAS/realctx2 && cd realctx2 && npm install --omit=dev
claude --plugin-dir "$PWD/realctx2-claude"
```

If this directory is copied somewhere else, set `REALCTX2_PACKAGE` to the package directory, or
install the package globally (`npm i -g`); either one takes precedence over the first-run install.

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
