// Pure-model tests for the workspace layer: migration (wrap a bare state, pass a
// workspace through while laddering each scenario's state, repair a dangling
// activeId, refuse garbage / future versions), structural validation, and the
// CRUD helpers (immutability, active reassignment, last-scenario refusal). No
// clock, no I/O — ids are injected via makeId exactly as the store injects them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeholderState } from "../src/model/placeholder.mjs";
import { SCHEMA_VERSION } from "../src/model/schema.mjs";
import { MissingVersionError, FutureVersionError } from "../src/model/migrate.mjs";
import {
  WORKSPACE_VERSION,
  activeScenario,
  activeState,
  addScenario,
  deleteScenario,
  makeWorkspace,
  migrateWorkspace,
  renameScenario,
  scenarioList,
  setActive,
  validateWorkspace,
  withActiveState,
} from "../src/model/workspace.mjs";

const st = () => placeholderState();

// A deterministic id generator, injected exactly as the store injects makeId.
function idGen() {
  let n = 0;
  return () => `id-${n++}`;
}

// A minimal v1-schema state (pre-household, endState with amounts): enough to
// exercise the migration ladder up to the current SCHEMA_VERSION.
function v1State(balance = 5) {
  return {
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
  };
}

// --- makeWorkspace ----------------------------------------------------------

test("makeWorkspace: single scenario, active, default name Base plan", () => {
  const ws = makeWorkspace({ id: "s1", state: st() });
  assert.equal(ws.workspaceVersion, WORKSPACE_VERSION);
  assert.equal(ws.activeId, "s1");
  assert.equal(ws.scenarios.length, 1);
  assert.equal(ws.scenarios[0].id, "s1");
  assert.equal(ws.scenarios[0].name, "Base plan");
  assert.equal(ws.scenarios[0].state.portfolio.balance, st().portfolio.balance);
  assert.equal(validateWorkspace(ws).errors.length, 0, "a fresh workspace is valid");

  const named = makeWorkspace({ id: "x", name: "Aggressive", state: st() });
  assert.equal(named.scenarios[0].name, "Aggressive", "name is overridable");
});

// --- migrateWorkspace: bare state → wrapped ---------------------------------

test("migrateWorkspace wraps a bare (pre-workspace) state as the sole Base plan (wrapped:true)", () => {
  const bare = st();
  bare.portfolio.balance = 1_250_000;
  const makeId = idGen();
  const { workspace, wrapped } = migrateWorkspace(bare, { makeId });

  assert.equal(wrapped, true, "a bare state is a wrap");
  assert.equal(workspace.workspaceVersion, WORKSPACE_VERSION);
  assert.equal(workspace.scenarios.length, 1);
  assert.equal(workspace.scenarios[0].name, "Base plan");
  assert.equal(workspace.scenarios[0].id, "id-0", "the wrapped scenario gets a fresh injected id");
  assert.equal(workspace.activeId, "id-0", "the wrapped scenario is active");
  assert.equal(activeState(workspace).portfolio.balance, 1_250_000, "state carried through");
  assert.equal(activeState(workspace).schemaVersion, SCHEMA_VERSION);
});

test("migrateWorkspace ladders a bare OLD-version state up to the current schema when wrapping", () => {
  const { workspace, wrapped } = migrateWorkspace(v1State(9), { makeId: idGen() });
  assert.equal(wrapped, true);
  assert.equal(activeState(workspace).schemaVersion, SCHEMA_VERSION, "wrapped state laddered to current");
  assert.ok(Array.isArray(activeState(workspace).household.people), "v4 household present after ladder");
  assert.equal(activeState(workspace).portfolio.balance, 9);
});

// --- migrateWorkspace: workspace passthrough --------------------------------

test("migrateWorkspace passes a workspace through, migrating each scenario's state (wrapped:false)", () => {
  const ws = {
    workspaceVersion: WORKSPACE_VERSION,
    activeId: "a",
    scenarios: [
      { id: "a", name: "Plan A", state: v1State(100) },
      { id: "b", name: "Plan B", state: v1State(200) },
    ],
  };
  const { workspace, wrapped } = migrateWorkspace(ws, { makeId: idGen() });

  assert.equal(wrapped, false, "an existing workspace is not a wrap");
  assert.equal(workspace.workspaceVersion, WORKSPACE_VERSION);
  assert.equal(workspace.activeId, "a", "active preserved");
  assert.deepEqual(workspace.scenarios.map((s) => s.name), ["Plan A", "Plan B"]);
  for (const sc of workspace.scenarios) {
    assert.equal(sc.state.schemaVersion, SCHEMA_VERSION, "each scenario migrated");
    assert.ok(Array.isArray(sc.state.household.people), "each scenario has v4 household");
  }
  assert.equal(workspace.scenarios[0].state.portfolio.balance, 100);
  assert.equal(workspace.scenarios[1].state.portfolio.balance, 200);
});

test("migrateWorkspace repairs a dangling activeId to the first scenario", () => {
  const ws = {
    workspaceVersion: WORKSPACE_VERSION,
    activeId: "ghost",
    scenarios: [
      { id: "a", name: "A", state: st() },
      { id: "b", name: "B", state: st() },
    ],
  };
  const { workspace } = migrateWorkspace(ws, { makeId: idGen() });
  assert.equal(workspace.activeId, "a", "dangling activeId falls back to the first scenario");
});

// --- migrateWorkspace: corruption / version refusal -------------------------

test("migrateWorkspace throws MissingVersionError on garbage (no scenarios, no schemaVersion)", () => {
  assert.throws(() => migrateWorkspace({ foo: 1, bar: 2 }, { makeId: idGen() }), MissingVersionError);
});

test("migrateWorkspace throws MissingVersionError on a scenarios array without a workspaceVersion", () => {
  // Looks like a workspace (has scenarios) but carries no valid workspaceVersion.
  assert.throws(
    () => migrateWorkspace({ scenarios: [{ id: "a", name: "A", state: st() }] }, { makeId: idGen() }),
    MissingVersionError
  );
  // A non-integer / <1 workspaceVersion is equally missing.
  assert.throws(
    () => migrateWorkspace({ workspaceVersion: 0, activeId: "a", scenarios: [] }, { makeId: idGen() }),
    MissingVersionError
  );
});

test("migrateWorkspace throws FutureVersionError on a future workspaceVersion", () => {
  const ws = {
    workspaceVersion: WORKSPACE_VERSION + 1,
    activeId: "a",
    scenarios: [{ id: "a", name: "A", state: st() }],
  };
  assert.throws(() => migrateWorkspace(ws, { makeId: idGen() }), FutureVersionError);
});

test("migrateWorkspace propagates a FutureVersionError from a future scenario STATE schemaVersion", () => {
  const future = { ...st(), schemaVersion: SCHEMA_VERSION + 1 };
  const ws = {
    workspaceVersion: WORKSPACE_VERSION,
    activeId: "a",
    scenarios: [{ id: "a", name: "A", state: future }],
  };
  assert.throws(() => migrateWorkspace(ws, { makeId: idGen() }), FutureVersionError);
});

// --- validateWorkspace ------------------------------------------------------

test("validateWorkspace flags a non-object workspace", () => {
  assert.ok(validateWorkspace(/** @type {any} */ (null)).errors.some((e) => e.path === ""));
});

test("validateWorkspace flags a wrong workspaceVersion", () => {
  const ws = { ...makeWorkspace({ id: "s1", state: st() }), workspaceVersion: 99 };
  assert.ok(validateWorkspace(ws).errors.some((e) => e.path === "workspaceVersion"));
});

test("validateWorkspace flags empty scenarios", () => {
  const errs = validateWorkspace({ workspaceVersion: WORKSPACE_VERSION, activeId: "x", scenarios: [] }).errors;
  assert.ok(errs.some((e) => e.path === "scenarios"));
});

test("validateWorkspace flags duplicate scenario ids", () => {
  const errs = validateWorkspace({
    workspaceVersion: WORKSPACE_VERSION,
    activeId: "a",
    scenarios: [
      { id: "a", name: "A", state: st() },
      { id: "a", name: "B", state: st() },
    ],
  }).errors;
  assert.ok(errs.some((e) => e.path === "scenarios[1].id" && /duplicate/.test(e.message)));
});

test("validateWorkspace flags a blank scenario name", () => {
  const errs = validateWorkspace({
    workspaceVersion: WORKSPACE_VERSION,
    activeId: "a",
    scenarios: [{ id: "a", name: "   ", state: st() }],
  }).errors;
  assert.ok(errs.some((e) => e.path === "scenarios[0].name"));
});

test("validateWorkspace flags an activeId that references no scenario", () => {
  const errs = validateWorkspace({
    workspaceVersion: WORKSPACE_VERSION,
    activeId: "nope",
    scenarios: [{ id: "a", name: "A", state: st() }],
  }).errors;
  assert.ok(errs.some((e) => e.path === "activeId"));
});

test("validateWorkspace path-prefixes an invalid scenario state (scenarios[i].state.…)", () => {
  const bad = st();
  bad.portfolio.balance = /** @type {any} */ ("abc");
  const errs = validateWorkspace({
    workspaceVersion: WORKSPACE_VERSION,
    activeId: "a",
    scenarios: [{ id: "a", name: "A", state: bad }],
  }).errors;
  assert.ok(errs.some((e) => e.path === "scenarios[0].state.portfolio.balance"));
});

test("validateWorkspace passes a clean multi-scenario workspace", () => {
  const ws = addScenario(makeWorkspace({ id: "a", state: st() }), { id: "b", name: "Alt", state: st() });
  assert.equal(validateWorkspace(ws).errors.length, 0);
});

// --- accessors: activeScenario / activeState / scenarioList -----------------

test("activeScenario / activeState resolve the active pointer; scenarioList is the id+name projection", () => {
  const alt = st();
  alt.portfolio.balance = 42;
  const ws = addScenario(makeWorkspace({ id: "a", state: st() }), { id: "b", name: "Alt", state: alt });
  // addScenario makes the new scenario active.
  assert.equal(activeScenario(ws).id, "b");
  assert.equal(activeState(ws).portfolio.balance, 42);
  assert.deepEqual(scenarioList(ws), [
    { id: "a", name: "Base plan" },
    { id: "b", name: "Alt" },
  ]);
});

// --- CRUD helpers: immutability + behavior ----------------------------------

test("addScenario appends, makes the new one active, and does not mutate the input", () => {
  const ws = makeWorkspace({ id: "a", state: st() });
  const next = addScenario(ws, { id: "b", name: "Alt", state: st() });
  assert.notEqual(next, ws, "returns a new object");
  assert.equal(next.activeId, "b", "new scenario becomes active");
  assert.equal(next.scenarios.length, 2);
  assert.equal(ws.scenarios.length, 1, "input untouched");
  assert.equal(ws.activeId, "a", "input activeId untouched");
});

test("withActiveState replaces only the active scenario's state, immutably", () => {
  const ws = addScenario(makeWorkspace({ id: "a", state: st() }), { id: "b", name: "Alt", state: st() });
  const bumped = st();
  bumped.portfolio.balance = 777;
  const next = withActiveState(ws, bumped);
  assert.notEqual(next, ws);
  assert.equal(activeState(next).portfolio.balance, 777, "active state replaced");
  assert.equal(next.scenarios.find((s) => s.id === "a").state.portfolio.balance, st().portfolio.balance, "non-active untouched");
  assert.equal(activeState(ws).portfolio.balance, st().portfolio.balance, "input untouched");
});

test("renameScenario renames by id, immutably, leaving others alone", () => {
  const ws = addScenario(makeWorkspace({ id: "a", state: st() }), { id: "b", name: "Alt", state: st() });
  const next = renameScenario(ws, "b", "Renamed");
  assert.notEqual(next, ws);
  assert.equal(next.scenarios.find((s) => s.id === "b").name, "Renamed");
  assert.equal(next.scenarios.find((s) => s.id === "a").name, "Base plan", "sibling untouched");
  assert.equal(ws.scenarios.find((s) => s.id === "b").name, "Alt", "input untouched");
});

test("setActive moves the pointer immutably; unknown id throws", () => {
  const ws = addScenario(makeWorkspace({ id: "a", state: st() }), { id: "b", name: "Alt", state: st() });
  const next = setActive(ws, "a");
  assert.notEqual(next, ws);
  assert.equal(next.activeId, "a");
  assert.equal(ws.activeId, "b", "input untouched");
  assert.throws(() => setActive(ws, "ghost"), /no such scenario/);
});

test("deleteScenario removes by id, immutably; deleting the active one reassigns to the first remaining", () => {
  // active is "b"; deleting it reassigns active to the first remaining ("a").
  const ws = addScenario(makeWorkspace({ id: "a", state: st() }), { id: "b", name: "Alt", state: st() });
  const afterActive = deleteScenario(ws, "b");
  assert.notEqual(afterActive, ws);
  assert.equal(afterActive.scenarios.length, 1);
  assert.equal(afterActive.activeId, "a", "removed-active reassigns to first remaining");
  assert.equal(ws.scenarios.length, 2, "input untouched");

  // deleting a NON-active scenario leaves the active pointer where it was.
  const three = addScenario(ws, { id: "c", name: "Third", state: st() }); // active "c"
  const afterNonActive = deleteScenario(three, "a");
  assert.equal(afterNonActive.activeId, "c", "removing a non-active scenario keeps the active pointer");
  assert.ok(!afterNonActive.scenarios.some((s) => s.id === "a"));
});

test("deleteScenario refuses the last scenario and rejects an unknown id", () => {
  const solo = makeWorkspace({ id: "only", state: st() });
  assert.throws(() => deleteScenario(solo, "only"), /cannot delete the last scenario/);
  const ws = addScenario(solo, { id: "b", name: "Alt", state: st() });
  assert.throws(() => deleteScenario(ws, "ghost"), /no such scenario/);
});
