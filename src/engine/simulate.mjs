// The deterministic year-by-year simulation. Pure: no clock (currentYear is
// state), no filesystem, no globals. Everything in TODAY'S dollars with real
// (after-inflation, after-tax) returns.
import { propertyCashflowYear } from "./property.mjs";
import { grownValue } from "./growth.mjs";

const MEDICARE_AGE = 65;

/**
 * Annual healthcare cost for one person at a given age: $0 while employer
 * coverage lasts, the pre-65 bridge after it, Medicare-age cost at 65+.
 * @param {import("../model/schema.mjs").Health} health
 * @param {number} age
 */
function healthCostAt(health, age) {
  if (age >= MEDICARE_AGE) return health.postMedicareAnnual;
  return age >= health.employerCoverageUntilAge ? health.preMedicareAnnual : 0;
}

/** Post-haircut annual Social Security for a person's SS config. @param {import("../model/schema.mjs").Social} social */
function ssAnnualOf(social) {
  return social.monthly * 12 * (1 - social.haircutPct / 100);
}

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
  const ssAnnualSelf = ssAnnualOf(s.social);
  // Spouses with their own age contribute Social Security and a healthcare load
  // on their own age trajectory. Dependents have no direct engine effect — their
  // costs are ordinary (time-boxed) spending lines.
  const spouses = (s.household?.people ?? []).filter((p) => p.role === "spouse" && typeof p.currentAge === "number");
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

  // "Now": the starting balance sits at the current year with no growth yet.
  // Each step lives through one year (its income, spending, growth) and produces
  // the balance at the START of the next year — so the value plotted at year Y
  // is the portfolio at year Y, and currentYear shows exactly what you entered.
  const path = [{ year: startYear, age: s.profile.currentAge, bal }];
  /** @type {YearRow[]} */ const rows = [];
  /** @type {number|null} */ let firstNegYear = null;
  /** @type {number|null} */ let firstBreachYear = null;
  let minBal = bal;

  for (let i = 0; i < years; i++) {
    const year = startYear + i;
    const age = s.profile.currentAge + i;

    let income = 0;
    for (const inc of s.incomes) {
      if (year >= inc.fromYear && year <= inc.toYear) income += grownValue(inc.annual, inc.realGrowthPct, i);
    }
    if (extraIncomeAnnual && year <= workUntilYear) income += extraIncomeAnnual; // solver income does not grow

    // Social Security: self plus any spouse, each on their own age + start age.
    let ss = age >= s.social.startAge ? ssAnnualSelf : 0;
    for (const sp of spouses) {
      const spAge = /** @type {number} */ (sp.currentAge) + i;
      if (sp.social && spAge >= sp.social.startAge) ss += ssAnnualOf(sp.social);
    }

    let propCF = 0;
    let proceeds = 0;
    for (const p of s.properties) {
      const res = propertyCashflowYear(p, year, propOverlay);
      propCF += res.cf;
      proceeds += res.proceeds;
    }

    // Healthcare: self plus any spouse, each on their own age.
    let health = healthCostAt(s.health, age);
    for (const sp of spouses) {
      if (sp.health) health += healthCostAt(sp.health, /** @type {number} */ (sp.currentAge) + i);
    }

    // Category spending: only lines active this year (null window bound = open),
    // each grown per its real-growth rate; the scenario spend shock scales
    // categories but not healthcare.
    let categorySpend = 0;
    for (const c of s.spending) {
      // `== null` treats both null and a missing bound as "open".
      if ((c.fromYear == null || year >= c.fromYear) && (c.toYear == null || year <= c.toYear)) {
        categorySpend += grownValue(c.monthly * 12, c.realGrowthPct, i);
      }
    }
    // Household support costs (raising a kid, supporting a parent) — an ongoing
    // living expense over each person's window, so it flexes with the spending
    // shock like a category and holds constant in real terms.
    for (const person of s.household?.people ?? []) {
      if (person.annualCost && (person.fromYear == null || year >= person.fromYear) && (person.toYear == null || year <= person.toYear)) {
        categorySpend += person.annualCost;
      }
    }
    let spend = categorySpend * spendMult + health;
    if (overlay.oneTimeCost && i === (overlay.oneTimeCostYearIdx ?? 0)) spend += overlay.oneTimeCost;

    const net = income + ss + propCF + proceeds - spend;
    bal = bal * (1 + r) + net;

    // The balance after living through `year` is the portfolio at the next year.
    const balYear = year + 1;
    const balAge = age + 1;
    if (bal < minBal) minBal = bal;
    if (firstNegYear === null && bal < 0) firstNegYear = balYear;
    if (firstBreachYear === null && bal < breachThreshold) firstBreachYear = balYear;

    path.push({ year: balYear, age: balAge, bal });
    // The row is the lived year's cash flows and its resulting end-of-year balance.
    rows.push({ year, age, income, ss, propCF, proceeds, health, spend, bal });
  }

  return { path, rows, endBal: bal, firstNegYear, firstBreachYear, minBal, workUntilYear, startYear };
}
