// The scenarios every plan is run under: the base case and the "spend more"
// scenario (variable spending lines rise by the percent you set in the
// Spending section). Each is run through the Monte Carlo simulation.

/**
 * @typedef {Object} NamedScenario
 * @property {string} key
 * @property {string} label
 * @property {import("./simulate.mjs").ScenarioOverlay} overlay
 */

/** @type {NamedScenario[]} */
export const SCENARIOS = [
  { key: "base", label: "Base case", overlay: {} },
  { key: "spend", label: "Spend more scenario", overlay: { spendMore: true } },
];

/**
 * The label a scenario shows for a given plan (the spend-more percent is an input).
 * @param {NamedScenario} sc @param {import("../model/schema.mjs").RunwayState} s
 */
export function scenarioLabel(sc, s) {
  return sc.key === "spend" ? `Spend more scenario (+${s.simulation.spendMorePct}% variable spending)` : sc.label;
}
