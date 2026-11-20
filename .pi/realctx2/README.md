# realctx2 shared memory

This directory holds the project's shared agent memory, written by
[realctx2](https://www.npmjs.com/package/realctx2).

- `snapshots/` and `updates/` contain immutable Loro CRDT files. Git only ever sees them
  being added or deleted, so they merge cleanly on every platform. **Do not edit, rename or
  resolve them by hand** — if git ever reports a conflict here, keep both sides' files.
- `config.json` (optional) holds non-sensitive project overrides.
- Indexes, embeddings and caches are never stored here; they live on each machine.

Commit this directory together with your code. To browse or change what it contains, use
`/realctx2 review`, `/realctx2 forget` and `/realctx2 status` inside the agent.
