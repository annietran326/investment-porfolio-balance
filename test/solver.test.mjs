import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate } from "../src/engine/simulate.mjs";
import { requiredIncome, goalMet, SOLVER_CAP, ROUND_TO } from "../src/engine/solver.mjs";
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

const rich = () => {
  const s = placeholderState();
  s.portfolio.balance = 20_000_000;
  return s;
};
const lean = () => {
  const s = placeholderState();
  s.portfolio.balance = 300_000;
  s.incomes = [];
  s.properties = [];
  return s;
};
const hopeless = () => {
  const s = lean();
  s.portfolio.balance = 0;
  s.spending = [{ name: "impossible", monthly: 400_000 }]; // $4.8M/yr forever
  s.work.untilAge = s.profile.currentAge + 1; // 2-year window
  return s;
};

test("three-way contract: met / value / unreachable — never anything else", () => {
  assert.deepEqual(requiredIncome(rich()), { kind: "met" });

  const res = requiredIncome(lean());
  assert.equal(res.kind, "value");
  if (res.kind === "value") {
    assert.ok(res.perYear > 0);
    assert.equal(res.perYear % ROUND_TO, 0, "rounds to $500");
    assert.equal(res.untilAge, lean().work.untilAge);
    // boundary tightness: goal met AT the answer, not met $1,000 below it
    const s = lean();
    assert.ok(goalMet(s, simulate(s, {}, res.perYear)));
    assert.ok(!goalMet(s, simulate(s, {}, res.perYear - 1000)));
  }

  const un = requiredIncome(hopeless());
  assert.deepEqual(un, { kind: "unreachable", cap: SOLVER_CAP });
});

const perYearOf = (res) => (res.kind === "met" ? 0 : res.kind === "value" ? res.perYear : Infinity);

test("monotonicity: every stress scenario requires at least the base case", () => {
  const s = lean();
  const base = perYearOf(requiredIncome(s, {}));
  for (const sc of SCENARIOS) {
    const req = perYearOf(requiredIncome(s, sc.overlay));
    assert.ok(req >= base, `${sc.key} (${req}) should require >= base (${base})`);
  }
});

test("monotonicity with properties kept: a past sale is never resurrected by saleDelayYears", () => {
  // Unlike the lean fixture above (which strips properties), this one KEEPS
  // the placeholder's two properties and adds one already sold BEFORE the
  // window — one year back, so the stress overlay's 2-year saleDelayYears
  // would push it INSIDE the window (phantom rent + proceeds) if unguarded.
  const s = placeholderState();
  s.portfolio.balance = 300_000;
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
  const base = perYearOf(requiredIncome(s, {}));
  for (const key of ["stress", "everything"]) {
    const sc = SCENARIOS.find((x) => x.key === key);
    assert.ok(sc);
    const req = perYearOf(requiredIncome(s, sc.overlay));
    assert.ok(req >= base, `${key} (${req}) should require >= base (${base})`);
  }
});

test("monotonicity: bequest and floor require at least die-with-zero", () => {
  const s = lean();
  const zero = perYearOf(requiredIncome(s));

  const bequest = lean();
  bequest.endState = { mode: "bequest", amounts: { bequest: 1_000_000, floor: 0 } };
  assert.ok(perYearOf(requiredIncome(bequest)) >= zero);

  const floor = lean();
  floor.endState = { mode: "floor", amounts: { bequest: 0, floor: 200_000 } };
  assert.ok(perYearOf(requiredIncome(floor)) >= zero);
});

test("monotonicity: a longer working window never requires more per year", () => {
  const early = lean();
  early.work.untilAge = 45;
  const late = lean();
  late.work.untilAge = 60;
  assert.ok(perYearOf(requiredIncome(late)) <= perYearOf(requiredIncome(early)));
});

test("goalMet picks the amount for the ACTIVE mode only", () => {
  const s = lean();
  s.portfolio.balance = 5_000_000;
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

// ---- v5: tax flows through the solver + scenarios (no solver.mjs change) ----

const taxOn = { enabled: true, effectiveGainsRatePct: 20, embeddedGainPct: 50 };

test("solver precondition holds with tax on: end balance is monotone non-decreasing in extra income", () => {
  const s = lean();
  s.tax = { ...taxOn };
  let prev = -Infinity;
  for (let inc = 0; inc <= 400_000; inc += 20_000) {
    const end = simulate(s, {}, inc).endBal;
    assert.ok(end >= prev - 1e-6, `endBal must not decrease as income rises (at ${inc})`);
    prev = end;
  }
});

test("enabling tax never lowers required income, and genuinely bites on a drawdown plan", () => {
  const off = requiredIncome(lean());
  const on = lean();
  on.tax = { ...taxOn };
  const onRes = requiredIncome(on);
  assert.equal(off.kind, "value");
  assert.equal(onRes.kind, "value");
  assert.ok(perYearOf(onRes) >= perYearOf(off), "tax on requires >= tax off");
  // Strict, rounding-proof check: the tax-OFF answer no longer meets the goal
  // once tax is on — so more income is genuinely needed.
  assert.ok(!goalMet(on, simulate(on, {}, perYearOf(off))), "tax-off income falls short once tax is on");
});

test("three-way contract survives with tax enabled — met / value / unreachable, never blank", () => {
  const withTax = (mk) => {
    const s = mk();
    s.tax = { ...taxOn };
    return s;
  };
  assert.equal(requiredIncome(withTax(rich)).kind, "met");
  assert.equal(requiredIncome(withTax(lean)).kind, "value");
  assert.deepEqual(requiredIncome(withTax(hopeless)), { kind: "unreachable", cap: SOLVER_CAP });
});

test("stress scenario × tax: spending +20% with tax on requires at least the same scenario with tax off", () => {
  const off = lean();
  const on = lean();
  on.tax = { ...taxOn };
  const spend = SCENARIOS.find((x) => x.key === "spend");
  assert.ok(spend);
  assert.ok(perYearOf(requiredIncome(on, spend.overlay)) >= perYearOf(requiredIncome(off, spend.overlay)));
});

test("regression: capped tax keeps end balance monotone across a balance zero-crossing (fine sweep)", () => {
  // A 2-year plan where year 1 is a pure drawdown whose starting balance IS
  // year 0's end balance — which crosses zero as extra income rises. An uncapped
  // all-or-nothing withdrawal tax jumps endBal DOWN at that crossing (more income
  // → lower endBal), breaking bisection. The capped tax is continuous, so a fine
  // $1,000 sweep must never see endBal drop as income rises.
  const s = placeholderState();
  s.profile = { currentAge: 40, endAge: 42, currentYear: 2026 };
  s.portfolio = { balance: 120_000, realReturnPct: 0 };
  s.properties = [];
  s.incomes = [];
  s.spending = [{ name: "spend", monthly: 10_000, fromYear: null, toYear: null, realGrowthPct: 0 }];
  s.social = { startAge: 67, monthly: 0, haircutPct: 25 };
  s.health = { preMedicareAnnual: 0, postMedicareAnnual: 0, employerCoverageUntilAge: 40 };
  s.household = { people: [] };
  s.work = { untilAge: 40 }; // solver income applies to year 0 only
  s.tax = { enabled: true, effectiveGainsRatePct: 40, embeddedGainPct: 100 }; // sharp g·r = 0.4
  let prev = -Infinity;
  for (let inc = 0; inc <= 240_000; inc += 1000) {
    const end = simulate(s, {}, inc).endBal;
    assert.ok(end >= prev - 1e-6, `endBal dropped as income rose (at income ${inc})`);
    prev = end;
  }
});
