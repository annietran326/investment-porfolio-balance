// Named stress scenarios. Fixed constants in v1 (user-editable parameters are
// deferred by the plan). The everything-at-once case is COMPOSED from the same
// magnitude constants as the standalone scenarios — the v0 prototype silently
// softened its combined spending shock to 1.1×, which tests now forbid.

export const STRESS_VACANCY_MONTHS = 4;
export const STRESS_VACANCY_YEARS = 2;
export const STRESS_REPAIR_COST = 50_000;
export const STRESS_SALE_DELAY_YEARS = 2;
export const DRAWDOWN_PCT = 30;
export const SPEND_SHOCK_MULT = 1.2;

/**
 * @typedef {Object} NamedScenario
 * @property {string} key
 * @property {string} label
 * @property {import("./simulate.mjs").ScenarioOverlay} overlay
 */

/** @type {NamedScenario[]} */
export const SCENARIOS = [
  { key: "base", label: "Base case", overlay: {} },
  {
    key: "stress",
    label: "Stress: vacancy + repair + delayed sales",
    overlay: {
      vacancyMonths: STRESS_VACANCY_MONTHS,
      vacancyYears: STRESS_VACANCY_YEARS,
      oneTimeCost: STRESS_REPAIR_COST,
      oneTimeCostYearIdx: 0,
      saleDelayYears: STRESS_SALE_DELAY_YEARS,
    },
  },
  { key: "drawdown", label: `Market −${DRAWDOWN_PCT}% now`, overlay: { drawdownPct: DRAWDOWN_PCT } },
  { key: "spend", label: "Spending +20% forever", overlay: { spendMult: SPEND_SHOCK_MULT } },
  {
    key: "everything",
    label: "Everything at once",
    overlay: {
      vacancyMonths: STRESS_VACANCY_MONTHS,
      vacancyYears: STRESS_VACANCY_YEARS,
      oneTimeCost: STRESS_REPAIR_COST,
      oneTimeCostYearIdx: 0,
      saleDelayYears: STRESS_SALE_DELAY_YEARS,
      drawdownPct: DRAWDOWN_PCT,
      spendMult: SPEND_SHOCK_MULT,
    },
  },
];
