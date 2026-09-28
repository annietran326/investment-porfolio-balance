// The scenarios every plan is run under: the base case and a spending shock.
// Each is run through the Monte Carlo simulation.

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
  { key: "spend", label: "Spending +20% forever", overlay: { spendMult: SPEND_SHOCK_MULT } },
];
