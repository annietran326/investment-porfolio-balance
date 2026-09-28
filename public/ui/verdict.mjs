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
 * The headline answer, as copy: do I have enough, and if not, the gap.
 * @param {import("../../src/engine/solver.mjs").GapResult} gap base-case requiredSavings(state, {})
 * @param {RunwayState} state
 * @param {number} endBal base-case end balance, today's $
 * @returns {{tone: "good"|"bad", headline: string, detail: string}}
 */
export function verdictCopy(gap, state, endBal) {
  const goal = goalText(state);
  if (gap.kind === "met") {
    return {
      tone: "good",
      headline: "Yes, you have enough.",
      detail: `With what you have today, the plan reaches your goal (${goal}) at age ${state.profile.endAge}, ending with ${fmtMoney(endBal)} in today's dollars.`,
    };
  }
  if (gap.kind === "value") {
    return {
      tone: "bad",
      headline: `Not yet. The gap is ${fmtMoney(gap.amount)} in today's dollars.`,
      detail: `That's how much more you'd need invested today, in the recommended split, to ${goal} by age ${state.profile.endAge}.`,
    };
  }
  return {
    tone: "bad",
    headline: `Not reachable even with ${fmtMoney(gap.cap)} more today.`,
    detail: `Something in the plan outruns any realistic amount of savings. Check spending, the plan-to age, and the goal (${goal}).`,
  };
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
