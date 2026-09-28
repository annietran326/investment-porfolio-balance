// The year-by-year simulation. Pure: no clock (currentYear is state), no
// filesystem, no globals.
//
// It runs in two modes that share every rule:
//   - the EXPECTED-RETURN plan: every year earns exactly the bucket returns
//     you entered (used for the recommended split, the by-age table, and the
//     year-by-year cash flow);
//   - a SIMULATED future (Monte Carlo): each year's returns are drawn at
//     random around those expectations (see montecarlo.mjs), passed in as
//     `shocks`.
//
// Money model:
//   - The engine runs in ACTUAL (nominal) dollars with one inflation input.
//     Inputs are entered in today's dollars and grow at their own rates (blank
//     = inflation). Every number it RETURNS is converted back to today's
//     dollars.
//   - Accounts are grouped into "holdings" by how they're taxed (taxable,
//     which tracks cost basis; tax-deferred, i.e. traditional IRA + 401(k);
//     and Roth) and by how they're invested:
//       * bucket-plan accounts share three real bucket balances: capital
//         preservation, high income, global equities (the rules for sizing
//         them are in buckets.mjs);
//       * an own-fund account (e.g. a target-date 401(k) you leave alone)
//         earns its own return, isn't part of the split, and counts as
//         long-term money (it lowers the bucket plan's equities target).
//
// Each year, in order (pinned by tests):
//   1. Every bucket and own fund earns its return for the year.
//   2. Contributions land.
//   3. The year's net cash flow lands: a surplus is saved to the taxable
//      account; a shortfall is withdrawn from accounts (taxable, then
//      tax-deferred, then Roth; bucket-plan money before own-fund money),
//      grossed up for tax. On the bucket side, withdrawals come out of
//      capital preservation first, then high income, then equities.
//   4. Refill: after a year equities went UP (or didn't fall), the buckets
//      are reset to their targets for next year. After a year equities FELL,
//      nothing is sold to refill: the plan keeps spending from capital
//      preservation and high income and lets equities recover. (With
//      expected returns every year is an up year, so the plan rebalances
//      yearly.) Rebalancing is treated as tax-free.
//
// Withdrawal taxes:
//   - taxable: capital-gains rate x the gain share of what's sold, where
//     gain share = (value - basis) / value at that moment. Growth raises value
//     but not basis; a sale reduces basis in proportion (average cost).
//   - tax-deferred: ordinary income rate on the whole withdrawal, plus a 10%
//     penalty before age 59 1/2.
//   - Roth: tax-free (withdrawals before 59 1/2 are flagged, not penalized).
//
// Lifespans: you and a spouse each live to the plan-to age; the plan runs
// until the younger of you reaches it. Each person's Social Security and
// healthcare stop after that age; the survivor keeps the larger Social
// Security check (from age 60). Household spending is unchanged after a death.
//
// Not modeled: required minimum distributions (slightly optimistic), Roth
// early-withdrawal rules, tax brackets. Income is entered after tax.
import { grownValue, effectiveGrowthPct } from "./growth.mjs";
import { bucketReturns, bucketTargets, allocate, pvFactor, shares, surplusShares } from "./buckets.mjs";

const MEDICARE_AGE = 65;
// Withdrawals from traditional IRAs / 401(k)s before 59 1/2 carry a 10% penalty.
// A year counts as "before" when you're under 59 1/2 at mid-year (start age < 59).
export const EARLY_WITHDRAWAL_START_AGE = 59;
export const EARLY_WITHDRAWAL_PENALTY_PCT = 10;
// A surviving spouse can collect the late spouse's Social Security from age 60.
export const SURVIVOR_MIN_AGE = 60;

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
 * A scenario overlay. `{}` is the base case.
 * @typedef {Object} ScenarioOverlay
 * @property {number} [spendMult] multiplies category spending (not healthcare)
 */

/**
 * One simulated future's returns: for each year, the actual return of each
 * bucket and a return for each own-fund account (by own-fund index, in
 * account order). Built by montecarlo.mjs.
 * @typedef {{preservation: Float64Array, income: Float64Array, equities: Float64Array, own: Float64Array[]}} ReturnPath
 */

/**
 * @typedef {{preservation: number, income: number, equities: number}} Mix
 *
 * @typedef {Object} YearRow  every $ figure in today's dollars
 * @property {number} year
 * @property {number} age      your age (the plan can run past it when a spouse is younger)
 * @property {number} income   income streams
 * @property {number} ss       social security (post-haircut)
 * @property {number} health   healthcare cost this year
 * @property {number} spend    category spending + health
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

/** @typedef {{pool: "taxable"|"deferred"|"roth", own: boolean, v: number, basis: number, ownRate: number, ownVol: number, ownIdx: number}} Holding */
const POOL_ORDER = /** @type {const} */ (["taxable", "deferred", "roth"]);

/** @param {import("../model/schema.mjs").AccountType} type @returns {"taxable"|"deferred"|"roth"} */
function poolOf(type) {
  if (type === "taxable") return "taxable";
  if (type === "roth_ira") return "roth";
  return "deferred";
}

/**
 * Everything about a plan that doesn't depend on market returns: each year's
 * cash flows, withdrawal needs, bucket targets, and contributions. Computed
 * once and shared by every simulated future (that's what makes 1,000 runs fast).
 * @param {import("../model/schema.mjs").RunwayState} s validated state
 * @param {ScenarioOverlay} [overlay]
 */
export function prepare(s, overlay = {}) {
  const startYear = s.profile.currentYear;
  const endAge = s.profile.endAge;
  const inflPct = s.economy.inflationPct;
  const infl = inflPct / 100;
  const spendMult = overlay.spendMult ?? 1;
  const b = s.buckets;
  const planReturns = bucketReturns(b);
  const ssAnnualSelf = ssAnnualOf(s.social);
  const spouses = (s.household?.people ?? []).filter((p) => p.role === "spouse" && typeof p.currentAge === "number");
  // The plan runs until the youngest of you reaches the plan-to age.
  const years = Math.max(0, endAge - s.profile.currentAge, ...spouses.map((sp) => endAge - /** @type {number} */ (sp.currentAge)));
  const deflators = Array.from({ length: years + 1 }, (_, i) => (1 + infl) ** i); // today's $ -> year-i $

  const flows = [];
  for (let i = 0; i < years; i++) {
    const year = startYear + i;
    const age = s.profile.currentAge + i;
    const d = deflators[i];

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
        ss += spOwn; // the survivor rule applies to the first spouse only
        return;
      }
      if (selfAlive && !spAlive && age >= SURVIVOR_MIN_AGE) ss = Math.max(selfOwn, spBenefit);
      else if (!selfAlive && spAlive && spAge >= SURVIVOR_MIN_AGE) ss = Math.max(spOwn, ssAnnualSelf);
      else ss += spOwn;
    });
    ss *= d;

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
    const spend = categorySpend * spendMult + health;
    flows.push({ year, age, income, ss, health, spend, net: income + ss - spend });
  }

  // What the portfolio must supply at the end of each year, before tax, and
  // what each bucket needs today to cover it (from each year's vantage point).
  const needs = flows.map((f) => Math.max(0, -f.net));
  const factors = [0];
  for (let t = 1; t <= years; t++) factors.push(pvFactor(t, b, planReturns));
  const targetsByYear = Array.from({ length: years + 1 }, (_, i) => bucketTargets(needs, i, factors, b));
  const surplusByYear = Array.from({ length: years + 1 }, (_, i) => surplusShares(years - i, b));

  // Holdings template (copied per run): bucket-plan money pooled by tax type,
  // then one holding per own-fund account.
  /** @type {Holding[]} */
  const holdings = [
    { pool: "taxable", own: false, v: 0, basis: 0, ownRate: 0, ownVol: 0, ownIdx: -1 },
    { pool: "deferred", own: false, v: 0, basis: 0, ownRate: 0, ownVol: 0, ownIdx: -1 },
    { pool: "roth", own: false, v: 0, basis: 0, ownRate: 0, ownVol: 0, ownIdx: -1 },
  ];
  let ownCount = 0;
  const holdingOf = s.accounts.map((a) => {
    const pool = poolOf(a.type);
    const basis = pool === "taxable" ? a.costBasis ?? a.balance : 0;
    if (a.invest === "own") {
      holdings.push({ pool, own: true, v: a.balance, basis, ownRate: a.ownReturnPct / 100, ownVol: (a.ownVolPct ?? 0) / 100, ownIdx: ownCount++ });
      return holdings.length - 1;
    }
    const h = holdings[POOL_ORDER.indexOf(pool)];
    h.v += a.balance;
    h.basis += basis;
    return POOL_ORDER.indexOf(pool);
  });
  const withdrawOrder = holdings
    .map((h, idx) => idx)
    .sort((x, y) => POOL_ORDER.indexOf(holdings[x].pool) - POOL_ORDER.indexOf(holdings[y].pool) || Number(holdings[x].own) - Number(holdings[y].own) || x - y);
  const contribs = flows.map((f, i) => {
    const out = holdings.map(() => 0);
    s.accounts.forEach((a, k) => {
      const perYear = (a.contributionAnnual ?? 0) + (a.employerMatchAnnual ?? 0);
      if (!perYear || i >= (a.contributeYears ?? 0)) return;
      out[holdingOf[k]] += grownValue(perYear, effectiveGrowthPct(a.contributionGrowthPct, inflPct), i);
    });
    return out;
  });

  return {
    s,
    startYear,
    years,
    deflators,
    flows,
    needs,
    targetsByYear,
    surplusByYear,
    holdings,
    withdrawOrder,
    contribs,
    ownCount,
    planReturns,
    ordinaryRate: s.taxes.ordinaryIncomePct / 100,
    gainsRate: s.taxes.capitalGainsPct / 100,
    breachThreshold: s.endState.mode === "floor" ? s.endState.amounts.floor : 0,
  };
}

/** @typedef {ReturnType<typeof prepare>} Prepared */

/**
 * Take `amount` out of the buckets: capital preservation first, then high
 * income, then equities.
 * @param {Mix} B @param {number} amount
 */
function drawFromBuckets(B, amount) {
  for (const k of /** @type {const} */ (["preservation", "income", "equities"])) {
    if (amount <= 0) return;
    const take = Math.min(B[k], amount);
    B[k] -= take;
    amount -= take;
  }
}

/**
 * Add `amount` to the buckets, topping up toward `targets` in order
 * (capital preservation, then high income), with the rest in equities.
 * @param {Mix} B @param {number} amount @param {Mix} targets
 */
function addToBuckets(B, amount, targets) {
  for (const k of /** @type {const} */ (["preservation", "income"])) {
    if (amount <= 0) return;
    const room = Math.max(0, targets[k] - B[k]);
    const put = Math.min(room, amount);
    B[k] += put;
    amount -= put;
  }
  if (amount > 0) B.equities += amount;
}

/**
 * Run one future (expected returns when `path` is omitted).
 * @param {Prepared} P
 * @param {{path?: ReturnPath|null, extraSavingsToday?: number, detail?: boolean}} [opts]
 *   detail: build the per-year rows and path objects (the Monte Carlo loop
 *   skips them for speed and reads `balances` instead).
 */
export function runPlan(P, opts = {}) {
  const { s, years, deflators, flows, targetsByYear, surplusByYear, withdrawOrder, contribs, planReturns, ordinaryRate, gainsRate, breachThreshold } = P;
  const path = opts.path ?? null;
  const detail = opts.detail ?? true;
  const holdings = P.holdings.map((h) => ({ ...h }));
  const managedTaxable = holdings[0];
  if (opts.extraSavingsToday) {
    managedTaxable.v += opts.extraSavingsToday;
    managedTaxable.basis += opts.extraSavingsToday;
  }
  const sumOf = (/** @type {boolean} */ own) => {
    let t = 0;
    for (const h of holdings) if (h.own === own) t += h.v;
    return t;
  };
  /** The target split of `total` bucket-plan dollars at the start of year i. */
  const splitAt = (/** @type {number} */ i, /** @type {number} */ total) => {
    const t = targetsByYear[i];
    const targets = { preservation: t.preservation, income: t.income, equities: Math.max(0, t.equities - Math.max(0, sumOf(true))) };
    return { split: allocate(total, targets, surplusByYear[i]), targets };
  };

  // Start of the plan: the bucket-plan money sits in its target split.
  /** @type {Mix} */
  let B = splitAt(0, Math.max(0, sumOf(false))).split;
  const startMix = { ...B };
  const startOwn = sumOf(true);

  const balances = new Float64Array(years + 1);
  let bal = sumOf(false) + startOwn;
  balances[0] = bal;
  const pathOut = detail ? [{ year: P.startYear, age: s.profile.currentAge, bal }] : [];
  /** @type {YearRow[]} */ const rows = [];
  /** @type {number|null} */ let firstNegYear = null;
  /** @type {number|null} */ let firstBreachYear = null;
  let minBal = bal;
  /** @type {number[]} */ const earlyDeferredYears = [];
  /** @type {number[]} */ const earlyRothYears = [];

  for (let i = 0; i < years; i++) {
    const f = flows[i];
    const d = deflators[i];
    const managedStart = sumOf(false);
    const ownStart = sumOf(true);
    const mix = detail ? shares(B) : B;

    // 1. Returns.
    const rP = path ? path.preservation[i] : planReturns.preservation;
    const rI = path ? path.income[i] : planReturns.income;
    const rE = path ? path.equities[i] : planReturns.equities;
    const bucketsBefore = B.preservation + B.income + B.equities;
    B.preservation *= 1 + rP;
    B.income *= 1 + rI;
    B.equities *= 1 + rE;
    const bucketsAfter = B.preservation + B.income + B.equities;
    // Bucket-plan holdings move with the buckets; a borrowed (negative)
    // balance carries roughly an inflation-level cost.
    const managedFactor = managedStart > 0 && bucketsBefore > 0 ? bucketsAfter / bucketsBefore : 1 + planReturns.preservation;
    for (const h of holdings) {
      if (h.own) h.v *= 1 + (path ? path.own[h.ownIdx][i] : h.ownRate);
      else h.v *= managedFactor;
    }
    const startTotal = managedStart + ownStart;
    const portfolioReturn = startTotal > 0 ? (sumOf(false) + sumOf(true)) / startTotal - 1 : managedFactor - 1;

    // 2. Contributions.
    let contribTotal = 0;
    const c = contribs[i];
    for (let idx = 0; idx < c.length; idx++) {
      if (!c[idx]) continue;
      holdings[idx].v += c[idx];
      if (holdings[idx].pool === "taxable") holdings[idx].basis += c[idx];
      contribTotal += c[idx];
    }

    // 3. Net cash flow.
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

    // Keep the buckets equal to the bucket-plan money: money that left comes
    // out of capital preservation first; money that arrived tops up the
    // safe buckets toward next year's targets first.
    const managedNow = Math.max(0, sumOf(false));
    const delta = managedNow - (B.preservation + B.income + B.equities);
    const next = i + 1;
    if (delta < 0) drawFromBuckets(B, -delta);
    else if (delta > 0) addToBuckets(B, delta, splitAt(next, managedNow).targets);

    // 4. Refill only after a year equities didn't fall.
    if (rE >= 0) B = splitAt(next, managedNow).split;

    bal = (sumOf(false) + sumOf(true)) / deflators[i + 1];
    balances[i + 1] = bal;
    const balYear = f.year + 1;
    if (bal < minBal) minBal = bal;
    if (firstNegYear === null && bal < 0) firstNegYear = balYear;
    if (firstBreachYear === null && bal < breachThreshold) firstBreachYear = balYear;

    if (detail) {
      pathOut.push({ year: balYear, age: f.age + 1, bal });
      rows.push({
        year: f.year,
        age: f.age,
        income: f.income / d,
        ss: f.ss / d,
        health: f.health / d,
        spend: f.spend / d,
        contrib: contribTotal / d,
        withdrawn: withdrawn / d,
        tax: tax / d,
        returnPct: portfolioReturn * 100,
        mix: /** @type {Mix} */ (mix),
        ownBal: ownStart / d,
        bal,
      });
    }
  }

  return {
    path: pathOut,
    rows,
    balances,
    endBal: bal,
    firstNegYear,
    firstBreachYear,
    minBal,
    startYear: P.startYear,
    startMix,
    startOwn,
    earlyDeferredYears,
    earlyRothYears,
  };
}

/**
 * The expected-return plan: every year earns exactly the bucket returns you
 * entered.
 * @param {import("../model/schema.mjs").RunwayState} s validated state
 * @param {ScenarioOverlay} [overlay]
 * @param {number} [extraSavingsToday] extra $ added to the taxable account today (as fresh cash: basis = amount)
 * @returns {SimResult}
 */
export function simulate(s, overlay = {}, extraSavingsToday = 0) {
  return runPlan(prepare(s, overlay), { extraSavingsToday });
}
