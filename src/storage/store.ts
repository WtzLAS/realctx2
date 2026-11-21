/**
 * One scope's store on disk (§7.4–§7.10): immutable snapshot and update files, loading,
 * flushing, lagged shallow-snapshot compaction, purge, and the optional PeerID lease pool.
 *
 * Design rule (§7.2): git never merges file contents. Every .loro file is written once under
 * a unique name; Loro merges the data when the store loads.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, relative } from "node:path";
import { type ContainerID, decodeImportBlobMeta, type ImportBatchDetail, LoroDoc, LoroMap, VersionVector } from "loro-crdt";
import type { Config } from "../core/config.ts";
import type { Clock, ScopeName } from "../core/types.ts";
import { errMsg } from "../util/errors.ts";
import { ensureDir, fileSize, listFiles, readJson, removeFile, tryLock, withLockSync, writeFileAtomic, writeJson } from "../util/fs.ts";
import { type Git, runSync } from "../util/git.ts";
import { stableId8 } from "../util/ids.ts";
import { sha256 } from "../util/text.ts";
import { applyStateDiff, type RecoveryReport } from "./recover.ts";
import { nodeFromJson, ScopeDoc } from "./schema.ts";

export type Frontiers = Array<{ peer: `${number}`; counter: number }>;

export interface Manifest {
  epoch: string;
  parents: string[];
  covers: string[];
  shallowRoot: Frontiers;
  head: Frontiers;
  bytes: number;
  createdAt: string;
}

export interface StoreOptions {
  dir: string;
  scope: ScopeName;
  storeId: string;
  projectId?: string;
  actorId: string;
  cfg: Config;
  /** Lock file guarding flushes and compactions of this scope. */
  lockFile: string;
  /** Shared scope: git access for the repo that holds the store. */
  git?: Git | null;
  /** Shared scope: crash journal and buffer for counter-only deltas (§7.5). */
  journalFile?: string;
  /** Optional PeerID lease pool file (§7.8). */
  peersFile?: string;
  /** Local bookkeeping file (which versions were already checked for ID collisions, §8.1.2). */
  stateFile?: string;
  /** Extra fields for store.json at creation. */
  storeJson?: Record<string, unknown>;
  clock?: Clock;
  /** Never create or write files (untrusted or version-gated stores). */
  readOnly?: boolean;
  /** Do not create the directory when it is missing (shared store before first write). */
  lazyCreate?: boolean;
}

export interface StoreProblem {
  file?: string;
  problem: string;
}

export interface FlushResult {
  file: string | null;
  bytes: number;
  /** `deferred`: another process held the store lock and the caller asked not to wait for it. */
  kind: "update" | "snapshot" | "journal" | "deferred" | "none";
}

const LFS_HEADER = "version https://git-lfs.github.com/spec/v1";
const MIN_SHARED_COMPACT_DAYS = 7;

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:.]/g, "");
}

function isLfsPointer(bytes: Uint8Array): boolean {
  if (bytes.length > 400 || bytes.length < LFS_HEADER.length) return false;
  return Buffer.from(bytes.subarray(0, LFS_HEADER.length)).toString("utf8") === LFS_HEADER;
}

function sameFrontiers(a: Frontiers, b: Frontiers): boolean {
  if (a.length !== b.length) return false;
  const key = (f: Frontiers) => f.map((x) => `${x.peer}:${x.counter}`).sort().join(",");
  return key(a) === key(b);
}

function freshDoc(): LoroDoc {
  const doc = new LoroDoc();
  doc.setRecordTimestamp(true);
  return doc;
}

function clean(d: ImportBatchDetail): boolean {
  const p = d.status.pending as unknown;
  const pending = p instanceof Map ? p.size > 0 : p ? Object.keys(p as object).length > 0 : false;
  return !d.rollbackError && !pending && d.blobs.every((b) => b.type === "imported");
}

/** Import into `doc`; true only when every blob applied and nothing is left pending. */
function tryImport(doc: LoroDoc, blobs: Uint8Array[]): boolean {
  if (!blobs.length) return true;
  try {
    return clean(doc.importBatchDetailed(blobs));
  } catch {
    return false;
  }
}

function mergeVV(a: VersionVector, b: VersionVector): VersionVector {
  const out = new Map<`${number}`, number>(a.toJSON());
  for (const [peer, counter] of b.toJSON()) if ((out.get(peer) ?? 0) < counter) out.set(peer, counter);
  return new VersionVector(out);
}

function blobEndVV(bytes: Uint8Array): VersionVector | null {
  try {
    return decodeImportBlobMeta(bytes, false).partialEndVersionVector;
  } catch {
    return null;
  }
}

export class ScopeStore {
  readonly opts: StoreOptions;
  readonly scope: ScopeName;
  readonly storeId: string;
  readonly dir: string;
  sd: ScopeDoc;
  problems: StoreProblem[] = [];
  /** True when the store could not be loaded at all (LFS pointers without git-lfs, …). */
  unloaded = false;
  unloadedReason = "";
  readOnly: boolean;
  recovered: RecoveryReport[] = [];
  /** Memory IDs re-keyed after two machines drew the same ID (§8.1.2). */
  collisions: Array<{ id: string; rekeyed: string }> = [];
  private checkedVV: VersionVector | null = null;
  /** Nodes marked for purge; removed from the files at the next flush (§7.10). */
  readonly pendingPurge = new Set<string>();
  lastFlushAt = 0;

  private readonly clock: Clock;
  private flushedVV: VersionVector;
  private flushedFrontiers: Frontiers = [];
  private seen = new Set<string>();
  private manifests = new Map<string, Manifest>();
  private listeners = new Set<() => void>();
  private leasedPeer: string | null = null;
  private opened = false;

  constructor(opts: StoreOptions) {
    this.opts = opts;
    this.scope = opts.scope;
    this.storeId = opts.storeId;
    this.dir = opts.dir;
    this.clock = opts.clock ?? (() => new Date());
    this.readOnly = opts.readOnly === true;
    this.sd = new ScopeDoc(freshDoc());
    this.flushedVV = this.sd.doc.version();
  }

  // ───────────── paths
  get snapshotsDir(): string {
    return join(this.dir, "snapshots");
  }
  get updatesDir(): string {
    return join(this.dir, "updates");
  }
  get strandedDir(): string {
    return join(this.dir, "stranded");
  }
  get storeFile(): string {
    return join(this.dir, "store.json");
  }
  exists(): boolean {
    return existsSync(this.storeFile);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.sd.invalidate();
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // listeners must not break storage
      }
    }
  }

  private withLock<T>(fn: () => T): T {
    return withLockSync(this.opts.lockFile, fn, { timeoutMs: 15_000 });
  }

  // ───────────── creation
  /** Create the directory skeleton. `store.json` is written once and never changed (§7.4). */
  create(): void {
    if (this.readOnly) return;
    ensureDir(this.dir);
    ensureDir(this.snapshotsDir);
    ensureDir(this.updatesDir);
    if (!existsSync(this.storeFile)) {
      const scopeLabel = this.scope === "shared" ? "project-shared" : this.scope === "personal" ? "project-personal" : "global";
      writeJson(this.storeFile, { format: 2, scope: scopeLabel, ...(this.opts.projectId ? { projectId: this.opts.projectId } : {}), ...(this.opts.storeJson ?? {}) });
    }
    if (this.scope === "shared") this.writeSharedExtras();
  }

  private writeSharedExtras(): void {
    const attrs = join(this.dir, ".gitattributes");
    if (!existsSync(attrs)) {
      const mode = this.opts.cfg.storage.gitLfs;
      const lfs = mode === "on" || (mode === "auto" && this.opts.git?.lfsAvailable() === true);
      writeFileAtomic(attrs, sharedGitattributes(lfs));
    }
    const readme = join(this.dir, "README.md");
    if (!existsSync(readme)) writeFileAtomic(readme, SHARED_README);
  }

  usesLfs(): boolean {
    try {
      return /filter=lfs/.test(readFileSync(join(this.dir, ".gitattributes"), "utf8"));
    } catch {
      return false;
    }
  }

  /** `/realctx2 git lfs`: future files go to LFS; history is not rewritten (§7.4). */
  switchToLfs(): boolean {
    if (this.scope !== "shared" || this.readOnly) return false;
    writeFileAtomic(join(this.dir, ".gitattributes"), sharedGitattributes(true));
    return true;
  }

  // ───────────── loading (§7.6)
  open(): this {
    this.opened = true;
    this.problems = [];
    this.unloaded = false;
    if (!existsSync(this.dir) || !this.exists()) {
      if (!this.opts.lazyCreate && !this.readOnly) this.create();
    }
    const loaded = this.loadDoc();
    const doc = loaded.doc;
    this.sd.replace(doc);
    this.flushedVV = doc.version();
    this.flushedFrontiers = doc.frontiers() as Frontiers;
    if (loaded.stranded.length) this.recoverStranded(loaded.stranded);
    this.importJournal();
    this.acquirePeer();
    if (!this.sd.writable()) {
      this.readOnly = true;
      this.problems.push({ problem: `store schema ${this.sd.meta().schema} / minWriter ${this.sd.meta().minWriter} is newer than this realctx2: opened read-only (upgrade realctx2)` });
    }
    this.ensureMeta();
    this.checkCollisions();
    // nodes left in "purged" state by a crashed session still have to leave the files
    for (const n of this.sd.allNodes()) if (n.status === "purged") this.pendingPurge.add(n.id);
    this.changed();
    return this;
  }

  private ensureMeta(): void {
    if (this.readOnly) return;
    const doc = this.sd.doc;
    const meta = doc.getMap("meta");
    const before = this.sd.dirty;
    const deltas = this.sd.counterDeltas;
    if (meta.get("schema") === undefined) {
      meta.set("schema", 1);
      meta.set("minWriter", 1);
      meta.set("scope", this.scope);
      if (this.opts.projectId) meta.set("projectId", this.opts.projectId);
      meta.set("createdAt", this.clock().toISOString());
    }
    this.sd.registerPeer(this.opts.actorId);
    doc.commit({ message: "meta" });
    // bookkeeping alone never makes a store dirty
    this.sd.dirty = before;
    this.sd.counterDeltas = deltas;
  }

  private readManifests(): Map<string, Manifest> {
    const out = new Map<string, Manifest>();
    for (const f of listFiles(this.snapshotsDir, ".json")) {
      const m = readJson<Manifest | null>(join(this.snapshotsDir, f), null);
      if (!m || typeof m.epoch !== "string" || !Array.isArray(m.parents) || !Array.isArray(m.covers)) {
        this.problems.push({ file: f, problem: "unreadable snapshot manifest" });
        continue;
      }
      out.set(m.epoch, m);
    }
    return out;
  }

  /** Live snapshots: no other manifest lists them in `parents` (§7.6). */
  private liveManifests(all: Map<string, Manifest>): Manifest[] {
    const parents = new Set<string>();
    for (const m of all.values()) for (const p of m.parents) parents.add(p);
    return [...all.values()].filter((m) => !parents.has(m.epoch)).sort((a, b) => (a.epoch < b.epoch ? -1 : 1));
  }

  private readBlob(path: string, cap: number, label: string): Uint8Array | null {
    const size = fileSize(path);
    if (size === 0) return null;
    if (size > cap) {
      this.problems.push({ file: label, problem: `file is ${size} bytes, over the ${cap}-byte cap; skipped` });
      return null;
    }
    try {
      return new Uint8Array(readFileSync(path));
    } catch (e) {
      this.problems.push({ file: label, problem: `unreadable: ${errMsg(e)}` });
      return null;
    }
  }

  private tryLfsPull(): boolean {
    const git = this.opts.git;
    const root = git?.root();
    if (!git || !root || !git.lfsAvailable()) return false;
    const rel = relative(root, this.dir).split("\\").join("/");
    return runSync("git", ["lfs", "pull", "--include", `${rel}/**`], root, 120_000).code === 0;
  }

  /** Build a document from the files on disk; never leaves a half-applied import behind. */
  private loadDoc(allowLfsPull = true): { doc: LoroDoc; stranded: string[] } {
    const manifests = this.readManifests();
    const live = this.liveManifests(manifests);
    const covered = new Set<string>();
    for (const m of live) for (const c of m.covers) covered.add(c);
    const blobs: Array<{ name: string; bytes: Uint8Array; snapshot: boolean }> = [];
    let pointers = 0;
    for (const m of live) {
      const name = `${m.epoch}.loro`;
      const bytes = this.readBlob(join(this.snapshotsDir, name), this.opts.cfg.storage.maxSnapshotBytes, `snapshots/${name}`);
      if (!bytes) {
        this.problems.push({ file: `snapshots/${name}`, problem: "snapshot file missing or unreadable" });
        continue;
      }
      if (isLfsPointer(bytes)) pointers++;
      else blobs.push({ name: `snapshots/${name}`, bytes, snapshot: true });
    }
    const updateNames = listFiles(this.updatesDir, ".loro");
    for (const name of updateNames) {
      if (covered.has(name)) continue;
      const bytes = this.readBlob(join(this.updatesDir, name), this.opts.cfg.storage.maxUpdateBytes, `updates/${name}`);
      if (!bytes) continue;
      if (isLfsPointer(bytes)) pointers++;
      else blobs.push({ name: `updates/${name}`, bytes, snapshot: false });
    }
    this.manifests = manifests;
    if (pointers > 0) {
      // clones without git-lfs see pointer files (§7.4)
      if (allowLfsPull && this.tryLfsPull()) return this.loadDoc(false);
      this.unloaded = true;
      this.unloadedReason = `${pointers} store file(s) are Git LFS pointers: install git-lfs, then run \`git lfs pull\``;
      this.problems.push({ problem: this.unloadedReason });
      return { doc: freshDoc(), stranded: [] };
    }
    this.seen = new Set([...live.map((m) => `snapshots/${m.epoch}.loro`), ...updateNames.map((n) => `updates/${n}`)]);
    // snapshots first: updates may depend on them
    const ordered = [...blobs].sort((a, b) => Number(b.snapshot) - Number(a.snapshot));
    const doc = freshDoc();
    if (tryImport(doc, ordered.map((b) => b.bytes))) return { doc, stranded: [] };
    // Some file cannot be applied (trimmed history, corruption). Find the good set incrementally
    // via fork() so each candidate is checked in O(1) instead of re-importing all good blobs.
    let goodDoc = freshDoc();
    let rest = ordered;
    for (let pass = 0; pass < 2 && rest.length; pass++) {
      const failed: typeof ordered = [];
      for (const b of rest) {
        const probe = goodDoc.fork();
        if (tryImport(probe, [b.bytes])) goodDoc = probe;
        else failed.push(b);
      }
      if (failed.length === rest.length) {
        rest = failed;
        break;
      }
      rest = failed;
    }
    goodDoc.setRecordTimestamp(true);
    return { doc: goodDoc, stranded: rest.map((b) => b.name) };
  }

  private importJournal(): void {
    const file = this.opts.journalFile;
    if (!file || !existsSync(file)) return;
    const bytes = this.readBlob(file, this.opts.cfg.storage.maxUpdateBytes * 4, "pending-shared.loro");
    if (!bytes) return;
    if (tryImport(this.sd.doc, [bytes])) {
      // Journaled changes are local-only until the next flush. Counter-only deltas keep waiting
      // for a substantive flush, so a read-only session never dirties the working tree, whichever
      // process opens the store next (§7.5). Without the note, assume the worst about them.
      if (this.hasUnflushed()) {
        const note = readJson<{ kind?: string; deltas?: number } | null>(`${file}.json`, null);
        if (note?.kind === "counters") {
          this.sd.dirty = "counters";
          this.sd.counterDeltas = Math.max(0, Number(note.deltas) || 0);
        } else this.sd.dirty = "substantive";
        this.sd.invalidate();
      }
      return;
    }
    // e.g. a branch switch: the journal's base is not in this branch's history
    const aside = `${file}.stranded-${stamp(this.clock())}`;
    try {
      renameSync(file, aside);
    } catch {
      // keep going without the journal
    }
    removeFile(`${file}.json`);
    this.problems.push({ file: "pending-shared.loro", problem: "journal could not be applied on this branch; moved aside" });
    // the failed import may have left operations queued: start again from the files
    const loaded = this.loadDoc();
    this.sd.replace(loaded.doc);
    this.flushedVV = loaded.doc.version();
    this.flushedFrontiers = loaded.doc.frontiers() as Frontiers;
  }

  // ───────────── PeerIDs (§7.8)
  private acquirePeer(): void {
    const file = this.opts.peersFile;
    if (!file || !this.opts.cfg.storage.peerReuse || this.readOnly) return;
    const lock = tryLock(`${file}.lock`, 30_000);
    if (!lock) return;
    try {
      const pool = readJson<{ leases: Array<{ peer: string; pid: number | null; counter: number; frontiers: Frontiers }> }>(file, { leases: [] });
      const doc = this.sd.doc;
      const vv = doc.version();
      let chosen: string | null = null;
      for (const lease of pool.leases) {
        if (lease.pid !== null && pidAlive(lease.pid)) continue;
        // reuse only when this document already contains everything the peer wrote (branch check)
        let contains = false;
        try {
          const need = doc.frontiersToVV(lease.frontiers);
          const cmp = vv.compare(need);
          contains = cmp !== undefined && cmp >= 0 && (vv.get(lease.peer as `${number}`) ?? 0) === lease.counter;
        } catch {
          contains = false;
        }
        if (!contains) continue;
        chosen = lease.peer;
        lease.pid = process.pid;
        break;
      }
      if (chosen) {
        doc.setPeerId(chosen as `${number}`);
      } else {
        pool.leases.push({ peer: doc.peerIdStr, pid: process.pid, counter: 0, frontiers: [] });
        // keep the pool small: forget leases that can no longer be reused and are not held
        if (pool.leases.length > 64) pool.leases = pool.leases.filter((l) => l.pid !== null && pidAlive(l.pid)).concat(pool.leases.filter((l) => l.pid === null).slice(-32));
      }
      this.leasedPeer = doc.peerIdStr;
      writeJson(file, pool);
    } catch {
      // the lease pool is an optimization only
    } finally {
      lock.release();
    }
  }

  private releasePeer(): void {
    const file = this.opts.peersFile;
    if (!file || !this.leasedPeer) return;
    const lock = tryLock(`${file}.lock`, 30_000);
    if (!lock) return;
    try {
      const pool = readJson<{ leases: Array<{ peer: string; pid: number | null; counter: number; frontiers: Frontiers }> }>(file, { leases: [] });
      const lease = pool.leases.find((l) => l.peer === this.leasedPeer);
      if (lease) {
        lease.pid = null;
        // record what is durably on disk: unflushed operations must not count as "written"
        lease.frontiers = this.flushedFrontiers;
        lease.counter = this.flushedVV.get(this.leasedPeer as `${number}`) ?? 0;
        writeJson(file, pool);
      }
    } catch {
      // ignore
    } finally {
      lock.release();
      this.leasedPeer = null;
    }
  }

  // ───────────── writing (§7.5)
  /** One logical operation: commit, and journal shared changes so a crash loses nothing. */
  commit(message?: string): void {
    this.sd.commit(message);
    this.journal();
  }

  hasUnflushed(): boolean {
    return this.sd.doc.version().compare(this.flushedVV) !== 0;
  }

  private journal(): void {
    const file = this.opts.journalFile;
    if (!file || this.readOnly || this.unloaded) return;
    try {
      if (!this.hasUnflushed() || this.sd.dirty === "none") {
        return;
      }
      writeFileAtomic(file, this.sd.doc.export({ mode: "update", from: this.flushedVV }));
      // what kind of changes wait here: the next process to open the store needs to know
      writeJson(`${file}.json`, { kind: this.sd.dirty, deltas: this.sd.counterDeltas });
    } catch (e) {
      this.problems.push({ file: "pending-shared.loro", problem: `journal write failed: ${errMsg(e)}` });
    }
  }

  /**
   * Write pending changes as one immutable update file.
   * Shared scope: only substantive changes flush on their own; counter-only deltas wait in the
   * journal until `force`, or until `shared.counterFlushThreshold` deltas are buffered (§7.5).
   *
   * `wait: false` never blocks the thread on the store lock: while another process holds it (a
   * compaction in the worker), the changes stay unflushed (shared ones journaled) and the result
   * is `deferred`. In-session flushes use it; session end and the worker wait.
   */
  flush(opts: { force?: boolean; keepPurges?: boolean; wait?: boolean } = {}): FlushResult {
    const none: FlushResult = { file: null, bytes: 0, kind: "none" };
    if (this.readOnly || this.unloaded || !this.opened) return none;
    this.sd.commit();
    // purges wait for the session-end flush, so they can be undone within the session (§7.10):
    // flushes made during a session pass `keepPurges`
    if (this.pendingPurge.size > 0 && !opts.keepPurges) return this.purgeFlush();
    if (!this.hasUnflushed() || this.sd.dirty === "none") return none;
    if (this.scope === "shared" && !opts.force && this.sd.dirty === "counters" && this.sd.counterDeltas < this.opts.cfg.shared.counterFlushThreshold) {
      this.journal();
      return { file: this.opts.journalFile ?? null, bytes: 0, kind: "journal" };
    }
    if (!this.exists()) this.create();
    if (opts.wait === false) {
      const lock = tryLock(this.opts.lockFile);
      if (!lock) {
        this.journal();
        return { file: null, bytes: 0, kind: "deferred" };
      }
      try {
        return this.flushLocked();
      } finally {
        lock.release();
      }
    }
    return this.withLock(() => this.flushLocked());
  }

  /** Write the pending changes as one update file; the caller holds the store lock. */
  private flushLocked(): FlushResult {
    const doc = this.sd.doc;
    const bytes = doc.export({ mode: "update", from: this.flushedVV });
    if (bytes.length > this.opts.cfg.storage.maxUpdateBytes) {
      // an update this large would be skipped by every loader: fold it into a snapshot instead
      const snap = this.compactLocked({ reason: "oversized-update" });
      if (snap) return snap;
    }
    const name = `${stamp(this.clock())}-${doc.peerIdStr}-${sha256(bytes).slice(0, 8)}.loro`;
    ensureDir(this.updatesDir);
    writeFileAtomic(join(this.updatesDir, name), bytes);
    this.seen.add(`updates/${name}`);
    this.markFlushed();
    return { file: join(this.updatesDir, name), bytes: bytes.length, kind: "update" };
  }

  private markFlushed(): void {
    const doc = this.sd.doc;
    this.flushedVV = doc.version();
    this.flushedFrontiers = doc.frontiers() as Frontiers;
    this.sd.dirty = "none";
    this.sd.counterDeltas = 0;
    this.lastFlushAt = this.clock().getTime();
    if (this.opts.journalFile) {
      removeFile(this.opts.journalFile);
      removeFile(`${this.opts.journalFile}.json`);
    }
  }

  /** Pick up files written by other processes or by git (§7.5). Returns true when the doc changed. */
  refresh(): boolean {
    if (!this.opened || this.unloaded) return false;
    const manifests = this.readManifests();
    const live = this.liveManifests(manifests);
    const covered = new Set<string>();
    for (const m of live) for (const c of m.covers) covered.add(c);
    const fresh: Array<{ name: string; bytes: Uint8Array; snapshot: boolean }> = [];
    let pointers = 0;
    for (const m of live) {
      const key = `snapshots/${m.epoch}.loro`;
      if (this.seen.has(key)) continue;
      const bytes = this.readBlob(join(this.snapshotsDir, `${m.epoch}.loro`), this.opts.cfg.storage.maxSnapshotBytes, key);
      if (!bytes) continue;
      if (isLfsPointer(bytes)) pointers++;
      else fresh.push({ name: key, bytes, snapshot: true });
    }
    const names = listFiles(this.updatesDir, ".loro");
    for (const name of names) {
      const key = `updates/${name}`;
      if (this.seen.has(key) || covered.has(name)) continue;
      const bytes = this.readBlob(join(this.updatesDir, name), this.opts.cfg.storage.maxUpdateBytes, key);
      if (!bytes) continue;
      if (isLfsPointer(bytes)) pointers++;
      else fresh.push({ name: key, bytes, snapshot: false });
    }
    if (pointers > 0) {
      if (this.tryLfsPull()) {
        this.reload();
        return true;
      }
      const msg = `${pointers} newly pulled store file(s) are Git LFS pointers: install git-lfs, then run \`git lfs pull\``;
      if (!this.problems.some((p) => p.problem === msg)) this.problems.push({ problem: msg });
    }
    // a branch switch or revert can also take files away: then the state must be rebuilt
    const present = new Set([...live.map((m) => `snapshots/${m.epoch}.loro`), ...names.map((n) => `updates/${n}`)]);
    let removed = false;
    for (const key of this.seen) {
      if (present.has(key)) continue;
      const base = key.slice(key.indexOf("/") + 1);
      const stillCovered = key.startsWith("updates/") ? covered.has(base) : [...manifests.values()].some((m) => m.parents.includes(base.replace(/\.loro$/, "")));
      if (!stillCovered) removed = true;
    }
    this.manifests = manifests;
    if (!fresh.length && !removed) return false;
    if (removed) {
      this.reload();
      return true;
    }
    const ordered = fresh.sort((a, b) => Number(b.snapshot) - Number(a.snapshot));
    if (!tryImport(this.sd.doc, ordered.map((b) => b.bytes))) {
      this.reload();
      return true;
    }
    // what came in is on disk already: only local operations remain unflushed
    for (const b of ordered) {
      this.seen.add(b.name);
      const end = blobEndVV(b.bytes);
      if (end) this.flushedVV = mergeVV(this.flushedVV, end);
    }
    try {
      this.flushedFrontiers = this.sd.doc.vvToFrontiers(this.flushedVV) as Frontiers;
    } catch {
      // keep the previous frontiers
    }
    this.sd.invalidate();
    this.checkCollisions();
    this.changed();
    return true;
  }

  /**
   * ID collisions (§8.1.2): two machines created a memory under the same ID, and one node
   * container replaced the other. The overwritten node is re-inserted under a fresh ID derived
   * from its container (so every machine picks the same one), with an alias to the old ID.
   */
  private checkCollisions(): void {
    const doc = this.sd.doc;
    doc.commit();
    let from: VersionVector | null = this.checkedVV;
    if (!from && this.opts.stateFile) {
      const saved = readJson<{ checked?: string }>(this.opts.stateFile, {});
      if (saved.checked) {
        try {
          from = VersionVector.decode(new Uint8Array(Buffer.from(saved.checked, "base64")));
        } catch {
          from = null;
        }
      }
    }
    const now = doc.version();
    if (from) {
      const cmp = now.compare(from);
      if (cmp === 0) return;
      // a branch switch takes versions away: then everything the document has is checked again
      if (cmp === undefined || cmp < 0) from = null;
    }
    let json: ReturnType<LoroDoc["exportJsonUpdates"]>;
    try {
      json = doc.exportJsonUpdates(from ?? (doc.isShallow() ? doc.shallowSinceVV() : undefined), undefined, false);
    } catch {
      return;
    }
    const nodes = doc.getMap("nodes");
    let rekeyed = 0;
    for (const change of json.changes) {
      for (const op of change.ops) {
        if (op.container !== "cid:root-nodes:Map") continue;
        const content = op.content as { type?: string; key?: string; value?: unknown };
        if (content.type !== "insert" || typeof content.key !== "string" || typeof content.value !== "string" || !content.value.startsWith("🦜:")) continue;
        const cid = content.value.slice(content.value.indexOf(":") + 1);
        const current = nodes.get(content.key);
        if (!(current instanceof LoroMap) || current.id === cid) continue;
        const hidden = doc.getContainerById(cid as ContainerID);
        if (!(hidden instanceof LoroMap)) continue;
        const fresh = stableId8(`collision:${cid}`, sha256);
        if (this.sd.hasNode(fresh)) continue;
        const parsed = nodeFromJson(fresh, hidden.toJSON());
        if (typeof parsed === "string") continue;
        if (this.readOnly) {
          this.problems.push({ problem: `memory ID ${content.key} was created twice; the overwritten memory is not visible in a read-only store` });
          continue;
        }
        this.sd.insertNode({ ...parsed, id: fresh, aliasOf: content.key }, { mergeable: true });
        this.collisions.push({ id: content.key, rekeyed: fresh });
        rekeyed++;
      }
    }
    if (rekeyed) this.commit("rekey-collision");
    this.checkedVV = doc.version();
    if (this.opts.stateFile && !this.readOnly) {
      try {
        writeJson(this.opts.stateFile, { checked: Buffer.from(this.checkedVV.encode()).toString("base64") });
      } catch {
        // bookkeeping only
      }
    }
  }

  /**
   * Rebuild the document from the files, then carry local unflushed changes over:
   * first as a Loro update, and if its history is gone, as a state diff (§7.9).
   */
  reload(): void {
    const old = this.sd.doc;
    old.commit();
    const hadLocal = this.hasUnflushed() && this.sd.dirty !== "none";
    let pending: Uint8Array | null = null;
    if (hadLocal) {
      try {
        pending = old.export({ mode: "update", from: this.flushedVV });
      } catch {
        pending = null;
      }
    }
    const dirty = this.sd.dirty;
    const deltas = this.sd.counterDeltas;
    const oldFlushed = this.flushedFrontiers;
    let loaded = this.loadDoc();
    let doc = loaded.doc;
    const flushedVV = doc.version();
    const flushedFrontiers = doc.frontiers() as Frontiers;
    if (hadLocal) {
      let carried = pending !== null && tryImport(doc, [pending]);
      if (!carried) {
        // the update's history is not in the rebuilt document: re-apply it as plain writes
        loaded = this.loadDoc();
        doc = loaded.doc;
        try {
          const base = old.forkAt(oldFlushed);
          const report = applyStateDiff(new ScopeDoc(base), new ScopeDoc(old), new ScopeDoc(doc));
          doc.commit({ message: "recover-local" });
          this.recovered.push({ ...report, source: "local changes carried over a reload" });
          carried = true;
        } catch (e) {
          this.problems.push({ problem: `local changes could not be carried over a reload: ${errMsg(e)}` });
        }
      }
    }
    this.sd.replace(doc);
    this.sd.dirty = hadLocal ? dirty : "none";
    this.sd.counterDeltas = hadLocal ? deltas : 0;
    this.flushedVV = flushedVV;
    this.flushedFrontiers = flushedFrontiers;
    if (loaded.stranded.length) this.recoverStranded(loaded.stranded);
    this.ensureMeta();
    this.checkCollisions();
    this.changed();
  }

  // ───────────── compaction (§7.7)
  updateFiles(): string[] {
    return listFiles(this.updatesDir, ".loro");
  }

  liveSnapshots(): Manifest[] {
    return this.liveManifests(this.manifests.size ? this.manifests : this.readManifests());
  }

  stats(): { updates: number; updateBytes: number; snapshots: number; snapshotBytes: number; nodes: number; shallow: boolean; peers: number } {
    const updates = this.updateFiles();
    const live = this.liveSnapshots();
    return {
      updates: updates.length,
      updateBytes: updates.reduce((s, f) => s + fileSize(join(this.updatesDir, f)), 0),
      snapshots: live.length,
      snapshotBytes: live.reduce((s, m) => s + fileSize(join(this.snapshotsDir, `${m.epoch}.loro`)), 0),
      nodes: this.sd.nodeCount(),
      shallow: this.sd.doc.isShallow(),
      peers: this.sd.doc.version().length(),
    };
  }

  /** Which §7.7 trigger fires, if any. */
  compactionDue(): string | null {
    if (this.readOnly || this.unloaded || !this.exists()) return null;
    const s = this.stats();
    const cfg = this.opts.cfg.storage.compact;
    const live = this.liveSnapshots();
    const newest = live.length ? live[live.length - 1]! : null;
    const ageDays = newest ? (this.clock().getTime() - Date.parse(newest.createdAt)) / 86_400_000 : Number.POSITIVE_INFINITY;
    let reason: string | null = null;
    if (s.updates >= cfg.maxUpdateFiles) reason = `${s.updates} update files`;
    else if (s.snapshotBytes > 0 && s.updateBytes >= cfg.maxUpdateShare * s.snapshotBytes && s.updates > 1) reason = "updates reached 25% of the snapshot";
    else if (newest && ageDays > cfg.maxAgeDays && s.updates >= 1) reason = `snapshot is ${Math.floor(ageDays)} days old`;
    else if (live.length > 1) reason = `${live.length} live snapshots to fold`;
    if (!reason) return null;
    if (this.scope === "shared") {
      const policy = this.opts.cfg.shared.compactOn;
      if (policy === "manual") return null;
      const git = this.opts.git;
      if (git?.isRepo()) {
        if (policy === "default-branch" && git.branch() !== localBranchName(git.defaultBranch(this.opts.cfg.shared.defaultBranch))) return null;
        const root = git.root()!;
        // only with a clean store directory, so a compaction never mixes with half-staged files
        if (git.hasUncommitted(relative(root, this.dir).split("\\").join("/"))) return null;
      }
      // avoid compacting a shared store more than once a week
      if (newest && ageDays < MIN_SHARED_COMPACT_DAYS && s.updates < cfg.maxUpdateFiles * 2) return null;
    }
    return reason;
  }

  maybeCompact(): FlushResult | null {
    const due = this.compactionDue();
    if (!due) return null;
    return this.compact({ reason: due });
  }

  compact(opts: { reason?: string; nonLagged?: boolean } = {}): FlushResult | null {
    if (this.readOnly || this.unloaded) return null;
    if (!this.exists()) this.create();
    return this.withLock(() => this.compactLocked(opts));
  }

  /** Shallow root for a compaction off the default branch: the newest snapshot also on the default branch. */
  private branchRoot(): Frontiers | null {
    const git = this.opts.git;
    if (this.scope !== "shared" || !git?.isRepo()) return null;
    const def = git.defaultBranch(this.opts.cfg.shared.defaultBranch);
    if (!def) return null;
    const branch = git.branch();
    if (!branch || branch === localBranchName(def)) return null;
    const base = git.mergeBase("HEAD", def);
    if (!base) return null;
    const root = git.root()!;
    const rel = `${relative(root, this.snapshotsDir).split("\\").join("/")}`;
    const files = git.lsTree(base, rel).filter((f) => f.endsWith(".json"));
    let newest: Manifest | null = null;
    for (const f of files) {
      const raw = git.show(base, f);
      if (!raw) continue;
      try {
        const m = JSON.parse(raw) as Manifest;
        if (!newest || m.epoch > newest.epoch) newest = m;
      } catch {
        // skip unreadable manifests
      }
    }
    return newest ? newest.head : null;
  }

  private compactLocked(opts: { reason?: string; nonLagged?: boolean }): FlushResult | null {
    // everything on disk goes into the new snapshot
    this.refresh();
    const doc = this.sd.doc;
    doc.commit();
    const live = this.liveSnapshots();
    const head = doc.frontiers() as Frontiers;
    const covers = this.updateFiles();
    if (!live.length && !covers.length && !this.hasUnflushed()) return null;
    let root: Frontiers = [];
    let bytes: Uint8Array | null = null;
    const attempt = (frontiers: Frontiers): Uint8Array | null => {
      try {
        return doc.export({ mode: "shallow-snapshot", frontiers });
      } catch {
        return null;
      }
    };
    if (opts.nonLagged) {
      root = head;
      bytes = attempt(head);
    } else {
      // lagged trimming: keep history back to the previous snapshot's head (§7.7)
      const candidates: Frontiers[] = [];
      const branch = this.branchRoot();
      if (branch) candidates.push(branch);
      else if (live.length === 1 && live[0]!.head.length) candidates.push(live[0]!.head);
      // several live snapshots share a shallow root: keep it, and trim at the next compaction
      if (doc.isShallow()) candidates.push(doc.shallowSinceFrontiers() as Frontiers);
      for (const c of candidates) {
        if (!c.length) continue;
        bytes = attempt(c);
        if (bytes) {
          root = c;
          break;
        }
      }
    }
    if (!bytes) {
      if (opts.nonLagged && head.length > 0) {
        this.problems.push({ problem: "non-lagged shallow snapshot failed; purge compaction aborted" });
        return null;
      }
      // no usable root: keep all the history the document has
      bytes = doc.export({ mode: "snapshot" });
      root = doc.isShallow() ? (doc.shallowSinceFrontiers() as Frontiers) : [];
    }
    if (bytes.length > this.opts.cfg.storage.maxSnapshotBytes) {
      this.problems.push({ problem: `snapshot would be ${bytes.length} bytes, over the cap; compaction skipped` });
      return null;
    }
    const now = this.clock();
    const epoch = `${stamp(now)}-${sha256(bytes).slice(0, 8)}`;
    const manifest: Manifest = { epoch, parents: live.map((m) => m.epoch), covers, shallowRoot: root, head, bytes: bytes.length, createdAt: now.toISOString() };
    ensureDir(this.snapshotsDir);
    writeFileAtomic(join(this.snapshotsDir, `${epoch}.loro`), bytes);
    writeJson(join(this.snapshotsDir, `${epoch}.json`), manifest);
    for (const m of live) {
      removeFile(join(this.snapshotsDir, `${m.epoch}.loro`));
      removeFile(join(this.snapshotsDir, `${m.epoch}.json`));
      this.seen.delete(`snapshots/${m.epoch}.loro`);
    }
    for (const name of covers) {
      removeFile(join(this.updatesDir, name));
      this.seen.delete(`updates/${name}`);
    }
    // manifests of long-gone parents are no longer needed once nothing references them
    this.manifests = this.readManifests();
    this.seen.add(`snapshots/${epoch}.loro`);
    this.markFlushed();
    void opts.reason;
    return { file: join(this.snapshotsDir, `${epoch}.loro`), bytes: bytes.length, kind: "snapshot" };
  }

  // ───────────── explicit forgetting (§7.10)
  /**
   * All purges of one session share one pass: delete the keys, then take a non-lagged shallow
   * snapshot at the current head so the text is gone from the current files, and drop the
   * in-memory history by reloading from that snapshot.
   */
  private purgeFlush(): FlushResult {
    if (!this.exists()) this.create();
    return this.withLock(() => {
      this.refresh();
      for (const id of this.pendingPurge) this.sd.deleteNode(id);
      this.sd.commit("purge");
      const result = this.compactLocked({ nonLagged: true, reason: "purge" });
      if (result?.file) {
        this.pendingPurge.clear();
        // the old document still holds the purged operations in its history
        const doc = freshDoc();
        doc.importBatch([new Uint8Array(readFileSync(result.file))]);
        this.sd.replace(doc);
        this.sd.dirty = "none";
        this.flushedVV = doc.version();
        this.flushedFrontiers = doc.frontiers() as Frontiers;
        this.ensureMeta();
        this.changed();
      } else if (!this.liveSnapshots().length && !this.updateFiles().length && !this.hasUnflushed()) {
        this.pendingPurge.clear();
      } else {
        this.problems.push({ problem: "purge could not rewrite store files; pending purge retained" });
      }
      return result ?? { file: null, bytes: 0, kind: "none" as const };
    });
  }

  // ───────────── stranded updates (§7.9)
  private recoverStranded(names: string[]): void {
    if (!names.length) return;
    const git = this.opts.git;
    const root = git?.root() ?? null;
    const blobs: Array<{ name: string; bytes: Uint8Array }> = [];
    for (const name of names) {
      const bytes = this.readBlob(join(this.dir, name), this.opts.cfg.storage.maxSnapshotBytes, name);
      if (bytes) blobs.push({ name, bytes });
    }
    if (!blobs.length) return;
    let base: Uint8Array | null = null;
    if (git && root) base = this.findBaseSnapshot(git, root, blobs.map((b) => b.bytes));
    // a stranded snapshot carries its own state: it can be diffed against an empty base
    const selfContained = !base && blobs.every((b) => b.name.startsWith("snapshots/"));
    if (!base && !selfContained) {
      this.moveToStranded(names, "history needed for recovery is not available (shallow clone?)");
      return;
    }
    try {
      const before = freshDoc();
      if (base) before.importBatch([base]);
      const after = freshDoc();
      after.importBatch([...(base ? [base] : []), ...blobs.map((b) => b.bytes)]);
      const report = applyStateDiff(new ScopeDoc(before), new ScopeDoc(after), this.sd, { additiveOnly: selfContained });
      this.sd.commit("recover-stranded");
      this.sd.dirty = "substantive";
      this.recovered.push({ ...report, source: names.join(", ") });
      if (!this.readOnly) {
        // one new update file replaces the stranded ones
        const res = this.flush({ force: true });
        if (res.kind !== "none") {
          for (const name of names) {
            removeFile(join(this.dir, name));
            if (name.startsWith("snapshots/")) removeFile(join(this.dir, name.replace(/\.loro$/, ".json")));
            this.seen.delete(name);
          }
        }
      }
    } catch (e) {
      this.moveToStranded(names, `recovery failed: ${errMsg(e)}`);
    }
  }

  /** Search git history for a deleted snapshot on which the stranded files apply cleanly. */
  private findBaseSnapshot(git: Git, root: string, stranded: Uint8Array[]): Uint8Array | null {
    const rel = relative(root, this.snapshotsDir).split("\\").join("/");
    const log = git.git(["log", "--diff-filter=D", "--name-only", "--format=%x00%H", "-n", "50", "--", rel], 20_000);
    if (log.code !== 0) return null;
    let tried = 0;
    for (const block of log.stdout.split("\0")) {
      const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
      const commit = lines.shift();
      if (!commit) continue;
      for (const path of lines) {
        if (!path.endsWith(".loro")) continue;
        if (++tried > 12) return null;
        let bytes: Uint8Array | null = git.showBytes(`${commit}^`, path);
        if (!bytes) continue;
        if (isLfsPointer(bytes)) {
          const smudged = runSyncBytes("git", ["lfs", "smudge"], root, Buffer.from(bytes));
          if (!smudged || isLfsPointer(smudged)) continue;
          bytes = smudged;
        }
        if (tryImport(freshDoc(), [bytes, ...stranded])) return bytes;
      }
    }
    return null;
  }

  private moveToStranded(names: string[], why: string): void {
    for (const name of names) {
      if (!this.readOnly) {
        try {
          mkdirSync(this.strandedDir, { recursive: true });
          renameSync(join(this.dir, name), join(this.strandedDir, name.replace(/\//g, "-")));
          if (name.startsWith("snapshots/")) removeFile(join(this.dir, name.replace(/\.loro$/, ".json")));
          this.seen.delete(name);
        } catch {
          // leave the file where it is
        }
      }
      this.problems.push({ file: name, problem: `stranded: ${why}` });
    }
  }

  strandedFiles(): string[] {
    return listFiles(this.strandedDir, ".loro");
  }

  /** Flush what is pending and release the PeerID lease. */
  close(opts: { force?: boolean } = {}): FlushResult {
    let res: FlushResult = { file: null, bytes: 0, kind: "none" };
    try {
      res = this.flush(opts);
    } catch (e) {
      this.problems.push({ problem: `flush at close failed: ${errMsg(e)}` });
    }
    this.releasePeer();
    this.listeners.clear();
    return res;
  }

  /** Version of the document, for the derived index (§7.6). */
  versionKey(): string {
    return sha256(this.sd.doc.version().encode()).slice(0, 32);
  }

  headMatches(f: Frontiers): boolean {
    return sameFrontiers(this.sd.doc.frontiers() as Frontiers, f);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function localBranchName(ref: string | null): string | null {
  if (!ref) return null;
  return ref.replace(/^origin\//, "");
}

function runSyncBytes(cmd: string, args: string[], cwd: string, input: Buffer): Uint8Array | null {
  try {
    return new Uint8Array(execFileSync(cmd, args, { cwd, input, maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"] }));
  } catch {
    return null;
  }
}

export function sharedGitattributes(lfs: boolean): string {
  const loro = lfs ? "*.loro filter=lfs diff=lfs merge=lfs -text linguist-generated=true" : "*.loro binary linguist-generated=true";
  return ["# realctx2 shared memory store: files are immutable and merged by realctx2, never by git (§7.4).", loro, "snapshots/*.json linguist-generated=true", ""].join("\n");
}

const SHARED_README = `# realctx2 shared memory

This directory holds the project's shared agent memory, written by
[realctx2](https://www.npmjs.com/package/realctx2).

- \`snapshots/\` and \`updates/\` contain immutable Loro CRDT files. Git only ever sees them
  being added or deleted, so they merge cleanly on every platform. **Do not edit, rename or
  resolve them by hand** — if git ever reports a conflict here, keep both sides' files.
- \`config.json\` (optional) holds non-sensitive project overrides.
- Indexes, embeddings and caches are never stored here; they live on each machine.

Commit this directory together with your code. To browse or change what it contains, use
\`/realctx2 review\`, \`/realctx2 forget\` and \`/realctx2 status\` inside the agent.
`;
