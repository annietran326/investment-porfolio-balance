// Verdict copy + formatting. Pure — no DOM, no imports — so node:test covers
// every branch headlessly. The three-way verdict can NEVER render blank: each
// SolverResult kind maps to distinct, non-empty copy.

/**
 * @typedef {import("../../src/engine/solver.mjs").SolverResult} SolverResult
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
 * The three-way answer, as copy. Distinct tone + headline + detail per kind.
 * @param {SolverResult} result base-case requiredIncome(state, {})
 * @param {RunwayState} state
 * @returns {{tone: "good"|"bad", headline: string, detail: string}}
 */
export function verdictCopy(result, state) {
  if (result.kind === "met") {
    return {
      tone: "good",
      headline: "No — you don't need to work.",
      detail: `Goal (${goalText(state)}) is met with no additional income.`,
    };
  }
  if (result.kind === "value") {
    return {
      tone: "bad",
      headline: `Yes — earn ${fmtMoney(result.perYear)}/yr (net) from now until age ${result.untilAge}, then never again.`,
      detail: `The minimum net income to ${goalText(state)}, earned from now through age ${result.untilAge}.`,
    };
  }
  return {
    tone: "bad",
    headline: `Not achievable even at ${fmtMoney(result.cap)}/yr until age ${state.work.untilAge} — extend the window or cut spending.`,
    detail: `No income up to ${fmtMoney(result.cap)}/yr lands the goal (${goalText(state)}). Raise the work-until age, reduce spending, or change the end state.`,
  };
}

/**
 * Required-income table/KPI cell — never blank, color class per kind.
 * @param {SolverResult} result
 * @returns {{text: string, cls: "pos"|"warn"|"neg"}}
 */
export function requiredCell(result) {
  if (result.kind === "met") return { text: "none", cls: "pos" };
  if (result.kind === "value") return { text: fmtMoney(result.perYear), cls: "warn" };
  return { text: `not achievable even at ${fmtCompact(result.cap)}/yr`, cls: "neg" };
}

/**
 * Runway cell: first-negative year + years-from-now, or "never".
 * @param {{firstNegYear: number|null, startYear: number}} sim
 * @returns {{text: string, cls: "pos"|"neg"}}
 */
export function runwayCell(sim) {
  if (sim.firstNegYear === null) return { text: "never", cls: "pos" };
  return { text: yearDelta(sim.firstNegYear, sim.startYear), cls: "neg" };
}
