// The required-income solver — the inversion that is this app's reason to
// exist. Given a state and a scenario, find the minimum net annual income
// (earned from now through work.untilAge) that lands the plan on its chosen
// end state. Bisection: end balance is monotone in extra income, so the
// search is sound.
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
