// Pure-logic tests for the scenario-switcher UI helpers (public/ui/scenarios.mjs).
// No DOM: the module must load under plain Node (no DOM globals at module top
// level), which importing it here enforces. These cover the bar view-model, the
// create-payload builder, and name validation/trim — the load-bearing pure bits
// the DOM controller sits on top of.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCENARIO_NAME_MAX,
  normalizeScenarioName,
  validateRename,
  barModel,
  createPayload,
} from "../public/ui/scenarios.mjs";

// ---------------------------------------------------------------------------
// name normalization — mirrors the server's trim + 80-char cap
// ---------------------------------------------------------------------------

test("normalizeScenarioName: trims, caps at 80, blanks non-strings", () => {
  assert.equal(normalizeScenarioName("  Aggressive  "), "Aggressive");
  assert.equal(normalizeScenarioName(""), "");
  assert.equal(normalizeScenarioName("   "), "");
  assert.equal(normalizeScenarioName(null), "");
  assert.equal(normalizeScenarioName(undefined), "");
  assert.equal(normalizeScenarioName(42), "");
  const long = "x".repeat(200);
  assert.equal(normalizeScenarioName(long).length, SCENARIO_NAME_MAX);
});

test("validateRename: only fires on a non-empty, actually-changed name", () => {
  assert.deepEqual(validateRename("Base plan", "Aggressive"), { ok: true, name: "Aggressive" });
  assert.deepEqual(validateRename("Base plan", "  Aggressive "), { ok: true, name: "Aggressive" });
  assert.deepEqual(validateRename("Base plan", "Base plan"), { ok: false }, "unchanged → no-op");
  assert.deepEqual(validateRename("Base plan", "  Base plan  "), { ok: false }, "unchanged after trim → no-op");
  assert.deepEqual(validateRename("Base plan", ""), { ok: false }, "blank → no-op");
  assert.deepEqual(validateRename("Base plan", "   "), { ok: false }, "whitespace → no-op");
  assert.deepEqual(validateRename("Base plan", null), { ok: false });
});

// ---------------------------------------------------------------------------
// bar view-model — pills, active flag, management gating
// ---------------------------------------------------------------------------

test("barModel: marks the active pill and preserves order", () => {
  const m = barModel({
    scenarios: [
      { id: "a", name: "Base plan" },
      { id: "b", name: "Aggressive" },
      { id: "c", name: "Lean FIRE" },
    ],
    activeId: "b",
  });
  assert.deepEqual(
    m.pills.map((p) => [p.id, p.name, p.active]),
    [
      ["a", "Base plan", false],
      ["b", "Aggressive", true],
      ["c", "Lean FIRE", false],
    ]
  );
});

test("barModel: seeded + multiple → create, manage, and delete all enabled", () => {
  const m = barModel({
    scenarios: [
      { id: "a", name: "Base plan" },
      { id: "b", name: "Aggressive" },
    ],
    activeId: "a",
    seeded: true,
  });
  assert.equal(m.canCreate, true);
  assert.equal(m.canManage, true);
  assert.equal(m.canDelete, true);
});

test("barModel: seeded but only one scenario → no delete (API refuses the last)", () => {
  const m = barModel({ scenarios: [{ id: "a", name: "Base plan" }], activeId: "a", seeded: true });
  assert.equal(m.canCreate, true);
  assert.equal(m.canManage, true);
  assert.equal(m.canDelete, false, "the last scenario can never be deleted");
});

test("barModel: unseeded → create still offered (it seeds), but no rename/delete", () => {
  const m = barModel({ scenarios: [{ id: "local", name: "Base plan" }], activeId: "local", seeded: false });
  assert.equal(m.canCreate, true, "create seeds on the server — still offered");
  assert.equal(m.canManage, false, "rename needs a real seeded workspace");
  assert.equal(m.canDelete, false);
  assert.equal(m.pills.length, 1);
  assert.equal(m.pills[0].active, true);
});

test("barModel: tolerates missing scenarios/activeId (defensive on a sparse boot)", () => {
  const m = barModel({ scenarios: undefined, activeId: undefined });
  assert.deepEqual(m.pills, []);
  assert.equal(m.canDelete, false);
});

// ---------------------------------------------------------------------------
// create-payload builder
// ---------------------------------------------------------------------------

test("createPayload copy: includes fromId and the mode", () => {
  const p = createPayload({ mode: "copy", name: "Copy of current", fromId: "abc", baseRev: 7 });
  assert.deepEqual(p, { name: "Copy of current", mode: "copy", baseRev: 7, fromId: "abc" });
});

test("createPayload copy without fromId: omits fromId (server falls back to active)", () => {
  const p = createPayload({ mode: "copy", name: "Dup", baseRev: 3 });
  assert.deepEqual(p, { name: "Dup", mode: "copy", baseRev: 3 });
  assert.ok(!("fromId" in p), "no fromId key when none supplied");
});

test("createPayload scratch: never carries fromId, even if one is passed", () => {
  const p = createPayload({ mode: "scratch", name: "Fresh", fromId: "abc", baseRev: 1 });
  assert.deepEqual(p, { name: "Fresh", mode: "scratch", baseRev: 1 });
});

test("createPayload: blank name falls back to 'Scenario', long name is capped", () => {
  assert.equal(createPayload({ mode: "scratch", name: "   ", baseRev: 0 }).name, "Scenario");
  assert.equal(createPayload({ mode: "scratch", baseRev: 0 }).name, "Scenario");
  assert.equal(createPayload({ mode: "scratch", name: "y".repeat(120), baseRev: 0 }).name.length, SCENARIO_NAME_MAX);
});
