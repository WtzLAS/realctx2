---
name: realctx2
description: "realctx2: list the context and memory commands, or run one by name"
argument-hint: "[command] [arguments]"
disable-model-invocation: true
allowed-tools: "Bash(realctx2-hook command *)"
---
realctx2 manages this session's context and long-term memory. Each command is also a skill of its own, `/realctx2:<command>`.

```text
realctx2 commands:
  /realctx2:status
      Window, occupancy, open intents, consolidations, providers, spend, uncommitted shared files
  /realctx2:settings [category]
      Open the interactive settings screen (endpoints, context, memory, index & storage, tools)
  /realctx2:stack
      The intent stack, with regions and their token sizes
  /realctx2:tree [<t: id>]
      The message tree under a consolidation, or the whole session's
  /realctx2:search <query> [--history] [--project]
      Search memories and turns, with scores, layers, scopes and urgency
  /realctx2:inspect <id>
      Details of any ID
  /realctx2:review [--low-value | --harm | --conflicts | --escalations | --stale-rules | --actor <id>] | review approve|dismiss <id>
      Review queue: approve, pin, edit or forget
  /realctx2:remember <text> [--scope …] [--kind …] [--severity …] [--urgency …] [--path …] [--command …]
      Add an explicit, pinned memory
  /realctx2:forget <id | query> [--purge] [--reason <text>]
      Retire a memory, or purge it with --purge. Acts at once.
  /realctx2:urgency <id> <immediate | hint | caption | passive>
      Set a memory's urgency; the user's choice is final
  /realctx2:pin <target>
      Protect a memory from automatic forgetting
  /realctx2:unpin <target>
      Remove that protection
  /realctx2:share [--commit]
      Flush pending shared changes now, and optionally commit .pi/realctx2/ only
  /realctx2:maintain [scope]
      Run a maintenance pass now
  /realctx2:policy
      EvoDisco phase, recent U and E, agreement with the teacher, operator mix
  /realctx2:doctor
      Check providers, calibration, tool names, stores, instruction files, indexes and secrets
  /realctx2:export [scope] <dir> | export agents [--dir <dir>]
      Write a readable markdown mirror, or regenerate AGENTS.md files from rules
  /realctx2:ingest [paths…] [--all] [--include local,rules,global] [--dry-run]
      Slice AGENTS.md / CLAUDE.md / rules files into path-anchored memories, then delete the files
  /realctx2:rules [path] | rules edit <id>
      List the rules in force at a path; edit one rule
  /realctx2:restore <id>
      Restore a retired memory, or a purged one until the session-end flush
  /realctx2:paths [sync | show <path> | stale]
      Reconcile tracked paths; show a path's memories; list stale anchors
  /realctx2:compact [scope]
      Compact a store now
  /realctx2:calibrate [model]
      Recalibrate similarity thresholds for an embedding model
  /realctx2:reverify [id | --all]
      Re-verify memories against the code now
  /realctx2:uninstall
      Restore the Claude Code settings realctx2 changed
  /realctx2:git install-hooks | git lfs | git fix-gitignore
      Install optional git hooks; move shared files to Git LFS; un-ignore .pi/realctx2/ in .gitignore
```

If a command was named, its output follows:

```!
realctx2-hook command --session ${CLAUDE_SESSION_ID} <<'REALCTX2_ARGS'
$ARGUMENTS
REALCTX2_ARGS
```
