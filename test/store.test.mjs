// Store tests: lockfile, quarantine, snapshot-per-day, trend discipline,
// restore/import round trips, and the commit-order invariant via failure
// injection. All against tmp dirs with an injected clock.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStore,
  LockHeldError,
  RevConflictError,
  SnapshotCorruptError,
  ValidationError,
} from "../src/server/store.mjs";
import { FutureVersionError } from "../src/model/migrate.mjs";
import { placeholderState } from "../src/model/placeholder.mjs";
import { SCHEMA_VERSION } from "../src/model/schema.mjs";
import { activeState, makeWorkspace, WORKSPACE_VERSION } from "../src/model/workspace.mjs";

/** @type {string[]} */
const dirs = [];
/** @type {ReturnType<typeof createStore>[]} */
const stores = [];

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), "runway-store-"));
  dirs.push(dir);
  return dir;
}

/** Store with a mutable injected clock and deterministic scenario ids. */
function makeStore(dir, iso = "2026-07-10T10:00:00.000Z") {
  let idN = 0;
  const opts = {
    now: () => clockRef.t,
    makeId: () => `id-${idN++}`,
    _failAfter: /** @type {any} */ (null),
  };
  const clockRef = { t: new Date(iso) };
  const store = createStore(dir, opts);
  stores.push(store);
  return { store, clockRef, opts };
}

// One taxable account holding `balance`, so the trend row's totalBalance
// (the sum of all accounts) equals the marker value.
function stateWithBalance(balance) {
  const s = placeholderState();
  s.accounts = [{ ...s.accounts[0], balance, costBasis: null }];
  return s;
}

// save() now takes a WORKSPACE, not a bare state. Wrap a balance-tagged state as
// the sole "Base plan" scenario. A stable id keeps on-disk bytes deterministic.
function wsWith(balance, id = "s1") {
  return makeWorkspace({ id, state: stateWithBalance(balance) });
}

function snapFiles(dir) {
  return readdirSync(join(dir, "snapshots")).filter((n) => n.endsWith(".json"));
}

// Read the active scenario's state out of the on-disk workspace at current.json.
function activeStateOnDisk(dir) {
  const ws = JSON.parse(readFileSync(join(dir, "current.json"), "utf8"));
  return ws.scenarios.find((s) => s.id === ws.activeId).state;
}

function trendLines(dir) {
  const p = join(dir, "trends.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
}

after(() => {
  for (const store of stores) store.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const V0_EXPORT = {
  profile: { currentAge: 40, endAge: 92, currentYear: 2026 },
  portfolio: { balance: 1500000, realReturnPct: 4.0 },
  properties: [],
  incomes: [{ name: "W2", annual: 180000, fromYear: 2026 }],
  spending: [{ name: "living", monthly: 2500 }],
  social: { startAge: 67, monthly: 2800, haircutPct: 25 },
  health: { preMedicareAnnual: 18000, postMedicareAnnual: 7000, employerCoverageUntilAge: 40 },
  endState: { mode: "bequest", amount: 500000 },
  work: { untilAge: 50 },
};

test("unseeded init writes manifest/.gitignore/README but NO current.json", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();

  assert.ok(!existsSync(join(dir, "current.json")), "placeholder must never touch disk");
  assert.ok(existsSync(join(dir, "snapshots")));
  assert.ok(existsSync(join(dir, "runway.lock")));
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8").trim(), "*");
  assert.match(readFileSync(join(dir, "README.md"), "utf8"), /real financial data/);

  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.app, "runway");
  assert.equal(manifest.rev, 0);
  assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
  assert.match(manifest.identity, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  assert.deepEqual(store.load(), { seeded: false });
  assert.ok(!existsSync(join(dir, "current.json")), "load of unseeded dir writes nothing");
  assert.deepEqual(store.loadTransactions(), { data: [] });
  assert.deepEqual(store.loadMappings(), { data: {} });
});

test("first save of a date: current + one snapshot + one trend row; 20 same-day saves add neither", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();

  const first = store.save(wsWith(1_000_000));
  assert.equal(first.rev, 1);
  assert.ok(existsSync(join(dir, "current.json")));
  assert.equal(snapFiles(dir).length, 1);
  assert.match(snapFiles(dir)[0], /^2026-07-10T.*-edit\.json$/);
  assert.equal(trendLines(dir).length, 1);

  for (let i = 0; i < 19; i++) store.save(wsWith(1_000_000 + i));
  assert.equal(store.rev(), 20);
  assert.equal(snapFiles(dir).length, 1, "still exactly one snapshot for the day");
  assert.equal(trendLines(dir).length, 1, "trend rows follow snapshot events, not saves");
  const current = JSON.parse(readFileSync(join(dir, "current.json"), "utf8"));
  // current.json is now a WORKSPACE — read the active scenario's state.
  assert.equal(current.workspaceVersion, WORKSPACE_VERSION);
  const active = current.scenarios.find((s) => s.id === current.activeId);
  assert.equal(active.name, "Base plan");
  assert.equal(active.state.accounts[0].balance, 1_000_018, "current.json still updates every save");

  const row = JSON.parse(trendLines(dir)[0]);
  assert.equal(row.v, 4, "trend rows are v4 (simulated gap + chance of success)");
  assert.equal(row.date, "2026-07-10");
  assert.equal(row.source, "edit");
  assert.equal(row.rev, 1);
  assert.equal(row.scenario, "Base plan", "trend row carries the active scenario name");
  assert.equal(row.totalBalance, 1_000_000);
  assert.equal(row.monthlySpend, 3500 + 3000 + 1200); // the placeholder's spending lines
  assert.ok(["met", "value", "unreachable"].includes(row.gapBase.kind), "trend rows track the gap");
  assert.ok(row.successBase >= 0 && row.successBase <= 1, "and the chance of success");
  assert.ok(!("rev" in current), "rev is server-owned, never inside current.json");
});

test("next calendar date: save produces a second snapshot and trend row", () => {
  const dir = makeDir();
  const { store, clockRef } = makeStore(dir);
  store.init();
  store.save(wsWith(100));
  clockRef.t = new Date("2026-07-11T09:00:00.000Z");
  store.save(wsWith(200));
  assert.equal(snapFiles(dir).length, 2);
  assert.equal(trendLines(dir).length, 2);
});

test("corrupt current.json is quarantined with recovery info, never overwritten", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();
  store.save(wsWith(500));
  store.close();

  writeFileSync(join(dir, "current.json"), "{ this is not json");
  const { store: store2 } = makeStore(dir);
  store2.init();
  const result = store2.load();
  assert.equal(result.seeded, false);
  assert.equal(result.corrupt, true);
  assert.match(result.quarantinedAs, /^current\.json\.corrupt-/);
  assert.equal(result.snapshots.length, 1, "recovery lists available snapshots");
  assert.ok(!existsSync(join(dir, "current.json")));
  assert.equal(readFileSync(join(dir, result.quarantinedAs), "utf8"), "{ this is not json");
});

test("corrupt transactions.json quarantined, empty default returned", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();
  writeFileSync(join(dir, "transactions.json"), "nope[");
  const result = store.loadTransactions();
  assert.deepEqual(result.data, []);
  assert.equal(result.corrupt, true);
  assert.match(result.quarantinedAs, /^transactions\.json\.corrupt-/);
  assert.ok(!existsSync(join(dir, "transactions.json")));
});

test("aux envelopes: payload extracted; missing schemaVersion or wrong payload shape quarantined; future version refuses, file untouched", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();

  const row = { date: "2026-05-01", amount: 12.5, description: "COFFEE", category: "fun" };
  writeFileSync(join(dir, "transactions.json"), JSON.stringify({ schemaVersion: 1, transactions: [row] }));
  assert.deepEqual(store.loadTransactions(), { data: [row] });
  writeFileSync(join(dir, "mappings.json"), JSON.stringify({ schemaVersion: 1, mappings: { abc: { mapping: {} } } }));
  assert.deepEqual(store.loadMappings(), { data: { abc: { mapping: {} } } });

  // Versionless (the pre-envelope raw-array shape) is corrupt on the load
  // path — quarantined, exactly like a versionless current.json.
  writeFileSync(join(dir, "transactions.json"), JSON.stringify([row]));
  const versionless = store.loadTransactions();
  assert.equal(versionless.corrupt, true);
  assert.deepEqual(versionless.data, []);
  assert.ok(!existsSync(join(dir, "transactions.json")));

  // Right version, wrong payload shape → quarantined too.
  writeFileSync(join(dir, "mappings.json"), JSON.stringify({ schemaVersion: 1, mappings: [] }));
  const badShape = store.loadMappings();
  assert.equal(badShape.corrupt, true);
  assert.deepEqual(badShape.data, {});

  // Future version → refuse and PRESERVE (never quarantine newer data).
  writeFileSync(join(dir, "transactions.json"), JSON.stringify({ schemaVersion: 99, transactions: [] }));
  assert.throws(() => store.loadTransactions(), FutureVersionError);
  assert.ok(existsSync(join(dir, "transactions.json")), "future-versioned file left untouched");
});

test("writeTransactions: envelope written; overwrite preserves the prior file as .bak; writeMappings round-trips", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();

  const a = { date: "2026-05-01", amount: 4.5, description: "COFFEE", category: "uncategorized" };
  const first = store.writeTransactions([a]);
  assert.equal(first.bak, null, "no .bak when there was nothing to preserve");
  const onDisk = JSON.parse(readFileSync(join(dir, "transactions.json"), "utf8"));
  assert.equal(onDisk.schemaVersion, 1);
  assert.deepEqual(onDisk.transactions, [a]);

  const b = { date: "2026-05-02", amount: 9, description: "LUNCH", category: "uncategorized" };
  const second = store.writeTransactions([a, b]);
  assert.match(second.bak, /^transactions\.json\.bak-/);
  const bak = JSON.parse(readFileSync(join(dir, second.bak), "utf8"));
  assert.deepEqual(bak.transactions, [a], ".bak carries the pre-overwrite contents");
  assert.deepEqual(store.loadTransactions(), { data: [a, b] });

  store.writeMappings({ sig1: { mapping: { date: "Date" } } });
  assert.deepEqual(store.loadMappings(), { data: { sig1: { mapping: { date: "Date" } } } });
});

test("reset and restore never touch transactions.json/mappings.json (outside snapshot scope)", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();
  store.save(wsWith(500));
  const rows = [{ date: "2026-05-01", amount: 4.5, description: "COFFEE", category: "uncategorized" }];
  store.writeTransactions(rows);
  store.writeMappings({ sig: { mapping: {} } });
  const snap = store.listSnapshots()[0];

  store.reset({ baseRev: store.rev() });
  assert.deepEqual(store.loadTransactions().data, rows, "reset leaves transactions alone");
  assert.deepEqual(store.loadMappings().data, { sig: { mapping: {} } }, "reset leaves mappings alone");

  store.restore(snap.file, { baseRev: store.rev() });
  assert.deepEqual(store.loadTransactions().data, rows, "restore leaves transactions alone");
});

test("restore round-trip: bytes equal snapshot, pre-restore snapshot tagged, rev bumped", () => {
  const dir = makeDir();
  const { store, clockRef } = makeStore(dir);
  store.init();
  store.save(wsWith(111)); // day 1 snapshot
  clockRef.t = new Date("2026-07-11T09:00:00.000Z");
  store.save(wsWith(222)); // day 2 snapshot
  assert.equal(store.rev(), 2);

  const day1 = store.listSnapshots().find((s) => s.ts.startsWith("2026-07-10"));
  const preRestoreBytes = readFileSync(join(dir, "current.json"), "utf8");

  assert.throws(() => store.restore(day1.file, { baseRev: 0 }), RevConflictError);
  assert.equal(store.rev(), 2, "conflicted restore is a no-op");

  const result = store.restore(day1.file, { baseRev: 2 });
  assert.equal(result.rev, 3);
  assert.equal(
    readFileSync(join(dir, "current.json"), "utf8"),
    readFileSync(join(dir, "snapshots", day1.file), "utf8"),
    "restored bytes equal the snapshot bytes"
  );
  const restoreSnap = store.listSnapshots().find((s) => s.source === "restore");
  assert.ok(restoreSnap, "pre-restore snapshot exists");
  assert.equal(readFileSync(join(dir, "snapshots", restoreSnap.file), "utf8"), preRestoreBytes);
});

test("restore skips the pre-restore snapshot in corrupt-recovery (no current.json)", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();
  store.save(wsWith(42));
  const snap = store.listSnapshots()[0];

  writeFileSync(join(dir, "current.json"), "garbage");
  const loaded = store.load();
  assert.equal(loaded.corrupt, true);

  const result = store.restore(snap.file, { baseRev: 1 });
  assert.equal(result.rev, 2);
  assert.ok(!store.listSnapshots().some((s) => s.source === "restore"), "no pre-snapshot when current was already gone");
  assert.equal(activeState(result.workspace).accounts[0].balance, 42);
  assert.equal(activeStateOnDisk(dir).accounts[0].balance, 42);
});

test("snapshot with missing schemaVersion refuses to restore", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();
  store.save(wsWith(7));
  writeFileSync(join(dir, "snapshots", "2026-07-01T00-00-00-000Z-edit.json"), JSON.stringify({ foo: 1 }));

  assert.throws(
    () => store.restore("2026-07-01T00-00-00-000Z-edit.json", { baseRev: 1 }),
    SnapshotCorruptError
  );
  assert.equal(activeStateOnDisk(dir).accounts[0].balance, 7);
  assert.equal(store.rev(), 1);
});

test("reset: snapshots current, deletes it, bumps rev, returns to unseeded; rev-checked", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();
  store.save(wsWith(777_000));
  const snapsBefore = snapFiles(dir).length;

  assert.throws(() => store.reset({ baseRev: 99 }), RevConflictError);
  assert.ok(existsSync(join(dir, "current.json")), "conflicted reset is a no-op");

  const { rev } = store.reset({ baseRev: store.rev() });
  assert.equal(rev, 2);
  assert.ok(!existsSync(join(dir, "current.json")), "current.json deleted");
  assert.equal(snapFiles(dir).length, snapsBefore + 1, "pre-reset state preserved as a snapshot");
  const newest = store.listSnapshots()[0];
  const preserved = JSON.parse(readFileSync(join(dir, "snapshots", newest.file), "utf8"));
  const preservedActive = preserved.scenarios.find((s) => s.id === preserved.activeId);
  assert.equal(preservedActive.state.accounts[0].balance, 777_000, "snapshot carries the pre-reset state");
  assert.deepEqual(store.load(), { seeded: false }, "store is unseeded again — placeholder stays in memory");
});

test("v0 import: provenance copy saved, migrated state validates, rev bumped", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();

  const result = store.importV0(V0_EXPORT, { baseRev: 0 });
  assert.equal(result.rev, 1);
  const imported = activeState(result.workspace);
  assert.equal(imported.schemaVersion, SCHEMA_VERSION);
  assert.equal(imported.endState.amounts.bequest, 500000);
  // The migrated v0 state is wrapped as the sole "Base plan" scenario.
  assert.equal(result.workspace.scenarios.length, 1);
  assert.equal(result.workspace.scenarios[0].name, "Base plan");

  const provenance = snapFiles(dir).find((n) => n.endsWith("-migration-v0-export.json"));
  assert.ok(provenance, "raw export preserved verbatim in snapshots/");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "snapshots", provenance), "utf8")), V0_EXPORT);
  const onDisk = JSON.parse(readFileSync(join(dir, "current.json"), "utf8"));
  assert.equal(onDisk.workspaceVersion, WORKSPACE_VERSION, "current.json is a workspace");
  assert.equal(activeStateOnDisk(dir).schemaVersion, SCHEMA_VERSION);

  // The provenance copy stays ON DISK but is hidden from listSnapshots() —
  // it has no schemaVersion, so listing it would be a one-click-restore trap.
  const listed = store.listSnapshots();
  assert.ok(!listed.some((s) => s.source === "migration-v0-export"), "provenance absent from the restorable listing");
  assert.ok(!listed.some((s) => s.file === provenance));

  assert.throws(() => store.importV0(V0_EXPORT, { baseRev: 0 }), RevConflictError);
});

test("versionless data on the LOAD path still quarantines (import is the only v0 door)", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();
  writeFileSync(join(dir, "current.json"), JSON.stringify(V0_EXPORT));
  const result = store.load();
  assert.equal(result.corrupt, true);
  assert.match(result.quarantinedAs, /corrupt/);
});

test("future schemaVersion in current.json refuses to load", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();
  const future = { ...placeholderState(), schemaVersion: SCHEMA_VERSION + 1 };
  writeFileSync(join(dir, "current.json"), JSON.stringify(future));
  assert.throws(() => store.load(), FutureVersionError);
  assert.ok(existsSync(join(dir, "current.json")), "future data is preserved, not quarantined");
});

test("bare pre-workspace state file is wrapped to a Base-plan workspace on load (migrated, pre-migration snapshot)", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();

  // A pre-workspace file: a bare RunwayState (schemaVersion, no scenarios array).
  const bare = stateWithBalance(1_250_000);
  writeFileSync(join(dir, "current.json"), JSON.stringify(bare));

  const before = store.rev();
  const result = store.load();
  assert.equal(result.seeded, true);
  assert.equal(result.migrated, true, "wrapping a bare state is a migration");
  assert.equal(result.rev, before + 1, "the wrap rewrite bumps the rev");
  assert.equal(activeState(result.workspace).accounts[0].balance, 1_250_000);
  assert.equal(result.workspace.scenarios.length, 1);
  assert.equal(result.workspace.scenarios[0].name, "Base plan");

  // current.json is rewritten as a workspace…
  const onDisk = JSON.parse(readFileSync(join(dir, "current.json"), "utf8"));
  assert.equal(onDisk.workspaceVersion, WORKSPACE_VERSION);
  assert.ok(Array.isArray(onDisk.scenarios));
  assert.equal(activeStateOnDisk(dir).accounts[0].balance, 1_250_000);

  // …and the pre-migration bytes are preserved as a "migration" snapshot.
  const migSnap = store.listSnapshots().find((s) => s.source === "migration");
  assert.ok(migSnap, "pre-migration snapshot written");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "snapshots", migSnap.file), "utf8")), bare, "snapshot carries the raw pre-workspace bytes");
});

test("an older-version workspace migrates each scenario's state on load", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();

  // A v1-schema state (pre-household, endState {mode, amount}) inside a
  // workspaceVersion-1 envelope with two scenarios. migrateWorkspace must ladder
  // each scenario's state up to the current SCHEMA_VERSION.
  const v1state = (balance) => ({
    schemaVersion: 1,
    profile: { currentAge: 40, endAge: 92, currentYear: 2026 },
    portfolio: { balance, realReturnPct: 4 },
    properties: [],
    incomes: [],
    spending: [],
    social: { startAge: 67, monthly: 0, haircutPct: 25 },
    health: { preMedicareAnnual: 16000, postMedicareAnnual: 7500, employerCoverageUntilAge: 40 },
    endState: { mode: "bequest", amounts: { bequest: 250000, floor: 0 } },
    work: { untilAge: 50 },
  });
  const oldWs = {
    workspaceVersion: WORKSPACE_VERSION,
    activeId: "a",
    scenarios: [
      { id: "a", name: "Plan A", state: v1state(100) },
      { id: "b", name: "Plan B", state: v1state(200) },
    ],
  };
  writeFileSync(join(dir, "current.json"), JSON.stringify(oldWs));

  const result = store.load();
  assert.equal(result.seeded, true);
  assert.equal(result.migrated, true, "an out-of-date scenario state forces a migration rewrite");
  assert.equal(result.workspace.scenarios.length, 2, "scenarios preserved");
  assert.deepEqual(result.workspace.scenarios.map((s) => s.name), ["Plan A", "Plan B"]);
  for (const sc of result.workspace.scenarios) {
    assert.equal(sc.state.schemaVersion, SCHEMA_VERSION, "each scenario migrated to current schema");
    assert.ok(Array.isArray(sc.state.household.people), "v4 household present after ladder");
  }
  assert.equal(result.workspace.scenarios[0].state.accounts[0].balance, 100);
  assert.equal(result.workspace.scenarios[1].state.accounts[0].balance, 200);

  // On-disk is now the migrated workspace, and the pre-migration bytes snapshotted.
  assert.equal(activeStateOnDisk(dir).schemaVersion, SCHEMA_VERSION);
  assert.ok(store.listSnapshots().some((s) => s.source === "migration"), "pre-migration snapshot written");
});

test("manifest rev/schemaVersion are advisory — the file's own schemaVersion governs", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();
  store.save(wsWith(999));
  store.close();

  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ ...manifest, rev: 999, schemaVersion: 99 })
  );
  const { store: store2 } = makeStore(dir);
  store2.init();
  const result = store2.load(); // no FutureVersionError from the manifest's 99
  assert.equal(result.seeded, true);
  assert.equal(result.migrated, false, "already-current workspace is not re-migrated on load");
  assert.equal(activeState(result.workspace).accounts[0].balance, 999);
  assert.equal(store2.rev(), 999, "rev restored from manifest");
  assert.equal(store2.identity(), manifest.identity, "identity survives");
});

test("lockfile: second init on the same dir throws LockHeldError naming the pid", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();
  const { store: store2 } = makeStore(dir);
  assert.throws(() => store2.init(), LockHeldError);
  try {
    store2.init();
  } catch (e) {
    assert.match(e.message, new RegExp(`pid ${process.pid}`));
  }
});

test("stale lock with a dead pid is cleared", () => {
  const dir = makeDir();
  writeFileSync(join(dir, "runway.lock"), "4194304"); // beyond pid_max — never alive
  const { store } = makeStore(dir);
  store.init(); // must not throw
  assert.equal(readFileSync(join(dir, "runway.lock"), "utf8"), String(process.pid));
});

test("torn trends tail is repaired on append; readTrends skips garbled lines", () => {
  const dir = makeDir();
  const { store, clockRef } = makeStore(dir);
  store.init();
  store.save(wsWith(10));
  appendFileSync(join(dir, "trends.jsonl"), "garbage line\n");
  appendFileSync(join(dir, "trends.jsonl"), '{"v":2,"partial');

  assert.equal(store.readTrends().length, 1, "torn tail and garbage skipped on read");

  clockRef.t = new Date("2026-07-11T09:00:00.000Z");
  store.save(wsWith(20)); // triggers a trend append → tail repair
  const content = readFileSync(join(dir, "trends.jsonl"), "utf8");
  assert.ok(content.endsWith("\n"));
  assert.ok(!content.includes('"partial'), "torn tail truncated away");
  const rows = store.readTrends();
  assert.equal(rows.length, 2, "two complete rows survive (garbage line skipped)");
  assert.deepEqual(rows.map((r) => r.date), ["2026-07-10", "2026-07-11"]);
});

test("ordering invariant: crash after current-commit leaves no phantom trend row", () => {
  const dir = makeDir();
  const { store, clockRef, opts } = makeStore(dir);
  store.init();
  store.save(wsWith(1)); // day 1: snapshot + trend

  clockRef.t = new Date("2026-07-11T09:00:00.000Z"); // a new day WOULD snapshot+trend
  opts._failAfter = "current-write";
  assert.throws(() => store.save(wsWith(2)), /injected failure/);
  assert.equal(activeStateOnDisk(dir).accounts[0].balance, 2, "current committed");
  assert.equal(trendLines(dir).length, 1, "no phantom trend row");
  assert.equal(snapFiles(dir).length, 1, "no snapshot either");
  assert.equal(store.rev(), 1, "rev bump never happened");

  opts._failAfter = null;
  store.save(wsWith(3)); // recovery: next save picks the day back up
  assert.equal(trendLines(dir).length, 2);
  assert.equal(snapFiles(dir).length, 2);
});

test("temp-write failure: save throws, prior current.json intact and parseable", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();
  store.save(wsWith(777));
  chmodSync(dir, 0o555);
  try {
    assert.throws(() => store.save(wsWith(888)));
  } finally {
    chmodSync(dir, 0o755);
  }
  assert.equal(activeStateOnDisk(dir).accounts[0].balance, 777);
});

test("save rejects invalid state with ValidationError carrying issues", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();
  const bad = placeholderState();
  bad.spending[0].monthly = /** @type {any} */ ("abc");
  const badWs = makeWorkspace({ id: "s1", state: bad });
  assert.throws(() => store.save(badWs), ValidationError);
  try {
    store.save(badWs);
  } catch (e) {
    // validateWorkspace path-prefixes each scenario's state errors.
    assert.ok(e.issues.some((i) => i.path === "scenarios[0].state.spending[0].monthly"));
  }
  assert.ok(!existsSync(join(dir, "current.json")), "nothing written for a rejected state");
});

test("appendShutdownTrend appends only when rev moved since the last trend row", () => {
  const dir = makeDir();
  const { store } = makeStore(dir);
  store.init();
  store.save(wsWith(100)); // trend row at rev 1
  store.appendShutdownTrend();
  assert.equal(trendLines(dir).length, 1, "no-op when rev unchanged since last row");

  store.save(wsWith(200)); // rev 2, same day → no trend
  store.appendShutdownTrend();
  const lines = trendLines(dir);
  assert.equal(lines.length, 2);
  const last = JSON.parse(lines[1]);
  assert.equal(last.v, 4);
  assert.equal(last.source, "shutdown");
  assert.equal(last.rev, 2);
  assert.equal(last.scenario, "Base plan");
  assert.equal(last.totalBalance, 200);

  store.appendShutdownTrend();
  assert.equal(trendLines(dir).length, 2, "idempotent once caught up");
});
