// Verdict copy + formatting. Pure — no DOM, no imports — so node:test covers
// every branch headlessly. The three-way verdict can NEVER render blank: each
// SolverResult kind maps to distinct, non-empty copy.

/**
 * @typedef {import("../../src/model/schema.mjs").RunwayState} RunwayState
 */

/**
 * Full dollars: sign (true minus, not hyphen), commas, no cents.
 * @param {number|null|undefined} n
 */
export function fmtMoney(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n < 0 ? "−" : "";
  return `${sign}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
}

/**
 * Compact dollars: $1.5M / $86K / $500, trailing zeros stripped ($2M, not $2.00M).
 * @param {number|null|undefined} n
 */
export function fmtCompact(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n < 0 ? "−" : "";
  const a = Math.abs(n);
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (a >= 1000) return `${sign}$${Math.round(a / 1000)}K`;
  return `${sign}$${Math.round(a)}`;
}

/**
 * "2043 (17 yrs)" — a year plus its distance from the start year.
 * @param {number} year @param {number} startYear
 */
export function yearDelta(year, startYear) {
  const d = year - startYear;
  return `${year} (${d} yr${d === 1 ? "" : "s"})`;
}

/** @param {RunwayState} state one-phrase description of the chosen end state */
export function goalText(state) {
  const { mode, amounts } = state.endState;
  if (mode === "bequest") return `leave ${fmtMoney(amounts.bequest)}`;
  if (mode === "floor") return `never drop below ${fmtMoney(amounts.floor)}`;
  return "die with zero";
}

/**
 * Whole-percent share: 0.3412 -> "34%".
 * @param {number} share 0..1
 */
export function fmtPct(share) {
  if (!Number.isFinite(share)) return "—";
  return `${Math.round(share * 100)}%`;
}

/**
 * The headline answer from the simulated futures: the chance of success
 * against the target, and the gap if it falls short.
 * @param {{successRate: number, gap: import("../../src/engine/solver.mjs").GapResult, end: {p50: number, p90: number}, runs: number}} base
 * @param {RunwayState} state
 * @returns {{tone: "good"|"bad", headline: string, detail: string}}
 */
export function mcVerdictCopy(base, state) {
  const target = state.simulation.targetSuccessPct;
  const pct = fmtPct(base.successRate);
  const runs = base.runs.toLocaleString("en-US");
  if (base.successRate * 100 >= target) {
    return {
      tone: "good",
      headline: `Yes, you have enough: the plan works in ${pct} of ${runs} simulated futures.`,
      detail: `Your target is ${target}%. In the middle future you'd end with ${fmtMoney(base.end.p50)}; 90% of futures end with at least ${fmtMoney(base.end.p90)} (today's dollars).`,
    };
  }
  if (base.gap.kind === "value") {
    return {
      tone: "bad",
      headline: `Not yet: the plan works in ${pct} of ${runs} simulated futures. The gap is ${fmtMoney(base.gap.amount)}.`,
      detail: `That's how much more you'd need invested today, in the recommended split, to reach your ${target}% target (today's dollars).`,
    };
  }
  if (base.gap.kind === "met") {
    // Rounding at the boundary: the solver found no gap even though the rate reads just under target.
    return { tone: "good", headline: `The plan works in ${pct} of ${runs} simulated futures, right at your ${target}% target.`, detail: "" };
  }
  return {
    tone: "bad",
    headline: `The plan works in ${pct} of ${runs} simulated futures, and no realistic amount of savings reaches ${target}%.`,
    detail: `Something in the plan outruns any amount up to ${fmtMoney(base.gap.cap)}. Check spending, the plan-to age, and the goal (${goalText(state)}).`,
  };
}

/**
 * One line on the expected-return plan (every year exactly average), for comparison.
 * @param {{endBal: number, firstBreachYear: number|null, startYear: number}} sim
 * @param {import("../../src/engine/solver.mjs").GapResult} gap
 * @param {RunwayState} state
 */
export function expectedLine(sim, gap, state) {
  const prefix = "If every year earned exactly its expected return: ";
  if (gap.kind === "met") return `${prefix}the plan works, ending with ${fmtMoney(sim.endBal)}.`;
  const age = sim.firstBreachYear === null ? null : sim.firstBreachYear - state.profile.currentYear + state.profile.currentAge;
  const runsOut = age === null ? "the plan falls short of your goal" : `money runs out at age ${age} (${sim.firstBreachYear})`;
  const more = gap.kind === "value" ? `, and ${fmtMoney(gap.amount)} more today would fix that.` : ".";
  return `${prefix}${runsOut}${more}`;
}

/**
 * Gap table/KPI cell: never blank, color class per kind.
 * @param {import("../../src/engine/solver.mjs").GapResult} gap
 * @returns {{text: string, cls: "pos"|"warn"|"neg"}}
 */
export function gapCell(gap) {
  if (gap.kind === "met") return { text: "none", cls: "pos" };
  if (gap.kind === "value") return { text: fmtMoney(gap.amount), cls: "warn" };
  return { text: `over ${fmtCompact(gap.cap)}`, cls: "neg" };
}

/**
 * Runway cell: first breach year (below $0, or below the floor in floor mode)
 * + years-from-now, or "never".
 * @param {{firstBreachYear: number|null, startYear: number}} sim
 * @returns {{text: string, cls: "pos"|"neg"}}
 */
export function runwayCell(sim) {
  if (sim.firstBreachYear === null) return { text: "never runs out", cls: "pos" };
  return { text: yearDelta(sim.firstBreachYear, sim.startYear), cls: "neg" };
}

/**
 * One-line rendering of a server error body ({errors: [{path, message}]}),
 * path-prefixed; the fallback covers bodies with no errors array.
 * @param {any} body @param {string} fallback
 */
export function errorsText(body, fallback) {
  return Array.isArray(body?.errors) && body.errors.length
    ? body.errors.map((/** @type {any} */ e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join("; ")
    : fallback;
}
