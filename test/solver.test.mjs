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
