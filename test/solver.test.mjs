import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate } from "../src/engine/simulate.mjs";
import { requiredSavings, goalMet, GAP_CAP, GAP_ROUND_TO } from "../src/engine/solver.mjs";
import { SCENARIOS, scenarioLabel } from "../src/engine/scenarios.mjs";
import { placeholderState } from "../src/model/placeholder.mjs";
import { newAccount } from "../src/model/schema.mjs";

/** Replace a plan's accounts with one taxable account holding `balance` (basis = balance). */
function withBalance(s, balance) {
  s.accounts = [newAccount({ name: "Brokerage", type: "taxable", balance })];
  return s;
}

const rich = () => {
  const s = placeholderState();
  withBalance(s, 20_000_000);
  return s;
};
const lean = () => {
  const s = placeholderState();
  withBalance(s, 300_000);
  s.incomes = [];
  return s;
};
const hopeless = () => {
  const s = lean();
  withBalance(s, 0);
  s.spending = [{ name: "impossible", monthly: 400_000, fromYear: null, toYear: null, growthPct: null, variable: true }]; // $4.8M/yr forever
  return s;
};

const gapOf = (res) => (res.kind === "met" ? 0 : res.kind === "value" ? res.amount : Infinity);

test("monotonicity: the spend more scenario needs at least the base case's gap", () => {
  const s = lean();
  const base = gapOf(requiredSavings(s, {}));
  for (const sc of SCENARIOS) {
    const req = gapOf(requiredSavings(s, sc.overlay));
    assert.ok(req >= base, `${sc.key} (${req}) should require >= base (${base})`);
  }
});

test("monotonicity: bequest and floor require at least die-with-zero", () => {
  const s = lean();
  const zero = gapOf(requiredSavings(s));

  const bequest = lean();
  bequest.endState = { mode: "bequest", amounts: { bequest: 1_000_000, floor: 0 } };
  assert.ok(gapOf(requiredSavings(bequest)) >= zero);

  const floor = lean();
  floor.endState = { mode: "floor", amounts: { bequest: 0, floor: 200_000 } };
  assert.ok(gapOf(requiredSavings(floor)) >= zero);
});

test("goalMet picks the amount for the ACTIVE mode only", () => {
  const s = lean();
  withBalance(s, 5_000_000);
  s.endState = { mode: "zero", amounts: { bequest: 50_000_000, floor: 0 } };
  // huge bequest amount is ignored while mode is zero
  assert.ok(goalMet(s, simulate(s)));
});

test("the scenarios are the base case and the spend more scenario", () => {
  assert.deepEqual(SCENARIOS.map((sc) => sc.key), ["base", "spend"]);
  assert.deepEqual(SCENARIOS[1].overlay, { spendMore: true });
  const s = placeholderState();
  s.simulation.spendMorePct = 30;
  assert.equal(scenarioLabel(SCENARIOS[1], s), "Spend more scenario (+30% variable spending)");
});

test("scenario keys are unique and base is first", () => {
  const keys = SCENARIOS.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys[0], "base");
});

// ---- the gap solver (requiredSavings) ----

test("gap: three-way contract, rounded, and tight at the boundary", () => {
  assert.deepEqual(requiredSavings(rich()), { kind: "met" });

  const s = lean();
  const res = requiredSavings(s);
  assert.equal(res.kind, "value");
  if (res.kind === "value") {
    assert.ok(res.amount > 0);
    assert.equal(res.amount % GAP_ROUND_TO, 0, "rounds up to $1,000");
    assert.ok(goalMet(s, simulate(s, {}, res.amount)), "the gap closes the plan");
    assert.ok(!goalMet(s, simulate(s, {}, res.amount - 2000)), "and $2,000 less does not");
  }
  assert.deepEqual(requiredSavings(hopeless()), { kind: "unreachable", cap: GAP_CAP });
});

test("gap: adding exactly the gap to the accounts makes the plan 'met'", () => {
  const s = lean();
  const res = requiredSavings(s);
  assert.equal(res.kind, "value");
  if (res.kind !== "value") return;
  const funded = structuredClone(s);
  funded.accounts.push(newAccount({ name: "The gap", type: "taxable", balance: res.amount }));
  assert.deepEqual(requiredSavings(funded), { kind: "met" });
});

test("gap solver precondition: end balance never falls as savings today rise (incl. taxes and the split)", () => {
  const s = lean();
  s.accounts = [newAccount({ name: "IRA", type: "traditional_ira", balance: 150_000 }), newAccount({ name: "Brk", type: "taxable", balance: 150_000, costBasis: 20_000 })];
  s.taxes = { ...s.taxes, workingOrdinaryIncomePct: 30, workingCapitalGainsPct: 25, ordinaryIncomePct: 30, capitalGainsPct: 25 };
  let prev = -Infinity;
  for (let x = 0; x <= 3_000_000; x += 50_000) {
    const end = simulate(s, {}, x).endBal;
    assert.ok(end >= prev - 1e-6, `endBal dropped as savings rose (at ${x})`);
    prev = end;
  }
});

test("gap monotonicity: spending more needs at least the base gap; bigger safe buckets cost more", () => {
  const s = lean();
  const base = gapOf(requiredSavings(s));
  for (const sc of SCENARIOS) {
    assert.ok(gapOf(requiredSavings(s, sc.overlay)) >= base, `${sc.key} gap >= base`);
  }
  // Holding more years in 0%-real capital preservation lowers expected returns,
  // so with no crashes in the simple model it can only raise the gap.
  const cautious = lean();
  cautious.buckets = { ...cautious.buckets, preservationYears: 12, incomeThroughYear: 20 };
  const bold = lean();
  bold.buckets = { ...bold.buckets, preservationYears: 2, incomeThroughYear: 10 };
  assert.ok(gapOf(requiredSavings(cautious)) >= gapOf(requiredSavings(s)));
  assert.ok(gapOf(requiredSavings(s)) >= gapOf(requiredSavings(bold)));
});

test("higher taxes never shrink the gap; a traditional IRA needs more than the same money in a Roth", () => {
  const roth = lean();
  roth.accounts = [newAccount({ name: "Roth", type: "roth_ira", balance: 300_000 })];
  const trad = lean();
  trad.accounts = [newAccount({ name: "IRA", type: "traditional_ira", balance: 300_000 })];
  assert.ok(gapOf(requiredSavings(trad)) > gapOf(requiredSavings(roth)), "ordinary tax (and the early penalty) cost real money");
  const hiTax = lean();
  hiTax.taxes = { ...hiTax.taxes, workingOrdinaryIncomePct: 40, workingCapitalGainsPct: 30, ordinaryIncomePct: 40, capitalGainsPct: 30 };
  hiTax.accounts = [newAccount({ name: "Brk", type: "taxable", balance: 300_000, costBasis: 100_000 })];
  const loTax = structuredClone(hiTax);
  loTax.taxes = { ...loTax.taxes, workingOrdinaryIncomePct: 10, workingCapitalGainsPct: 5, ordinaryIncomePct: 10, capitalGainsPct: 5 };
  assert.ok(gapOf(requiredSavings(hiTax)) >= gapOf(requiredSavings(loTax)));
});
