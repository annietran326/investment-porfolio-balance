// The deterministic year-by-year simulation. Pure: no clock (currentYear is
// state), no filesystem, no globals.
//
// Money model:
//   - The engine runs in ACTUAL (nominal) dollars with one inflation input.
//     Inputs are entered in today's dollars and grow at their own rates (blank
//     = inflation). Every number it RETURNS is converted back to today's
//     dollars, so results are easy to judge.
//   - Accounts are grouped into "holdings" by how they're taxed (taxable,
//     which tracks cost basis; tax-deferred, i.e. traditional IRA + 401(k);
//     and Roth) and by how they're invested:
//       * accounts in the three-bucket plan share one household-level mix and
//         earn the blended bucket return. Each year that money is re-split
//         across the buckets by the time-based rule in buckets.mjs.
//         Rebalancing is treated as tax-free (a small simplification).
//       * an account in its OWN fund (e.g. a target-date 401(k) you leave
//         alone) earns its own return and is not part of the split. It's
//         treated as long-term money: it reduces how much the bucket plan
//         needs to hold in equities.
//
// Lifespans: you and a spouse each live to the same plan-to age. The plan runs
// until the younger of you reaches it. Each person's Social Security and
// healthcare stop after they pass it; the survivor keeps the larger of the two
// Social Security checks (the survivor-benefit rule, from age 60). Household
// spending is unchanged after a death (conservative).
//
// Within a year (pinned by tests): growth applies to the balance at the START
// of the year, then contributions and the year's net cash flow land at the
// end. Cash arriving during a year earns no return until the next year.
//
// Withdrawal order when spending outruns income: taxable, then tax-deferred,
// then Roth (within each, bucket-plan money before own-fund money). Each
// withdrawal is grossed up for tax so the after-tax cash covers the shortfall:
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
// A surviving spouse can collect the late spouse's Social Security from age 60.
export const SURVIVOR_MIN_AGE = 60;
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
 * @property {{preservation: number, income: number, equities: number, own?: number}[]} [returnsByYear]
 *   Monte Carlo hook: actual returns (decimals) per simulation year. A missing
 *   year uses the bucket assumptions; a missing `own` uses each own-fund
 *   account's own return. The split itself always plans with the assumptions
 *   (you plan with expected returns, then live with actual ones).
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
 * @property {number} returnPct the return the whole portfolio earned this year, %
 * @property {Mix} mix         bucket shares of the bucket-plan money at the start of the year (sum to 1)
 * @property {number} ownBal   money in own-fund accounts at the start of the year
 * @property {number} bal      end-of-year balance
 *
 * @typedef {Object} SimResult
 * @property {{year: number, age: number, bal: number}[]} path starting point + one per year (today's $)
 * @property {YearRow[]} rows
 * @property {number} endBal   today's $
 * @property {number|null} firstNegYear first year balance < 0, or null
 * @property {number|null} firstBreachYear first year balance < the runway threshold (the floor in floor mode, else $0), or null
 * @property {number} minBal   today's $
 * @property {number} startYear
 * @property {Mix} startMix    the recommended split today for the bucket-plan money, as dollars (today's $)
 * @property {number} startOwn  money in own-fund accounts today (today's $)
 * @property {number[]} earlyDeferredYears years a traditional IRA/401(k) was tapped before 59 1/2 (penalty applied)
 * @property {number[]} earlyRothYears    years the Roth was tapped before 59 1/2 (flag only)
 */

/**
 * Run the simulation.
 *
 * @param {import("../model/schema.mjs").RunwayState} s validated state
 * @param {ScenarioOverlay} [overlay]
 * @param {number} [extraSavingsToday] the gap solver's variable: extra $ added to the taxable account today (as fresh cash: basis = amount)
 * @returns {SimResult}
 */
export function simulate(s, overlay = {}, extraSavingsToday = 0) {
  const startYear = s.profile.currentYear;
  const endAge = s.profile.endAge;
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
  // The plan runs until the youngest of you reaches the plan-to age.
  const years = Math.max(0, endAge - s.profile.currentAge, ...spouses.map((sp) => endAge - /** @type {number} */ (sp.currentAge)));
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

    // Social Security rises with inflation (the annual COLA). Each living
    // person collects their own from their start age; a surviving spouse keeps
    // the larger of their own and the late spouse's check.
    const selfAlive = age < endAge;
    const selfOwn = selfAlive && age >= s.social.startAge ? ssAnnualSelf : 0;
    let ss = selfOwn;
    spouses.forEach((sp, k) => {
      const spAge = /** @type {number} */ (sp.currentAge) + i;
      const spAlive = spAge < endAge;
      const spBenefit = sp.social ? ssAnnualOf(sp.social) : 0;
      const spOwn = spAlive && sp.social && spAge >= sp.social.startAge ? spBenefit : 0;
      if (k !== 0) {
        ss += spOwn; // survivor rule applies to the first spouse only
        return;
      }
      if (selfAlive && !spAlive && age >= SURVIVOR_MIN_AGE) ss = Math.max(selfOwn, spBenefit);
      else if (!selfAlive && spAlive && spAge >= SURVIVOR_MIN_AGE) ss = Math.max(spOwn, ssAnnualSelf);
      else ss += spOwn;
    });
    ss *= d;

    let propCF = 0;
    let proceeds = 0;
    for (const p of s.properties) {
      const res = propertyCashflowYear(p, year, propOverlay);
      propCF += res.cf;
      proceeds += res.proceeds;
    }

    // Healthcare rises with inflation; each person's stops after they pass the plan-to age.
    let health = selfAlive ? healthCostAt(s.health, age) : 0;
    for (const sp of spouses) {
      const spAge = /** @type {number} */ (sp.currentAge) + i;
      if (sp.health && spAge < endAge) health += healthCostAt(sp.health, spAge);
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

    flows.push({ year, age, income, ss, propCF, proceeds, health, spend, net: income + ss + propCF + proceeds - spend });
  }

  // ---- Holdings: bucket-plan money pooled by tax type, plus one per own-fund account ----
  /** @type {Holding[]} */
  const holdings = [
    { pool: "taxable", own: false, v: 0, basis: 0, ownRate: 0 },
    { pool: "deferred", own: false, v: 0, basis: 0, ownRate: 0 },
    { pool: "roth", own: false, v: 0, basis: 0, ownRate: 0 },
  ];
  const managedTaxable = holdings[0];
  /** @type {number[]} holding index for each account */
  const holdingOf = s.accounts.map((a) => {
    const pool = poolOf(a.type);
    const basis = pool === "taxable" ? a.costBasis ?? a.balance : 0;
    if (a.invest === "own") {
      holdings.push({ pool, own: true, v: a.balance, basis, ownRate: a.ownReturnPct / 100 });
      return holdings.length - 1;
    }
    const h = holdings[POOL_ORDER.indexOf(pool)];
    h.v += a.balance;
    h.basis += basis;
    return POOL_ORDER.indexOf(pool);
  });
  if (extraSavingsToday) {
    managedTaxable.v += extraSavingsToday;
    managedTaxable.basis += extraSavingsToday;
  }
  // Taxable first, then tax-deferred, then Roth; bucket-plan money before own-fund money.
  const withdrawOrder = holdings
    .map((h, idx) => idx)
    .sort((x, y) => POOL_ORDER.indexOf(holdings[x].pool) - POOL_ORDER.indexOf(holdings[y].pool) || Number(holdings[x].own) - Number(holdings[y].own) || x - y);

  // Contributions per holding, per year (actual $).
  const contribs = flows.map((f, i) => {
    const out = holdings.map(() => 0);
    s.accounts.forEach((a, k) => {
      const perYear = (a.contributionAnnual ?? 0) + (a.employerMatchAnnual ?? 0);
      if (!perYear || i >= (a.contributeYears ?? 0)) return;
      out[holdingOf[k]] += grownValue(perYear, effectiveGrowthPct(a.contributionGrowthPct, inflPct), i);
    });
    return out;
  });

  // What the portfolio must supply at the end of each year, before tax.
  const needs = flows.map((f) => Math.max(0, -f.net));
  const factors = [0];
  for (let t = 1; t <= years; t++) factors.push(pvFactor(t, b, planReturns));

  const sumOf = (/** @type {boolean} */ own) => holdings.reduce((sum, h) => (h.own === own ? sum + h.v : sum), 0);
  /** The split of the bucket-plan money at year i, with own-fund money counted as long-term (equities) money. */
  const splitAt = (/** @type {number} */ i) => {
    const targets = bucketTargets(needs, i, factors, b);
    targets.equities = Math.max(0, targets.equities - Math.max(0, sumOf(true)));
    return allocate(sumOf(false), targets);
  };

  // Market drop now: equities fall drawdownPct, high income half that (on
  // today's split of the bucket-plan money), capital preservation not at all.
  // Own funds are assumed stock-heavy and fall the full drawdownPct. Cost
  // basis doesn't change.
  const startDollars = splitAt(0);
  const startOwn = sumOf(true);
  if (overlay.drawdownPct) {
    const dd = overlay.drawdownPct / 100;
    const managed = sumOf(false);
    if (managed > 0) {
      const loss = startDollars.equities * dd + startDollars.income * dd * INCOME_DROP_SHARE;
      const keep = Math.max(0, 1 - loss / managed);
      for (const h of holdings) if (!h.own) h.v *= keep;
    }
    for (const h of holdings) if (h.own) h.v *= 1 - dd;
  }

  let bal = sumOf(false) + sumOf(true);
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

    // 1. Split the bucket-plan money and earn the blended return; own funds
    //    earn their own return.
    const managedStart = sumOf(false);
    const ownStart = sumOf(true);
    const mix = shares(splitAt(i));
    const actual = overlay.returnsByYear?.[i] ?? planReturns;
    const r = managedStart > 0
      ? mix.preservation * actual.preservation + mix.income * actual.income + mix.equities * actual.equities
      : actual.preservation; // a negative balance (borrowed) carries roughly an inflation-level cost
    for (const h of holdings) h.v *= 1 + (h.own ? overlay.returnsByYear?.[i]?.own ?? h.ownRate : r);
    const startTotal = managedStart + ownStart;
    const grownTotal = sumOf(false) + sumOf(true);
    const portfolioReturn = startTotal > 0 ? grownTotal / startTotal - 1 : r;

    // 2. Contributions land at year end.
    let contribTotal = 0;
    contribs[i].forEach((c, idx) => {
      if (!c) return;
      holdings[idx].v += c;
      if (holdings[idx].pool === "taxable") holdings[idx].basis += c;
      contribTotal += c;
    });

    // 3. Net cash flow: a surplus is saved to the taxable account; a shortfall
    //    is withdrawn in order, grossed up for tax.
    let withdrawn = 0;
    let tax = 0;
    if (f.net >= 0) {
      managedTaxable.v += f.net;
      managedTaxable.basis += f.net;
    } else {
      let short = -f.net;
      const early = f.age < EARLY_WITHDRAWAL_START_AGE;
      for (const idx of withdrawOrder) {
        const h = holdings[idx];
        if (!(short > 1e-9) || !(h.v > 0)) continue;
        let rate = 0;
        if (h.pool === "taxable") rate = Math.max(0, 1 - h.basis / h.v) * gainsRate;
        else if (h.pool === "deferred") rate = ordinaryRate + (early ? EARLY_WITHDRAWAL_PENALTY_PCT / 100 : 0);
        const sold = Math.min(short / Math.max(1e-9, 1 - rate), h.v);
        if (h.pool === "taxable") h.basis -= sold * (h.basis / h.v);
        h.v -= sold;
        withdrawn += sold;
        tax += sold * rate;
        short -= sold * (1 - rate);
        if (early && h.pool === "deferred" && earlyDeferredYears.at(-1) !== f.year) earlyDeferredYears.push(f.year);
        if (early && h.pool === "roth" && earlyRothYears.at(-1) !== f.year) earlyRothYears.push(f.year);
      }
      // Everything is empty: the rest is borrowed, which shows as a negative balance.
      if (short > 1e-9) managedTaxable.v -= short;
    }

    bal = (sumOf(false) + sumOf(true)) / deflator(i + 1);
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
      contrib: contribTotal / d,
      withdrawn: withdrawn / d,
      tax: tax / d,
      returnPct: portfolioReturn * 100,
      mix,
      ownBal: ownStart / d,
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
    startYear,
    startMix: startDollars,
    startOwn,
    earlyDeferredYears,
    earlyRothYears,
  };
}

/** @typedef {{pool: "taxable"|"deferred"|"roth", own: boolean, v: number, basis: number, ownRate: number}} Holding */

const POOL_ORDER = /** @type {const} */ (["taxable", "deferred", "roth"]);

/** @param {import("../model/schema.mjs").AccountType} type @returns {"taxable"|"deferred"|"roth"} */
function poolOf(type) {
  if (type === "taxable") return "taxable";
  if (type === "roth_ira") return "roth";
  return "deferred";
}
