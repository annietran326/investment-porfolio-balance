// The deterministic year-by-year simulation. Pure: no clock (currentYear is
// state), no filesystem, no globals.
//
// Money model:
//   - The engine runs in ACTUAL (nominal) dollars with one inflation input.
//     Inputs are entered in today's dollars and grow at their own rates (blank
//     = inflation). Every number it RETURNS is converted back to today's
//     dollars, so results are easy to judge.
//   - Accounts are pooled by how they're taxed: taxable (tracks cost basis),
//     tax-deferred (traditional IRA + 401(k)), and Roth. All three hold the
//     same household-level bucket mix and earn the same blended return.
//   - Each year the portfolio is re-split across the three buckets by the
//     time-based rule in buckets.mjs, and earns the blended bucket return.
//     Rebalancing is treated as tax-free (a small simplification).
//
// Within a year (pinned by tests): growth applies to the balance at the START
// of the year, then contributions and the year's net cash flow land at the
// end. Cash arriving during a year earns no return until the next year.
//
// Withdrawal order when spending outruns income: taxable, then tax-deferred,
// then Roth. Each withdrawal is grossed up for tax so the after-tax cash covers
// the shortfall:
//   - taxable: tax = capital-gains rate x the gain share of what's sold, where
//     gain share = (value - basis) / value at that moment. Growth raises value
//     but not basis, so the taxed share rises over time; a sale reduces basis
//     in proportion (average-cost method).
//   - tax-deferred: ordinary income rate on the whole withdrawal, plus a 10%
//     penalty before age 59 1/2.
//   - Roth: tax-free (withdrawals before 59 1/2 are flagged, not penalized).
// Not modeled: required minimum distributions (slightly optimistic), Roth
// early-withdrawal rules, tax brackets. Income and property proceeds are
// entered after tax.
import { propertyCashflowYear } from "./property.mjs";
import { grownValue, effectiveGrowthPct } from "./growth.mjs";
import { bucketReturns, bucketTargets, allocate, pvFactor, shares } from "./buckets.mjs";

const MEDICARE_AGE = 65;
// Withdrawals from traditional IRAs / 401(k)s before 59 1/2 carry a 10% penalty.
// A year counts as "before" when you're under 59 1/2 at mid-year (start age < 59).
export const EARLY_WITHDRAWAL_START_AGE = 59;
export const EARLY_WITHDRAWAL_PENALTY_PCT = 10;
// In the market-drop stress, high income falls by this share of the equity drop.
export const INCOME_DROP_SHARE = 0.5;

/**
 * Annual healthcare cost for one person at a given age (today's $): $0 while
 * employer coverage lasts, the pre-65 bridge after it, Medicare-age cost at 65+.
 * @param {import("../model/schema.mjs").Health} health
 * @param {number} age
 */
function healthCostAt(health, age) {
  if (age >= MEDICARE_AGE) return health.postMedicareAnnual;
  return age >= health.employerCoverageUntilAge ? health.preMedicareAnnual : 0;
}

/** Post-haircut annual Social Security in today's $. @param {import("../model/schema.mjs").Social} social */
function ssAnnualOf(social) {
  return social.monthly * 12 * (1 - social.haircutPct / 100);
}

/**
 * A scenario overlay: the full set of stress knobs. All optional; `{}` is the base case.
 * @typedef {Object} ScenarioOverlay
 * @property {number} [spendMult]         multiplies category spending (not healthcare)
 * @property {number} [drawdownPct]       market drop NOW: equities fall this %, high income half as much, capital preservation not at all
 * @property {number} [oneTimeCost]       a single shock expense, today's $ (major repair)
 * @property {number} [oneTimeCostYearIdx] which simulation year (0-based) the shock lands in
 * @property {number} [vacancyMonths]     see property.mjs
 * @property {number} [vacancyYears]
 * @property {number} [saleDelayYears]
 * @property {{preservation: number, income: number, equities: number}[]} [returnsByYear]
 *   Monte Carlo hook: actual returns (decimals) per simulation year. A missing
 *   year uses the bucket assumptions. The split itself always plans with the
 *   assumptions (you plan with expected returns, then live with actual ones).
 */

/**
 * @typedef {{preservation: number, income: number, equities: number}} Mix
 *
 * @typedef {Object} YearRow  every $ figure in today's dollars
 * @property {number} year
 * @property {number} age
 * @property {number} income   income streams + the solver's extra income
 * @property {number} ss       social security (post-haircut)
 * @property {number} propCF   property cash flow (rent − costs − mortgage)
 * @property {number} proceeds sale proceeds landing this year
 * @property {number} health   healthcare cost this year
 * @property {number} spend    category spending + health + one-time shocks
 * @property {number} contrib  contributions into accounts (incl. employer match)
 * @property {number} withdrawn gross amount taken out of accounts (before tax)
 * @property {number} tax      tax + penalties on those withdrawals
 * @property {number} returnPct the blended return earned this year, %
 * @property {Mix} mix         bucket shares at the start of the year (sum to 1)
 * @property {number} bal      end-of-year balance
 *
 * @typedef {Object} SimResult
 * @property {{year: number, age: number, bal: number}[]} path starting point + one per year (today's $)
 * @property {YearRow[]} rows
 * @property {number} endBal   today's $
 * @property {number|null} firstNegYear first year balance < 0, or null
 * @property {number|null} firstBreachYear first year balance < the runway threshold (the floor in floor mode, else $0), or null
 * @property {number} minBal   today's $
 * @property {number} workUntilYear last year the solver's extra income applies
 * @property {number} startYear
 * @property {Mix} startMix    the recommended split today, as dollars (today's $)
 * @property {number[]} earlyDeferredYears years a traditional IRA/401(k) was tapped before 59 1/2 (penalty applied)
 * @property {number[]} earlyRothYears    years the Roth was tapped before 59 1/2 (flag only)
 */

/**
 * Run the simulation.
 *
 * @param {import("../model/schema.mjs").RunwayState} s validated state
 * @param {ScenarioOverlay} [overlay]
 * @param {number} [extraIncomeAnnual] the required-income solver's variable: after-tax $/yr (today's $, rising with inflation) from now through work.untilAge
 * @param {number} [extraSavingsToday] the gap solver's variable: extra $ added to the taxable account today (as fresh cash: basis = amount)
 * @returns {SimResult}
 */
export function simulate(s, overlay = {}, extraIncomeAnnual = 0, extraSavingsToday = 0) {
  const startYear = s.profile.currentYear;
  const years = Math.max(0, s.profile.endAge - s.profile.currentAge);
  const inflPct = s.economy.inflationPct;
  const infl = inflPct / 100;
  const deflator = (/** @type {number} */ i) => (1 + infl) ** i; // today's $ -> year-i $
  const spendMult = overlay.spendMult ?? 1;
  const b = s.buckets;
  const planReturns = bucketReturns(b);
  const ordinaryRate = s.taxes.ordinaryIncomePct / 100;
  const gainsRate = s.taxes.capitalGainsPct / 100;
  const ssAnnualSelf = ssAnnualOf(s.social);
  // Spouses with their own age contribute Social Security and a healthcare load
  // on their own age trajectory.
  const spouses = (s.household?.people ?? []).filter((p) => p.role === "spouse" && typeof p.currentAge === "number");
  const workUntilYear = startYear + Math.max(0, s.work.untilAge - s.profile.currentAge);
  const propOverlay = {
    startYear,
    inflationPct: inflPct,
    saleDelayYears: overlay.saleDelayYears,
    vacancyMonths: overlay.vacancyMonths,
    vacancyYears: overlay.vacancyYears,
  };
  const breachThreshold = s.endState.mode === "floor" ? s.endState.amounts.floor : 0;

  // ---- Pass 1: every year's cash flows in actual dollars, independent of the portfolio ----
  const flows = [];
  for (let i = 0; i < years; i++) {
    const year = startYear + i;
    const age = s.profile.currentAge + i;
    const d = deflator(i);

    let income = 0;
    for (const inc of s.incomes) {
      if (year >= inc.fromYear && year <= inc.toYear) income += grownValue(inc.annual, effectiveGrowthPct(inc.growthPct, inflPct), i);
    }
    if (extraIncomeAnnual && year <= workUntilYear) income += extraIncomeAnnual * d;

    // Social Security rises with inflation (the annual COLA).
    let ss = age >= s.social.startAge ? ssAnnualSelf : 0;
    for (const sp of spouses) {
      const spAge = /** @type {number} */ (sp.currentAge) + i;
      if (sp.social && spAge >= sp.social.startAge) ss += ssAnnualOf(sp.social);
    }
    ss *= d;

    let propCF = 0;
    let proceeds = 0;
    for (const p of s.properties) {
      const res = propertyCashflowYear(p, year, propOverlay);
      propCF += res.cf;
      proceeds += res.proceeds;
    }

    // Healthcare rises with inflation.
    let health = healthCostAt(s.health, age);
    for (const sp of spouses) {
      if (sp.health) health += healthCostAt(sp.health, /** @type {number} */ (sp.currentAge) + i);
    }
    health *= d;

    let categorySpend = 0;
    for (const c of s.spending) {
      if ((c.fromYear == null || year >= c.fromYear) && (c.toYear == null || year <= c.toYear)) {
        categorySpend += grownValue(c.monthly * 12, effectiveGrowthPct(c.growthPct, inflPct), i);
      }
    }
    // Household support costs: today's $, rising with inflation.
    for (const person of s.household?.people ?? []) {
      if (person.annualCost && (person.fromYear == null || year >= person.fromYear) && (person.toYear == null || year <= person.toYear)) {
        categorySpend += person.annualCost * d;
      }
    }
    let spend = categorySpend * spendMult + health;
    if (overlay.oneTimeCost && i === (overlay.oneTimeCostYearIdx ?? 0)) spend += overlay.oneTimeCost * d;

    // Contributions into accounts, by tax pool.
    const contrib = { taxable: 0, deferred: 0, roth: 0 };
    for (const a of s.accounts) {
      const perYear = (a.contributionAnnual ?? 0) + (a.employerMatchAnnual ?? 0);
      if (!perYear) continue;
      const untilAge = a.contributeUntilAge ?? s.work.untilAge;
      if (age > untilAge) continue;
      const amount = grownValue(perYear, effectiveGrowthPct(a.contributionGrowthPct, inflPct), i);
      contrib[poolOf(a.type)] += amount;
    }

    flows.push({ year, age, income, ss, propCF, proceeds, health, spend, contrib, net: income + ss + propCF + proceeds - spend });
  }

  // What the portfolio must supply at the end of each year, before tax.
  const needs = flows.map((f) => Math.max(0, -f.net));
  const factors = [0];
  for (let t = 1; t <= years; t++) factors.push(pvFactor(t, b, planReturns));

  // ---- Starting pools ----
  const taxable = { v: 0, basis: 0 };
  let deferred = 0;
  let roth = 0;
  for (const a of s.accounts) {
    const pool = poolOf(a.type);
    if (pool === "taxable") {
      taxable.v += a.balance;
      taxable.basis += a.costBasis ?? a.balance;
    } else if (pool === "deferred") deferred += a.balance;
    else roth += a.balance;
  }
  if (extraSavingsToday) {
    taxable.v += extraSavingsToday;
    taxable.basis += extraSavingsToday;
  }

  // Market drop now: equities fall drawdownPct, high income half that, applied
  // to today's recommended split. Every pool loses the same share (all
  // accounts hold the same mix); cost basis doesn't change.
  const startTotal = taxable.v + deferred + roth;
  const startDollars = allocate(startTotal, bucketTargets(needs, 0, factors, b));
  if (overlay.drawdownPct && startTotal > 0) {
    const dd = overlay.drawdownPct / 100;
    const loss = startDollars.equities * dd + startDollars.income * dd * INCOME_DROP_SHARE;
    const keep = Math.max(0, 1 - loss / startTotal);
    taxable.v *= keep;
    deferred *= keep;
    roth *= keep;
  }

  let bal = taxable.v + deferred + roth;
  const path = [{ year: startYear, age: s.profile.currentAge, bal }];
  /** @type {YearRow[]} */ const rows = [];
  /** @type {number|null} */ let firstNegYear = null;
  /** @type {number|null} */ let firstBreachYear = null;
  let minBal = bal;
  /** @type {number[]} */ const earlyDeferredYears = [];
  /** @type {number[]} */ const earlyRothYears = [];

  for (let i = 0; i < years; i++) {
    const f = flows[i];
    const d = deflator(i);

    // 1. Split the portfolio across the buckets and earn the blended return.
    const total = taxable.v + deferred + roth;
    const mix = shares(allocate(total, bucketTargets(needs, i, factors, b)));
    const actual = overlay.returnsByYear?.[i] ?? planReturns;
    const r = total > 0
      ? mix.preservation * actual.preservation + mix.income * actual.income + mix.equities * actual.equities
      : actual.preservation; // a negative balance (borrowed) carries roughly an inflation-level cost
    taxable.v *= 1 + r;
    deferred *= 1 + r;
    roth *= 1 + r;

    // 2. Contributions land at year end.
    taxable.v += f.contrib.taxable;
    taxable.basis += f.contrib.taxable;
    deferred += f.contrib.deferred;
    roth += f.contrib.roth;

    // 3. Net cash flow: a surplus is saved to the taxable account; a shortfall
    //    is withdrawn, taxable -> tax-deferred -> Roth, grossed up for tax.
    let withdrawn = 0;
    let tax = 0;
    if (f.net >= 0) {
      taxable.v += f.net;
      taxable.basis += f.net;
    } else {
      let short = -f.net;

      if (short > 0 && taxable.v > 0) {
        const gainShare = Math.max(0, 1 - taxable.basis / taxable.v);
        const rate = gainShare * gainsRate;
        const sold = Math.min(short / Math.max(1e-9, 1 - rate), taxable.v);
        taxable.basis -= sold * (taxable.basis / taxable.v);
        taxable.v -= sold;
        withdrawn += sold;
        tax += sold * rate;
        short -= sold * (1 - rate);
      }

      if (short > 1e-9 && deferred > 0) {
        const early = f.age < EARLY_WITHDRAWAL_START_AGE;
        const rate = ordinaryRate + (early ? EARLY_WITHDRAWAL_PENALTY_PCT / 100 : 0);
        const sold = Math.min(short / Math.max(1e-9, 1 - rate), deferred);
        deferred -= sold;
        withdrawn += sold;
        tax += sold * rate;
        short -= sold * (1 - rate);
        if (early) earlyDeferredYears.push(f.year);
      }

      if (short > 1e-9 && roth > 0) {
        const sold = Math.min(short, roth);
        roth -= sold;
        withdrawn += sold;
        short -= sold;
        if (f.age < EARLY_WITHDRAWAL_START_AGE) earlyRothYears.push(f.year);
      }

      // Everything is empty: the rest is borrowed, which shows as a negative balance.
      if (short > 1e-9) taxable.v -= short;
    }

    const nominalBal = taxable.v + deferred + roth;
    bal = nominalBal / deflator(i + 1);
    const balYear = f.year + 1;
    const balAge = f.age + 1;
    if (bal < minBal) minBal = bal;
    if (firstNegYear === null && bal < 0) firstNegYear = balYear;
    if (firstBreachYear === null && bal < breachThreshold) firstBreachYear = balYear;

    path.push({ year: balYear, age: balAge, bal });
    rows.push({
      year: f.year,
      age: f.age,
      income: f.income / d,
      ss: f.ss / d,
      propCF: f.propCF / d,
      proceeds: f.proceeds / d,
      health: f.health / d,
      spend: f.spend / d,
      contrib: (f.contrib.taxable + f.contrib.deferred + f.contrib.roth) / d,
      withdrawn: withdrawn / d,
      tax: tax / d,
      returnPct: r * 100,
      mix,
      bal,
    });
  }

  return {
    path,
    rows,
    endBal: bal,
    firstNegYear,
    firstBreachYear,
    minBal,
    workUntilYear,
    startYear,
    startMix: startDollars,
    earlyDeferredYears,
    earlyRothYears,
  };
}

/** @param {import("../model/schema.mjs").AccountType} type @returns {"taxable"|"deferred"|"roth"} */
function poolOf(type) {
  if (type === "taxable") return "taxable";
  if (type === "roth_ira") return "roth";
  return "deferred";
}
