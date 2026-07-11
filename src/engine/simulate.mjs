// The deterministic year-by-year simulation. Pure: no clock (currentYear is
// state), no filesystem, no globals. Everything in TODAY'S dollars with real
// (after-inflation, after-tax) returns.
import { propertyCashflowYear } from "./property.mjs";

const MEDICARE_AGE = 65;

/**
 * A scenario overlay — the full set of stress knobs. All optional; `{}` is the base case.
 * @typedef {Object} ScenarioOverlay
 * @property {number} [returnMult]        multiplies the real return (e.g. 0 = flat)
 * @property {number} [spendMult]         multiplies category spending (not healthcare)
 * @property {number} [drawdownPct]       haircuts the STARTING balance (market shock now)
 * @property {number} [oneTimeCost]       a single shock expense (major repair)
 * @property {number} [oneTimeCostYearIdx] which simulation year (0-based) the shock lands in
 * @property {number} [vacancyMonths]     see property.mjs
 * @property {number} [vacancyYears]
 * @property {number} [saleDelayYears]
 */

/**
 * @typedef {Object} YearRow
 * @property {number} year
 * @property {number} age
 * @property {number} income   income streams + solver's extra income
 * @property {number} ss       social security (post-haircut)
 * @property {number} propCF   property cash flow (rent − costs − mortgage)
 * @property {number} proceeds sale proceeds landing this year
 * @property {number} health   healthcare cost this year
 * @property {number} spend    category spending + health + one-time shocks
 * @property {number} bal      end-of-year balance
 *
 * @typedef {Object} SimResult
 * @property {{year: number, age: number, bal: number}[]} path starting point + one per year
 * @property {YearRow[]} rows
 * @property {number} endBal
 * @property {number|null} firstNegYear first year balance < 0, or null
 * @property {number|null} firstBreachYear first year balance < the runway threshold (the floor in floor mode, else $0 — where it equals firstNegYear), or null
 * @property {number} minBal
 * @property {number} workUntilYear last year the solver's extra income applies
 * @property {number} startYear
 */

/**
 * Run the simulation.
 *
 * Balance-update ordering (pinned by a hand-computed test): growth applies to
 * the PRIOR balance first, then the year's net cash flow lands — cash arriving
 * during a year earns no return until the following year.
 *   bal[t+1] = bal[t] * (1 + r) + net[t]
 *
 * @param {import("../model/schema.mjs").RunwayState} s validated state
 * @param {ScenarioOverlay} [overlay]
 * @param {number} [extraIncomeAnnual] the solver's variable: net $/yr from now through work.untilAge
 * @returns {SimResult}
 */
export function simulate(s, overlay = {}, extraIncomeAnnual = 0) {
  const startYear = s.profile.currentYear;
  const years = s.profile.endAge - s.profile.currentAge;
  const r = (s.portfolio.realReturnPct / 100) * (overlay.returnMult ?? 1);
  const spendMult = overlay.spendMult ?? 1;
  const baseSpendAnnual = s.spending.reduce((sum, c) => sum + c.monthly, 0) * 12 * spendMult;
  const ssAnnual = s.social.monthly * 12 * (1 - s.social.haircutPct / 100);
  // Clamped so an empty window still means "this year only" — validation warns upstream.
  const workUntilYear = startYear + Math.max(0, s.work.untilAge - s.profile.currentAge);
  const propOverlay = {
    startYear,
    saleDelayYears: overlay.saleDelayYears,
    vacancyMonths: overlay.vacancyMonths,
    vacancyYears: overlay.vacancyYears,
  };

  // R2: runway ends at the first year below $0 OR below the floor — the
  // breach threshold is the floor in floor mode, else $0.
  const breachThreshold = s.endState.mode === "floor" ? s.endState.amounts.floor : 0;

  let bal = s.portfolio.balance;
  if (overlay.drawdownPct) bal *= 1 - overlay.drawdownPct / 100;

  const path = [{ year: startYear - 1, age: s.profile.currentAge - 1, bal }];
  /** @type {YearRow[]} */ const rows = [];
  /** @type {number|null} */ let firstNegYear = null;
  /** @type {number|null} */ let firstBreachYear = null;
  let minBal = bal;

  for (let i = 0; i <= years; i++) {
    const year = startYear + i;
    const age = s.profile.currentAge + i;

    let income = 0;
    for (const inc of s.incomes) {
      if (year >= inc.fromYear && year <= inc.toYear) income += inc.annual;
    }
    if (extraIncomeAnnual && year <= workUntilYear) income += extraIncomeAnnual;

    const ss = age >= s.social.startAge ? ssAnnual : 0;

    let propCF = 0;
    let proceeds = 0;
    for (const p of s.properties) {
      const res = propertyCashflowYear(p, year, propOverlay);
      propCF += res.cf;
      proceeds += res.proceeds;
    }

    let health = 0;
    if (age < MEDICARE_AGE) {
      if (age >= s.health.employerCoverageUntilAge) health = s.health.preMedicareAnnual;
    } else {
      health = s.health.postMedicareAnnual;
    }

    let spend = baseSpendAnnual + health;
    if (overlay.oneTimeCost && i === (overlay.oneTimeCostYearIdx ?? 0)) spend += overlay.oneTimeCost;

    const net = income + ss + propCF + proceeds - spend;
    bal = bal * (1 + r) + net;

    if (bal < minBal) minBal = bal;
    if (firstNegYear === null && bal < 0) firstNegYear = year;
    if (firstBreachYear === null && bal < breachThreshold) firstBreachYear = year;

    path.push({ year, age, bal });
    rows.push({ year, age, income, ss, propCF, proceeds, health, spend, bal });
  }

  return { path, rows, endBal: bal, firstNegYear, firstBreachYear, minBal, workUntilYear, startYear };
}
