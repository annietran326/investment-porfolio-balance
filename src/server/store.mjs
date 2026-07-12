// Persistence layer (U5). Owns the data dir: current.json, snapshots/,
// trends.jsonl, transactions.json, mappings.json, manifest.json, the pid
// lockfile, and quarantine of anything corrupt. Every data-file write goes
// through one atomic primitive (temp file + fsync + rename + dir fsync).
// The store is the ONLY module allowed to read the clock — injectable so
// tests control the snapshot-per-day policy; model/engine stay clock-free.
//
// Commit order on save, pinned by tests: (1) current.json, (2) snapshot if
// first save of the calendar date, (3) trend row. Snapshot/trend failures
// never fail the save, and because current commits first a crash between
// steps can only lose a trend row, never invent one.
//
// transactions.json and mappings.json (U9) are versioned envelopes
// ({schemaVersion, transactions|mappings}) OUTSIDE the snapshot scope:
// snapshots capture current.json only, so reset() and restore() never touch
// transaction data — it persists across both. That is safe because derived
// spending is always re-derivable from the stored rows. On a transaction
// import the pinned write order is transactions.json THEN current.json: a
// crash in between leaves stored rows without the derived spending, and
// re-running the apply (or re-importing) repairs it — the reverse order
// could show derived spending whose underlying rows were never stored.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { SCHEMA_VERSION, validate } from "../model/schema.mjs";
import { migrate, FutureVersionError } from "../model/migrate.mjs";
import { requiredIncome } from "../engine/solver.mjs";
import { SCENARIOS } from "../engine/scenarios.mjs";

/** @typedef {import("../model/schema.mjs").RunwayState} RunwayState */
/** @typedef {import("../model/schema.mjs").Issue} Issue */
/** @typedef {{file: string, ts: string, source: string}} SnapshotInfo */
/**
 * @typedef {Object} Manifest advisory metadata — never authoritative for schema decisions
 * @property {string} app
 * @property {string} appVersion
 * @property {number} schemaVersion
 * @property {string} identity random UUID, NEVER derived from the path
 * @property {number} rev
 */
/**
 * @typedef {Object} LoadResult
 * @property {boolean} seeded
 * @property {RunwayState} [state]
 * @property {Issue[]} [warnings]
 * @property {boolean} [migrated]
 * @property {number} [rev]
 * @property {boolean} [corrupt]
 * @property {string} [quarantinedAs]
 * @property {SnapshotInfo[]} [snapshots]
 */
/** @typedef {ReturnType<typeof createStore>} Store */

export class LockHeldError extends Error {
  /** @param {number} pid @param {string} lockPath */
  constructor(pid, lockPath) {
    super(
      `data dir is locked by another running runway process (pid ${pid}) — close it first, or delete ${lockPath} if pid ${pid} is not runway`
    );
    this.name = "LockHeldError";
    this.pid = pid;
  }
}

export class RevConflictError extends Error {
  /** @param {number} rev */
  constructor(rev) {
    super(`stale baseRev — the store is at rev ${rev}; reload before retrying`);
    this.name = "RevConflictError";
    this.rev = rev;
  }
}

export class ValidationError extends Error {
  /** @param {Issue[]} issues */
  constructor(issues) {
    super(`state failed validation: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export class SnapshotNotFoundError extends Error {
  /** @param {string} file */
  constructor(file) {
    super(`snapshot not found: ${file}`);
    this.name = "SnapshotNotFoundError";
    this.file = file;
  }
}

export class SnapshotCorruptError extends Error {
  /** @param {string} file @param {string} why */
  constructor(file, why) {
    super(`snapshot ${file} is corrupt (${why}) — refusing to restore it`);
    this.name = "SnapshotCorruptError";
    this.file = file;
  }
}

// Filesystem-safe ISO stamp (colons/dots are illegal on some filesystems).
/** @param {Date} d */
function tsSlug(d) {
  return d.toISOString().replace(/[:.]/g, "-");
}

const SNAP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(.+)\.json$/;

// Source tag of the raw v0-export provenance copy written by importV0. It is
// versionless (no schemaVersion), so restore would always refuse it — kept on
// disk but hidden from listSnapshots() so the UI never offers to restore it.
const V0_PROVENANCE_SOURCE = "migration-v0-export";

let tmpCounter = 0;

/**
 * The atomic write primitive used by every data-file write: write a temp file
 * in the SAME directory, fsync it, rename over the target, then fsync the
 * directory (best-effort — some platforms refuse to fsync a directory fd).
 * @param {string} filePath @param {string} data
 */
function atomicWriteSync(filePath, data) {
  const dir = dirname(filePath);
  const tmp = join(dir, `.${basename(filePath)}.tmp-${process.pid}-${tmpCounter++}`);
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, filePath);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* dir fsync is best-effort */
  }
}

/** @param {string} filePath @returns {string|null} contents, or null if the file doesn't exist */
function readFileSafe(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
    throw e;
  }
}

/** @param {number} pid */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but isn't ours — still alive.
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/** @param {unknown} e */
function message(e) {
  return e instanceof Error ? e.message : String(e);
}

/** @param {import("../engine/solver.mjs").SolverResult} r */
function encodeRequired(r) {
  return r.kind === "value" ? { kind: r.kind, perYear: r.perYear } : { kind: r.kind };
}

// Aux-file (transactions.json / mappings.json) envelope version — independent
// of the state SCHEMA_VERSION.
export const AUX_SCHEMA_VERSION = 1;

/**
 * @param {string} dataDir absolute path
 * @param {{now?: () => Date, _failAfter?: "current-write"|"transactions-write"|null}} [opts]
 *   `now` is the injectable clock; `_failAfter` is a test-only hook that is
 *   read live on every save/write, so tests can pin commit-order invariants.
 */
export function createStore(dataDir, opts = {}) {
  const now = opts.now ?? (() => new Date());
  const currentPath = join(dataDir, "current.json");
  const snapDir = join(dataDir, "snapshots");
  const trendsPath = join(dataDir, "trends.jsonl");
  const manifestPath = join(dataDir, "manifest.json");
  const lockPath = join(dataDir, "runway.lock");
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const appVersion = String(pkg.version);

  /** @type {Manifest} */
  let manifest = { app: "runway", appVersion, schemaVersion: SCHEMA_VERSION, identity: randomUUID(), rev: 0 };
  let locked = false;
  // Rev of the last trend row appended this session — drives the shutdown hook.
  let lastTrendRev = 0;

  /** @param {RunwayState} state */
  function serialize(state) {
    return JSON.stringify(state, null, 2) + "\n";
  }

  /** @param {Date} d */
  function dateOf(d) {
    return d.toISOString().slice(0, 10);
  }

  function acquireLock() {
    // The lock needs create-exclusive semantics, so it is the one write that
    // can't go through the rename primitive (rename replaces silently).
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        writeFileSync(lockPath, String(process.pid), { flag: "wx" });
        locked = true;
        return;
      } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
        const pid = Number.parseInt(readFileSafe(lockPath) ?? "", 10);
        if (Number.isInteger(pid) && pidAlive(pid)) throw new LockHeldError(pid, lockPath);
        try {
          unlinkSync(lockPath); // stale lock from a dead process — clear it
        } catch {
          /* raced with someone else clearing it */
        }
      }
    }
    throw new Error(`could not acquire ${lockPath}`);
  }

  /** @returns {Manifest} */
  function loadOrCreateManifest() {
    /** @type {Manifest} */
    const fresh = { app: "runway", appVersion, schemaVersion: SCHEMA_VERSION, identity: randomUUID(), rev: 0 };
    const raw = readFileSafe(manifestPath);
    if (raw === null) {
      atomicWriteSync(manifestPath, JSON.stringify(fresh, null, 2) + "\n");
      return fresh;
    }
    try {
      const m = JSON.parse(raw);
      return {
        app: "runway",
        appVersion,
        // Advisory only: refreshed to the app's version. Each data file's own
        // schemaVersion governs load decisions, never the manifest's.
        schemaVersion: SCHEMA_VERSION,
        identity: typeof m.identity === "string" && m.identity ? m.identity : fresh.identity,
        rev: typeof m.rev === "number" && Number.isInteger(m.rev) && m.rev >= 0 ? m.rev : 0,
      };
    } catch {
      quarantineFile(manifestPath); // garbled manifest — preserve, start fresh
      atomicWriteSync(manifestPath, JSON.stringify(fresh, null, 2) + "\n");
      return fresh;
    }
  }

  function writeManifest() {
    try {
      atomicWriteSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    } catch (e) {
      process.stderr.write(`runway: manifest write failed (advisory, continuing): ${message(e)}\n`);
    }
  }

  function bumpRev() {
    manifest.rev += 1;
    writeManifest();
    return manifest.rev;
  }

  /**
   * Rename a damaged file aside — never delete or overwrite user data.
   * @param {string} filePath
   */
  function quarantineFile(filePath) {
    const q = `${filePath}.corrupt-${tsSlug(now())}`;
    renameSync(filePath, q);
    return basename(q);
  }

  /** @returns {LoadResult} */
  function quarantineCurrent() {
    const quarantinedAs = quarantineFile(currentPath);
    return { seeded: false, corrupt: true, quarantinedAs, snapshots: listSnapshots() };
  }

  /**
   * Write raw bytes as a source-tagged snapshot. Bumps the millisecond stamp
   * on filename collision (injected fixed clocks would otherwise overwrite).
   * @param {string} bytes @param {string} source
   */
  function writeSnapshotBytes(bytes, source) {
    let ts = now();
    let file = `${tsSlug(ts)}-${source}.json`;
    while (existsSync(join(snapDir, file))) {
      ts = new Date(ts.getTime() + 1);
      file = `${tsSlug(ts)}-${source}.json`;
    }
    atomicWriteSync(join(snapDir, file), bytes);
    return file;
  }

  /** @param {string} date YYYY-MM-DD */
  function hasSnapshotForDate(date) {
    let names;
    try {
      names = readdirSync(snapDir);
    } catch {
      return false;
    }
    return names.some((n) => n.startsWith(date) && SNAP_RE.test(n));
  }

  /**
   * Trend rows are computed by the SERVER from the state it just persisted —
   * never accepted from a client.
   * @param {RunwayState} state @param {string} source @param {number} rev
   */
  function computeTrendRow(state, source, rev) {
    const ts = now();
    const base = SCENARIOS.find((sc) => sc.key === "base");
    const worst = SCENARIOS.find((sc) => sc.key === "everything");
    return {
      v: 1,
      ts: ts.toISOString(),
      date: dateOf(ts),
      source,
      rev,
      totalBalance: state.portfolio.balance,
      // Current-year monthly spend: only categories active now (respects windows).
      monthlySpend: state.spending.reduce((sum, c) => {
        const cy = state.profile.currentYear;
        const active = (c.fromYear === null || c.fromYear === undefined || cy >= c.fromYear) && (c.toYear === null || c.toYear === undefined || cy <= c.toYear);
        return active ? sum + c.monthly : sum;
      }, 0),
      requiredBase: encodeRequired(requiredIncome(state, base?.overlay ?? {})),
      requiredWorst: encodeRequired(requiredIncome(state, worst?.overlay ?? {})),
    };
  }

  /**
   * Append one self-describing JSONL row. Torn-tail discipline: if the file
   * doesn't end in a newline (crash mid-write), truncate back to the last
   * complete line before appending.
   * @param {RunwayState} state @param {string} source @param {number} rev
   */
  function appendTrendRow(state, source, rev) {
    const row = computeTrendRow(state, source, rev);
    let content = readFileSafe(trendsPath) ?? "";
    if (content && !content.endsWith("\n")) content = content.slice(0, content.lastIndexOf("\n") + 1);
    atomicWriteSync(trendsPath, content + JSON.stringify(row) + "\n");
    lastTrendRev = rev;
  }

  /**
   * Prepare the data dir and take the pid lock. Throws LockHeldError if a
   * live runway process already owns this dir.
   */
  function init() {
    mkdirSync(snapDir, { recursive: true });
    acquireLock();
    manifest = loadOrCreateManifest();
    lastTrendRev = manifest.rev;
    const gitignorePath = join(dataDir, ".gitignore");
    if (!existsSync(gitignorePath)) atomicWriteSync(gitignorePath, "*\n");
    const readmePath = join(dataDir, "README.md");
    if (!existsSync(readmePath)) {
      atomicWriteSync(
        readmePath,
        "# Runway data\n\nThis folder contains real financial data — do not commit, share, or place in a cloud-synced folder.\n"
      );
    }
  }

  /** Release the pid lock (only if this process holds it). */
  function close() {
    if (!locked) return;
    try {
      if (readFileSafe(lockPath) === String(process.pid)) unlinkSync(lockPath);
    } catch {
      /* best-effort */
    }
    locked = false;
  }

  /**
   * Load current.json. Unseeded dirs return { seeded: false } and NOTHING is
   * written — the placeholder lives in memory only until the first user edit.
   * Anything corrupt is quarantined aside, never overwritten silently.
   * @returns {LoadResult}
   */
  function load() {
    const raw = readFileSafe(currentPath);
    if (raw === null) return { seeded: false };
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return quarantineCurrent();
    }
    const v = data === null || typeof data !== "object" ? undefined : data.schemaVersion;
    // A missing/garbled schemaVersion on the load path is corrupt — never
    // sniffed. v0 exports enter only via the explicit importV0 path.
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return quarantineCurrent();
    if (v > SCHEMA_VERSION) throw new FutureVersionError(v);

    let state = data;
    let migrated = false;
    if (v < SCHEMA_VERSION) {
      writeSnapshotBytes(raw, "migration"); // preserve pre-migration bytes first
      state = migrate(data).state;
      migrated = true;
    }
    const { errors, warnings } = validate(state);
    if (errors.length) return quarantineCurrent();
    if (migrated) {
      atomicWriteSync(currentPath, serialize(state));
      bumpRev();
    }
    return { seeded: true, state, warnings, migrated, rev: manifest.rev };
  }

  /**
   * Versioned aux-file loader with current.json quarantine parity: not JSON,
   * a missing/garbled schemaVersion, or a payload of the wrong shape is
   * quarantined aside (never overwritten silently); a FUTURE schemaVersion
   * throws and leaves the file untouched (update the app, never downgrade
   * the data); a missing file is the empty default.
   * @template T
   * @param {string} filePath @param {string} key envelope payload key
   * @param {T} empty @param {(v: unknown) => v is T} isValid
   * @returns {{data: T, corrupt?: boolean, quarantinedAs?: string}}
   */
  function loadVersioned(filePath, key, empty, isValid) {
    const raw = readFileSafe(filePath);
    if (raw === null) return { data: empty };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { data: empty, corrupt: true, quarantinedAs: quarantineFile(filePath) };
    }
    const v = parsed === null || typeof parsed !== "object" ? undefined : parsed.schemaVersion;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      return { data: empty, corrupt: true, quarantinedAs: quarantineFile(filePath) };
    }
    if (v > AUX_SCHEMA_VERSION) throw new FutureVersionError(v);
    const payload = /** @type {Record<string, unknown>} */ (parsed)[key];
    if (!isValid(payload)) {
      return { data: empty, corrupt: true, quarantinedAs: quarantineFile(filePath) };
    }
    return { data: payload };
  }

  /**
   * Load transactions.json ({schemaVersion, transactions: [...]}) — the
   * transactions array is returned, defaulting to [].
   * @returns {{data: any[], corrupt?: boolean, quarantinedAs?: string}}
   */
  function loadTransactions() {
    return loadVersioned(
      join(dataDir, "transactions.json"),
      "transactions",
      /** @type {any[]} */ ([]),
      /** @returns {v is any[]} */ (v) => Array.isArray(v)
    );
  }

  /**
   * Load mappings.json ({schemaVersion, mappings: {...}}) — the mappings
   * object (keyed by header signature) is returned, defaulting to {}.
   * @returns {{data: Record<string, any>, corrupt?: boolean, quarantinedAs?: string}}
   */
  function loadMappings() {
    return loadVersioned(
      join(dataDir, "mappings.json"),
      "mappings",
      /** @type {Record<string, any>} */ ({}),
      /** @returns {v is Record<string, any>} */ (v) => v !== null && typeof v === "object" && !Array.isArray(v)
    );
  }

  /**
   * Replace transactions.json wholesale (the API layer merges stored + fresh
   * rows first). Because this is a full replace, the previous file is first
   * preserved as transactions.json.bak-{ts} via the atomic primitive — never
   * silently destroyed. Callers must write transactions BEFORE current.json
   * (see the module header for the crash-repair rationale).
   * @param {any[]} transactions
   * @returns {{bak: string|null}}
   */
  function writeTransactions(transactions) {
    if (!Array.isArray(transactions)) throw new Error("transactions must be an array");
    const filePath = join(dataDir, "transactions.json");
    const existing = readFileSafe(filePath);
    let bak = null;
    if (existing !== null) {
      bak = `${filePath}.bak-${tsSlug(now())}`;
      atomicWriteSync(bak, existing);
    }
    atomicWriteSync(filePath, JSON.stringify({ schemaVersion: AUX_SCHEMA_VERSION, transactions }, null, 2) + "\n");
    if (opts._failAfter === "transactions-write") {
      throw new Error("injected failure: crashed after transactions.json commit");
    }
    return { bak: bak === null ? null : basename(bak) };
  }

  /**
   * Persist the saved-mappings object (keyed by header signature), atomic.
   * @param {Record<string, any>} mappings
   */
  function writeMappings(mappings) {
    if (mappings === null || typeof mappings !== "object" || Array.isArray(mappings)) {
      throw new Error("mappings must be an object");
    }
    atomicWriteSync(
      join(dataDir, "mappings.json"),
      JSON.stringify({ schemaVersion: AUX_SCHEMA_VERSION, mappings }, null, 2) + "\n"
    );
  }

  /**
   * Validate and persist a state. Validation errors reject; warnings pass
   * through. See the module header for the pinned commit order.
   * @param {RunwayState} state
   * @param {{source?: string}} [saveOpts]
   * @returns {{rev: number, warnings: Issue[]}}
   */
  function save(state, { source = "edit" } = {}) {
    const { errors, warnings } = validate(state);
    if (errors.length) throw new ValidationError(errors);
    const bytes = serialize(state);
    // (1) current commits first — trends are always a subset of committed history.
    atomicWriteSync(currentPath, bytes);
    if (opts._failAfter === "current-write") throw new Error("injected failure: crashed after current.json commit");
    const rev = bumpRev();
    // (2) snapshot once per calendar date, then (3) its trend row.
    // Neither failure may fail the save.
    if (!hasSnapshotForDate(dateOf(now()))) {
      try {
        writeSnapshotBytes(bytes, source);
        appendTrendRow(state, source, rev);
      } catch (e) {
        process.stderr.write(`runway: snapshot/trend write failed (save already committed): ${message(e)}\n`);
      }
    }
    return { rev, warnings };
  }

  /**
   * Copy the current on-disk state to a source-tagged snapshot (used before
   * import/restore/migration), plus its trend row when the state is readable.
   * @param {string} source
   */
  function snapshotNow(source) {
    const raw = readFileSafe(currentPath);
    if (raw === null) throw new Error("nothing to snapshot — current.json does not exist");
    const file = writeSnapshotBytes(raw, source);
    try {
      const data = JSON.parse(raw);
      if (data?.schemaVersion === SCHEMA_VERSION && validate(data).errors.length === 0) {
        appendTrendRow(data, source, manifest.rev);
      }
    } catch (e) {
      process.stderr.write(`runway: trend row skipped for snapshot ${file}: ${message(e)}\n`);
    }
    return { file };
  }

  /** @returns {SnapshotInfo[]} sorted newest-first; v0 provenance copies are excluded (not restorable) */
  function listSnapshots() {
    /** @type {SnapshotInfo[]} */
    const out = [];
    let names;
    try {
      names = readdirSync(snapDir);
    } catch {
      return out;
    }
    for (const name of names) {
      const m = SNAP_RE.exec(name);
      if (!m) continue;
      if (m[6] === V0_PROVENANCE_SOURCE) continue; // provenance only — never a restore target
      out.push({ file: name, ts: `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`, source: m[6] });
    }
    out.sort((a, b) => (a.file < b.file ? 1 : a.file > b.file ? -1 : 0));
    return out;
  }

  /**
   * Install a snapshot as current.json. The restored bytes equal the snapshot
   * bytes (rev lives in the manifest, never inside the data), except when the
   * snapshot carries an older schema and must be migrated on the way in.
   * Snapshots cover current.json ONLY — restore never touches
   * transactions.json / mappings.json (see module header).
   * @param {string} file snapshot filename (validated against the listing)
   * @param {{baseRev: number}} restoreOpts
   * @returns {{rev: number, state: RunwayState, warnings: Issue[]}}
   */
  function restore(file, { baseRev }) {
    if (baseRev !== manifest.rev) throw new RevConflictError(manifest.rev);
    const name = basename(String(file));
    if (!listSnapshots().some((s) => s.file === name)) throw new SnapshotNotFoundError(name);
    const raw = readFileSync(join(snapDir, name), "utf8");
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new SnapshotCorruptError(name, "not valid JSON");
    }
    const v = data === null || typeof data !== "object" ? undefined : data.schemaVersion;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      throw new SnapshotCorruptError(name, "missing schemaVersion");
    }
    if (v > SCHEMA_VERSION) throw new FutureVersionError(v);

    let bytes = raw;
    let state = data;
    if (v < SCHEMA_VERSION) {
      writeSnapshotBytes(raw, "migration"); // pre-migration provenance
      state = migrate(data).state;
      bytes = serialize(state);
    }
    const { errors, warnings } = validate(state);
    if (errors.length) throw new ValidationError(errors);

    // Preserve what we're leaving — unless current.json is already gone
    // (corrupt-recovery: the corrupt file is preserved in quarantine).
    if (existsSync(currentPath)) snapshotNow("restore");
    atomicWriteSync(currentPath, bytes);
    const rev = bumpRev();
    return { rev, state, warnings };
  }

  /**
   * The ONLY path that accepts versionless data: the v0 localStorage export,
   * explicitly declared by the user. The raw export is preserved verbatim in
   * snapshots/ as provenance before the ladder touches it.
   * @param {any} rawData
   * @param {{baseRev: number}} importOpts
   * @returns {{rev: number, state: RunwayState, warnings: Issue[]}}
   */
  function importV0(rawData, { baseRev }) {
    if (baseRev !== manifest.rev) throw new RevConflictError(manifest.rev);
    writeSnapshotBytes(JSON.stringify(rawData, null, 2) + "\n", V0_PROVENANCE_SOURCE);
    const { state } = migrate(rawData, { declaredVersion: 0 });
    if (existsSync(currentPath)) snapshotNow("import");
    const { rev, warnings } = save(state, { source: "migration" });
    return { rev, state, warnings };
  }

  /**
   * Reset to unseeded (U6): preserve the current state as a snapshot, then
   * delete current.json and bump the rev. The placeholder is never written —
   * the next load sees an unseeded dir, exactly like first run.
   * transactions.json / mappings.json are NOT touched (see module header) —
   * imported transactions persist across reset and restore.
   * @param {{baseRev: number}} resetOpts
   * @returns {{rev: number}}
   */
  function reset({ baseRev }) {
    if (baseRev !== manifest.rev) throw new RevConflictError(manifest.rev);
    if (existsSync(currentPath)) {
      snapshotNow("edit");
      unlinkSync(currentPath);
    }
    return { rev: bumpRev() };
  }

  /** @returns {any[]} parsed rows; unparseable lines skipped, unknown fields tolerated */
  function readTrends() {
    const raw = readFileSafe(trendsPath);
    if (raw === null) return [];
    /** @type {any[]} */
    const rows = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* torn/garbled line — skip */
      }
    }
    return rows;
  }

  /** Shutdown hook: append a final trend row if the rev moved since the last one. */
  function appendShutdownTrend() {
    if (manifest.rev === lastTrendRev) return;
    const raw = readFileSafe(currentPath);
    if (raw === null) return;
    try {
      const data = JSON.parse(raw);
      if (data?.schemaVersion !== SCHEMA_VERSION) return;
      if (validate(data).errors.length) return;
      appendTrendRow(data, "shutdown", manifest.rev);
    } catch (e) {
      process.stderr.write(`runway: shutdown trend skipped: ${message(e)}\n`);
    }
  }

  return {
    init,
    close,
    load,
    loadTransactions,
    loadMappings,
    writeTransactions,
    writeMappings,
    save,
    snapshotNow,
    listSnapshots,
    restore,
    importV0,
    reset,
    readTrends,
    appendShutdownTrend,
    rev: () => manifest.rev,
    identity: () => manifest.identity,
    appVersion: () => appVersion,
    // The store owns the clock; the API layer reads "now" through here so the
    // derivation window (current-month exclusion) stays test-controllable.
    now: () => now(),
  };
}
