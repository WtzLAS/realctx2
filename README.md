# realctx2

Context and memory management for agent harnesses, implemented from
[`docs/realctx2-design.md`](docs/realctx2-design.md) (v0.7).

- **Context engine**: lets the main model track its active purpose stack (`intent`) with debounced, nonblocking drift checks (Janus), replaces finished work with a
  first-person memory (Precip), folds stable prefixes and relieves window pressure (Palim), and
  records which delivered memories were used.
- **Long-term memory**: a graph in three scopes (global, project-personal, project-shared) stored
  as Loro CRDT documents, with strength decay, forgetting, path-anchored rules, instruction-file
  ingest and background evolution.
- **Two harnesses, one store**: a pi extension (full fidelity: persisted context edits) and a
  Claude Code plugin (append-only: consolidation takes effect at Claude Code's own compaction).

## Requirements

- Node 22.18 or newer, or Bun. pi 1.5 and Claude Code 2.1 are the versions this was built and
  run against. (Node 22.5 is enough for `node:sqlite`; running from source without a build needs
  Node's type stripping, which is on by default from 22.18 and behind a flag from 22.6.)
- git, for the shared scope and path tracking. Projects outside git get the global scope and
  `stat`-based path tracking.

## Build and test

```bash
npm install          # builds dist/ and the Claude Code skills through `prepare`
npm run typecheck
npm test             # vitest (test/*.test.ts)
npm run build        # tsc → dist/, then scripts/gen-skills.mjs → realctx2-claude/skills/
```

`dist/` is not checked in, and nothing needs it: pi loads the extension from `src/index.ts`, and
the launchers in `bin/` (worker, MCP server) run `dist/` when it exists and `src/` otherwise.
The sources use only erasable TypeScript syntax, so Bun and Node run them as they are. `dist/` is
for the package's `main` export and for running on Node versions without type stripping. One
worker test runs the built `bin/realctx2-worker.js` and skips itself when `dist/` is missing.

## Install

**pi.** Install globally, so the global and personal stores are reachable in every project:

```bash
pi install https://github.com/WtzLAS/realctx2      # or git:github.com/WtzLAS/realctx2@<ref>
pi install /path/to/realctx2                      # a local checkout
pi -e https://github.com/WtzLAS/realctx2          # one run, without installing
```

pi clones the repository and installs its runtime dependencies (`loro-crdt`, `picomatch`); no
build step runs. `pi update --extensions` pulls new commits.

**Claude Code.** This repository is a plugin marketplace:

```bash
claude plugin install realctx2 --marketplace WtzLAS/realctx2
```

The plugin directory is `realctx2-claude/` inside this package. It runs the package next to it
(from `dist/` or `src/`), the one `REALCTX2_PACKAGE` names, or one in the global `node_modules`.
A marketplace install copies only the plugin directory, so on the first session the plugin
installs the package of its own version into its data directory (the GitHub tarball of the tag
`v<version>`, else of `main` at that version). A release therefore needs its `v<version>` tag, or
`main` at that version. A pi git install works too: point `--plugin-dir` at its
`realctx2-claude/`.

```bash
claude --plugin-dir /path/to/realctx2/realctx2-claude
```

On the first session realctx2 turns off Claude Code's auto memory in `~/.claude/settings.json`
(config `claudeCode.disableAutoMemory`, default on) and says so. `/realctx2:uninstall` restores
it.

## Configuration

The global file is `~/.pi/agent/realctx2/config.json` (`REALCTX2_HOME` moves the directory). A
trusted project may tighten a short allow-list of keys in `<repo>/.pi/realctx2/config.json`.
Every key and default is in [`src/core/config.ts`](src/core/config.ts) and §9.4 of the design.

realctx2 uses three outside resources. Each one is optional:

| Resource | Config | Without it |
|---|---|---|
| Decision model (SystemOne or OpenAI Decisions format) | `providers.decision` | The aux model emulates decisions, with stricter thresholds. See the note on emulation below. |
| Embedding models (OpenAI Embeddings format; dense, per-token, or both) | `providers.embedding.dense`, `.late` | BM25 and lexical overlap only |
| Aux model | the harness's own model access: the session model in pi, `claude -p` in Claude Code | No consolidation, harvest or ingest; pressure control falls back to the harness's compaction |

```json
{
  "providers": {
    "decision": { "format": "systemone", "url": "https://api.typesafe.ai/v1/systemone", "model": "jev-latest", "apiKeyEnv": "TYPESAFE_API_KEY" },
    "embedding": {
      "dense": { "url": "https://api.openai.com/v1/embeddings", "model": "text-embedding-3-small", "dimensions": 1024, "apiKeyEnv": "OPENAI_API_KEY" }
    },
    "aux": { "pi": { "model": "anthropic/claude-haiku-4-5" }, "claudeCode": { "model": "haiku" } }
  }
}
```

## What the agent and the user get

- **Agent tools** (§8.1): `search`, `recall`, `inspect`, `remember`, `forget`, `intent`. In Claude Code
  they are `mcp__plugin_realctx2_realctx2__<tool>`.
- **Commands** (§10): `/realctx2 <command>` in pi, `/realctx2:<command>` in Claude Code. Run
  `/realctx2` (pi) or `/realctx2:realctx2` (Claude Code) for the list. `status` and `doctor` are
  the places to start.
- **Stores**: `~/.pi/agent/realctx2/` for the global and personal scopes, caches, logs and
  queues; `<repo>/.pi/realctx2/` for the shared scope, which is committed with the code.

## Source layout

| Path | Contents |
|---|---|
| `src/core/` | Shared types, configuration, telemetry, project resolution, aux plumbing, and `host.ts`, which wires everything for one session |
| `src/context/` | The context engine: rounds, session state, Janus, Precip and Palim consolidation, the archive, attribution |
| `src/memory/` | The memory graph: writing, retrieval, strength and lifecycle, evolution and policy, path tracking and delivery, instruction ingest, re-verification |
| `src/storage/` | Loro scope documents, the file store (snapshots, updates, compaction, purge, recovery), SQLite indexes and vectors, the turn index |
| `src/providers/` | Decision clients, embedding clients, late-interaction math |
| `src/tools/`, `src/commands/` | The agent tools and the `/realctx2` commands |
| `src/adapters/pi/` | The pi extension (L2) |
| `src/adapters/claude-code/` | The Claude Code engine host: MCP server, hook socket, transcript reader, `claude -p` aux runner |
| `src/worker/` | The model-free worker, started at session end and by the optional git hooks |
| `realctx2-claude/` | The Claude Code plugin: manifest, `.mcp.json`, hooks, generated skills, hook client |

## What was checked against the real harnesses

The test suite drives the pi adapter through a real pi SDK session with a scripted model, and
the Claude Code host through its hook and MCP interfaces with a scripted aux runner. Beyond
that, these were run by hand against the installed CLIs, with a small model:

- **pi 1.5.2** (`pi --mode rpc -e dist/index.js`): commands, path memories at prompt time,
  intents kindled and closed through emulated decisions, the session-end worker.
- **Claude Code 2.1.326** (`claude -p --plugin-dir realctx2-claude`): the plugin loads, the MCP
  server connects, hooks answer, the prompt section and path memories arrive as
  `additionalContext`, an intent is kindled through `claude -p` aux calls, and a skill
  (`/realctx2:status`) runs.

Not exercised against a real harness: Precip and Palim replacing context in a long live session,
Claude Code's compaction hand-off, a real decision endpoint, real embedding endpoints, Git LFS,
and Windows.

## Environment variables

| Variable | Effect |
|---|---|
| `REALCTX2_HOME` | Store directory (default `~/.pi/agent/realctx2`) |
| `REALCTX2_DISABLE=1` | The pi extension does nothing |
| `REALCTX2_NO_WORKER=1` | No detached worker at session end |
| `REALCTX2_UNTRUSTED=1` | Claude Code: do not load the shared store or project config |
| `REALCTX2_PACKAGE` | Claude Code: where the realctx2 package is, if the plugin directory was copied elsewhere |
| `REALCTX2_PACKAGE_SOURCE` | Claude Code: the `.tar.gz` (URL or file) that the plugin's first-run install unpacks, instead of the GitHub tarball |
| `REALCTX2_CHILD=1` | Set by realctx2 on processes it starts: hooks do nothing, the MCP server runs in aux mode |
