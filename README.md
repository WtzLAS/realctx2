# realctx2

Context and memory management for agent harnesses, implemented from
[`docs/realctx2-design.md`](docs/realctx2-design.md) (v0.6).

- **Context engine**: tracks what the agent is working on (Janus), replaces finished work with a
  first-person memory (Precip), folds stable prefixes and relieves window pressure (Palim), and
  records which delivered memories were used.
- **Long-term memory**: a graph in three scopes (global, project-personal, project-shared) stored
  as Loro CRDT documents, with strength decay, forgetting, path-anchored rules, instruction-file
  ingest and background evolution.
- **Two harnesses, one store**: a pi extension (full fidelity: persisted context edits) and a
  Claude Code plugin (append-only: consolidation takes effect at Claude Code's own compaction).

## Requirements

- Node 22.5 or newer (for `node:sqlite`), or Bun. pi 1.5 and Claude Code 2.1 are the versions
  this was built and run against.
- git, for the shared scope and path tracking. Projects outside git get the global scope and
  `stat`-based path tracking.

## Build and test

```bash
npm install          # builds dist/ and the Claude Code skills through `prepare`
npm run typecheck
npm test             # vitest: 16 files
npm run build        # tsc → dist/, then scripts/gen-skills.mjs → realctx2-claude/skills/
```

`dist/` is not checked in. The worker, the MCP server and the pi entry point all load from it,
so build before using a checkout. One worker test runs the built `bin/realctx2-worker.js` and
skips itself when `dist/` is missing.

## Install

**pi.** Install globally, so the global and personal stores are reachable in every project:

```bash
pi install /path/to/realctx2        # or add the path to "packages" in ~/.pi/agent/settings.json
pi -e /path/to/realctx2/dist/index.js   # one run, without installing
```

**Claude Code.** The plugin directory is `realctx2-claude/` inside this package. It finds the
package's `dist/` next to it, through `REALCTX2_PACKAGE`, or in the global `node_modules`.

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

- **Agent tools** (§8.1): `search`, `recall`, `inspect`, `remember`, `forget`. In Claude Code
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

## Where this differs from the design document

Things the document leaves open, and places where the harnesses or a real run forced a
different choice.

**Decisions without a decision model (§9.1.4).** The document gives an emulated decision the
call site's timeout, which is 1.5 s for Janus and the proactive gate. A real model needs 5 to
10 s for that call, so every emulated Janus answer timed out. Now:

- `providers.aux.emulateTimeoutMs` (default 20 s) is the floor for an emulated decision. `0`
  restores the call site's timeout.
- No commit point waits for an emulated answer. Janus at a user message and at settle, and the
  proactive gate at a kindle, wait `janus.lateWaitMs` and then let the answer apply at the next
  commit point. Late proactive cards arrive as their own guidance message.
- One Janus request is in flight at a time, and a plan made before another intent was kindled
  cannot kindle again.
- The cost: with emulation an intent's guidance lands one or two rounds after the work began, so
  those first rounds stay in the enclosing region and Precip covers less.

**Context engine**

- Precip may replace a closed region inside the working tail; only the latest round is excluded.
  The working-tail invariant is enforced for Palim.
- The innermost climb level counts as stable once its intent has been open for `stableRounds`
  rounds. A closure resets the climb clock.
- The fold cost check prices the fold with the aux model's rates and falls back to the main
  model's.
- A commit or test command is enriched with the paths edited in the current intent, so rules
  that trigger on commit can match by path.
- Turns are also indexed at shutdown, so a session that ends before its last round completes is
  searchable.

**Memory**

- Seed activation in retrieval is the fused rank score scaled by relative raw relevance;
  reciprocal ranks alone are nearly flat.
- Stop words are dropped from full-text queries. Without embeddings, conflict candidates need a
  trigram Jaccard of at least 0.2.
- The repository root is the glob anchor `**`.
- Re-ingest treats a section as unchanged when its hash matches, even if the user retired its
  items since.
- `rules edit` patches the rule in place instead of writing a superseding memory.
- Path reconciliation keeps "the commit this checkout was last reconciled at" in the local
  index, not in the document. A path whose content is unchanged is not written at all, so a
  session that only reads never dirties the shared store after a pull. `lastSeen.commit` is the
  commit at which the content was last recorded.

**Storage**

- Compaction uses the previous compaction head as the shallow root, because Loro cannot import
  an update whose dependencies predate the root.
- Anchors and sources are removed with a tombstone field rather than a key delete, so a
  concurrent write cannot resurrect a half-filled entry. A purge empties child containers before
  deleting the node.
- The shared journal (`pending-shared.loro`) has a small note next to it saying whether it holds
  counter-only or substantive changes. Without it, the next process to open the store (the
  session-end worker, for one) had to assume the worst and flushed counters into the repository.
- Purges are held until the session-end flush, so they can be undone within the session.
- The periodic flush is checked at turn ends, not on a timer.
- The worker drops the index rows of a session whose file is gone only once that session has
  ended or is a day old; a running session's file may not exist yet.

**pi adapter**

- Tools are registered at `session_start` and re-checked at the first `before_agent_start`,
  because pi's tool list cannot be read while the extension loads.
- pi allows `context_edit` on user, assistant, tool-result and custom messages only. Compaction
  summaries and `!` shell runs are left in place by folds.
- `before_agent_start` has no boundary to return entries from, so its records ride in the
  guidance message's `details`.
- The compaction record is written at `session_compact`, anchored at pi's compaction entry.
- `providers.aux.pi.extensions` is not implemented: aux sessions load no other extensions.
- Tool parameters are plain JSON Schema; `typebox` is not used.

**Claude Code adapter**

- Plugin tools are named `mcp__plugin_realctx2_realctx2__<tool>`, not `mcp__realctx2__<tool>`.
- One skill per command (`/realctx2:<command>`), generated from the command table, instead of a
  single skill.
- Claude Code caps a hook's `additionalContext` at 10,000 characters, so the state injected
  after a compaction is split across four `SessionStart` handlers.
- Commands have no dialogs: confirmations take `--yes`, and `rules edit` needs pi.
- The oversize guard rewrites Bash and plain-string tool outputs only.
- A project is treated as trusted unless `REALCTX2_UNTRUSTED=1`, since Claude Code asks for
  folder trust itself.
- The hook socket's registry is under `~/.pi/agent/realctx2/claude-code/run/`.

**Packaging**

- `prepare` builds only when TypeScript is installed, so an install without dev dependencies
  does not fail. Such an install needs a `dist/` that was built beforehand.

## Open questions about the design

- **Unpinned explicit memories are demoted at once.** §6.3 puts an unpinned `remember` into the
  long-term layer. §6.5.2 demotes a long-term node when I < 0.3, and a node with no use and no
  related purpose has I = 0.3 × recency, which is below 0.3 from the first moment. So the first
  hygiene pass moves such a memory to the short-term layer. This is implemented as written.
  Pinned memories (everything `/realctx2 remember` writes) are not affected.
- **Emulated decisions are slow.** `decision.emulate` runs with thinking `low` as §9.3.4 says,
  and took 5 to 10 s per request with a small model. Setting
  `providers.aux.<harness>.roles["decision.emulate"].thinking` to `off` should shorten that; it
  was not measured.

## Environment variables

| Variable | Effect |
|---|---|
| `REALCTX2_HOME` | Store directory (default `~/.pi/agent/realctx2`) |
| `REALCTX2_DISABLE=1` | The pi extension does nothing |
| `REALCTX2_NO_WORKER=1` | No detached worker at session end |
| `REALCTX2_UNTRUSTED=1` | Claude Code: do not load the shared store or project config |
| `REALCTX2_PACKAGE` | Claude Code: where the realctx2 package is, if the plugin directory was copied elsewhere |
| `REALCTX2_CHILD=1` | Set by realctx2 on processes it starts: hooks do nothing, the MCP server runs in aux mode |
