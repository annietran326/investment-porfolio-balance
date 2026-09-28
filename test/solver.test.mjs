import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate } from "../src/engine/simulate.mjs";
import { requiredSavings, goalMet, GAP_CAP, GAP_ROUND_TO } from "../src/engine/solver.mjs";
import {
  SCENARIOS,
  STRESS_VACANCY_MONTHS,
  STRESS_VACANCY_YEARS,
  STRESS_REPAIR_COST,
  STRESS_SALE_DELAY_YEARS,
  DRAWDOWN_PCT,
  SPEND_SHOCK_MULT,
} from "../src/engine/scenarios.mjs";
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
  s.properties = [];
  return s;
};
const hopeless = () => {
  const s = lean();
  withBalance(s, 0);
  s.spending = [{ name: "impossible", monthly: 400_000, fromYear: null, toYear: null, growthPct: null }]; // $4.8M/yr forever
  return s;
};

const gapOf = (res) => (res.kind === "met" ? 0 : res.kind === "value" ? res.amount : Infinity);

test("monotonicity: every stress scenario requires at least the base case", () => {
  const s = lean();
  const base = gapOf(requiredSavings(s, {}));
  for (const sc of SCENARIOS) {
    const req = gapOf(requiredSavings(s, sc.overlay));
    assert.ok(req >= base, `${sc.key} (${req}) should require >= base (${base})`);
  }
});

test("monotonicity with properties kept: a past sale is never resurrected by saleDelayYears", () => {
  // Unlike the lean fixture above (which strips properties), this one KEEPS
  // the placeholder's two properties and adds one already sold BEFORE the
  // window — one year back, so the stress overlay's 2-year saleDelayYears
  // would push it INSIDE the window (phantom rent + proceeds) if unguarded.
  const s = placeholderState();
  withBalance(s, 300_000);
  s.incomes = [];
  s.properties.push({
    name: "Sold before the window",
    rentMonthly: 4000,
    costsMonthly: 500,
    mortgageMonthly: 0,
    payoffYear: null,
    saleYear: s.profile.currentYear - 1,
    saleNetProceeds: 750_000,
  });
  const base = gapOf(requiredSavings(s, {}));
  for (const key of ["stress", "everything"]) {
    const sc = SCENARIOS.find((x) => x.key === key);
    assert.ok(sc);
    const req = gapOf(requiredSavings(s, sc.overlay));
    assert.ok(req >= base, `${key} (${req}) should require >= base (${base})`);
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

test("everything-at-once is composed from the same magnitude constants — no silent softening", () => {
  const everything = SCENARIOS.find((sc) => sc.key === "everything");
  assert.ok(everything);
  assert.deepEqual(everything.overlay, {
    vacancyMonths: STRESS_VACANCY_MONTHS,
    vacancyYears: STRESS_VACANCY_YEARS,
    oneTimeCost: STRESS_REPAIR_COST,
    oneTimeCostYearIdx: 0,
    saleDelayYears: STRESS_SALE_DELAY_YEARS,
    drawdownPct: DRAWDOWN_PCT,
    spendMult: SPEND_SHOCK_MULT,
  });
  const stress = SCENARIOS.find((sc) => sc.key === "stress");
  assert.equal(stress?.overlay.oneTimeCost, STRESS_REPAIR_COST);
  const spend = SCENARIOS.find((sc) => sc.key === "spend");
  assert.equal(spend?.overlay.spendMult, SPEND_SHOCK_MULT);
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
  s.taxes = { ordinaryIncomePct: 30, capitalGainsPct: 25 };
  let prev = -Infinity;
  for (let x = 0; x <= 3_000_000; x += 50_000) {
    const end = simulate(s, {}, x).endBal;
    assert.ok(end >= prev - 1e-6, `endBal dropped as savings rose (at ${x})`);
    prev = end;
  }
});

test("gap monotonicity: every stress scenario needs at least the base gap; bigger safe buckets cost more", () => {
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
  hiTax.taxes = { ordinaryIncomePct: 40, capitalGainsPct: 30 };
  hiTax.accounts = [newAccount({ name: "Brk", type: "taxable", balance: 300_000, costBasis: 100_000 })];
  const loTax = structuredClone(hiTax);
  loTax.taxes = { ordinaryIncomePct: 10, capitalGainsPct: 5 };
  assert.ok(gapOf(requiredSavings(hiTax)) >= gapOf(requiredSavings(loTax)));
});
