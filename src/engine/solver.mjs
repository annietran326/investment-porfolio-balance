// The two solvers. Both invert the simulation by bisection (the end balance
// only ever rises as the variable rises, so the search is sound):
//   - requiredSavings: the GAP. How much more money, invested today, the plan
//     needs to land on its chosen end state. This is the headline answer.
//   - requiredIncome: how much after-tax income, earned from now through
//     work.untilAge, would close the same gap instead.
import { simulate } from "./simulate.mjs";

// Explicit, named, visible. If a plan genuinely needs more than $2M/yr of
// income the answer the user needs is "unreachable", not a bigger number.
export const SOLVER_CAP = 2_000_000;
// Answers round UP to the nearest $500 for legibility ("earn at least $X").
export const ROUND_TO = 500;
// Bisection stops when the bracket is tighter than this; the round-up to $500
// absorbs the residual interval.
const PRECISION = 250;

/**
 * Did this simulation land the end state?
 *   - zero:    never went negative, ended ≥ $0
 *   - bequest: never went negative, ended ≥ the bequest amount
 *   - floor:   never dipped below the floor at any point
 * @param {import("../model/schema.mjs").RunwayState} s
 * @param {import("./simulate.mjs").SimResult} sim
 */
export function goalMet(s, sim) {
  const { mode, amounts } = s.endState;
  if (mode === "floor") return sim.minBal >= amounts.floor;
  const target = mode === "bequest" ? amounts.bequest : 0;
  return sim.firstNegYear === null && sim.endBal >= target;
}

/**
 * Three-way outcome type — the UI renders each distinctly and can never show blank.
 * @typedef {{kind: "met"}
 *   | {kind: "value", perYear: number, untilAge: number}
 *   | {kind: "unreachable", cap: number}} SolverResult
 */

/**
 * @param {import("../model/schema.mjs").RunwayState} s validated state
 * @param {import("./simulate.mjs").ScenarioOverlay} [overlay]
 * @returns {SolverResult}
 */
export function requiredIncome(s, overlay = {}) {
  if (goalMet(s, simulate(s, overlay, 0))) return { kind: "met" };
  if (!goalMet(s, simulate(s, overlay, SOLVER_CAP))) return { kind: "unreachable", cap: SOLVER_CAP };

  let lo = 0;
  let hi = SOLVER_CAP;
  while (hi - lo > PRECISION) {
    const mid = (lo + hi) / 2;
    if (goalMet(s, simulate(s, overlay, mid))) hi = mid;
    else lo = mid;
  }
  return { kind: "value", perYear: Math.ceil(hi / ROUND_TO) * ROUND_TO, untilAge: s.work.untilAge };
}

// The gap solver's ceiling: a plan more than $50M short is "unreachable".
export const GAP_CAP = 50_000_000;
// Gap answers round UP to the nearest $1,000.
export const GAP_ROUND_TO = 1000;
const GAP_PRECISION = 500;

/**
 * Three-way gap outcome.
 * @typedef {{kind: "met"}
 *   | {kind: "value", amount: number}
 *   | {kind: "unreachable", cap: number}} GapResult
 */

/**
 * The gap: the smallest extra amount (today's $), added to the taxable account
 * today and invested in the recommended split, that lands the end state.
 * @param {import("../model/schema.mjs").RunwayState} s validated state
 * @param {import("./simulate.mjs").ScenarioOverlay} [overlay]
 * @returns {GapResult}
 */
export function requiredSavings(s, overlay = {}) {
  if (goalMet(s, simulate(s, overlay, 0, 0))) return { kind: "met" };
  if (!goalMet(s, simulate(s, overlay, 0, GAP_CAP))) return { kind: "unreachable", cap: GAP_CAP };
  let lo = 0;
  let hi = GAP_CAP;
  while (hi - lo > GAP_PRECISION) {
    const mid = (lo + hi) / 2;
    if (goalMet(s, simulate(s, overlay, 0, mid))) hi = mid;
    else lo = mid;
  }
  return { kind: "value", amount: Math.ceil(hi / GAP_ROUND_TO) * GAP_ROUND_TO };
}
