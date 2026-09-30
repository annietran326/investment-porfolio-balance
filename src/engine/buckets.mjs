// The three-bucket split: how much of the portfolio belongs in capital
// preservation, high income, and global equities. Pure.
//
// The rule is time-based, the way a bucket strategy works in practice:
//   - money you'll withdraw in the next `preservationYears` years sits in
//     capital preservation, so a market drop never forces a sale of stocks;
//   - money for years preservationYears+1 through `incomeThroughYear` sits in
//     high income;
//   - money needed further out sits in global equities, which have the most
//     time to recover.
//
// Each future withdrawal is valued at what it costs TODAY, following the path
// its dollars actually take: they wait in equities until they are
// `incomeThroughYear` years away, move to high income, then to capital
// preservation for the final `preservationYears` years. (A withdrawal 20 years
// out with cutoffs 8/15 spends 5 years in equities, 7 in high income, and 8 in
// capital preservation.)
//
// Filling order: capital preservation gets the next `preservationYears` of
// withdrawals, high income gets the years after that through
// `incomeThroughYear`, and everything else goes to equities. The same rule
// applies every year to the end of the plan (the split is redone each year as
// withdrawals get closer).
// So capital preservation is a fixed cushion (like an advisor's "8 years of
// spending in cash-like assets"), never a share of the total. A portfolio
// short of the full need is short in the later buckets first, and the gap
// shows how much more would fill them.

export const BUCKET_KEYS = /** @type {const} */ (["preservation", "income", "equities"]);
export const BUCKET_LABELS = {
  preservation: "Capital preservation",
  income: "High income",
  equities: "Global equities",
};

/**
 * @typedef {{preservation: number, income: number, equities: number}} BucketAmounts
 */

/**
 * The bucket returns as decimals (e.g. 0.095), from the state's percentages.
 * @param {import("../model/schema.mjs").Buckets} b
 * @returns {BucketAmounts}
 */
export function bucketReturns(b) {
  return {
    preservation: b.preservationReturnPct / 100,
    income: b.incomeReturnPct / 100,
    equities: b.equitiesReturnPct / 100,
  };
}

/**
 * Which bucket holds money needed `t` years from now (t >= 1).
 * @param {number} t @param {import("../model/schema.mjs").Buckets} b
 * @returns {"preservation"|"income"|"equities"}
 */
export function bucketFor(t, b) {
  if (t <= b.preservationYears) return "preservation";
  if (t <= b.incomeThroughYear) return "income";
  return "equities";
}

/**
 * What $1 needed `t` years from now costs today, given the path those dollars
 * take through the buckets (see the header comment).
 * @param {number} t @param {import("../model/schema.mjs").Buckets} b @param {BucketAmounts} r
 */
export function pvFactor(t, b, r) {
  const p = b.preservationYears;
  const m = b.incomeThroughYear;
  const yearsPres = Math.min(t, p);
  const yearsInc = Math.max(0, Math.min(t, m) - p);
  const yearsEq = Math.max(0, t - m);
  return 1 / ((1 + r.preservation) ** yearsPres * (1 + r.income) ** yearsInc * (1 + r.equities) ** yearsEq);
}

/**
 * The dollars each bucket needs today to fund every future withdrawal.
 * @param {number[]} needs    withdrawal needed at the END of each simulation year (actual $, >= 0)
 * @param {number} fromIdx    the year we're standing at the start of
 * @param {number[]} factors  factors[t] = pvFactor(t, ...) for t = 1..needs.length
 * @param {import("../model/schema.mjs").Buckets} b
 * @returns {BucketAmounts}
 */
export function bucketTargets(needs, fromIdx, factors, b) {
  /** @type {BucketAmounts} */
  const out = { preservation: 0, income: 0, equities: 0 };
  for (let j = fromIdx; j < needs.length; j++) {
    const need = needs[j];
    if (!(need > 0)) continue;
    const t = j - fromIdx + 1;
    out[bucketFor(t, b)] += need * factors[t];
  }
  return out;
}

/**
 * Split a portfolio across the buckets: fill capital preservation's target,
 * then high income's, then equities'; anything beyond the total need goes
 * to equities too.
 * @param {number} total portfolio value (<= 0 means nothing to split)
 * @param {BucketAmounts} targets
 * @returns {BucketAmounts} dollars per bucket, summing to max(total, 0)
 */
export function allocate(total, targets) {
  if (!(total > 0)) return { preservation: 0, income: 0, equities: 0 };
  const preservation = Math.min(total, targets.preservation);
  const income = Math.min(total - preservation, targets.income);
  return { preservation, income, equities: total - preservation - income };
}

/**
 * Dollars per bucket -> shares that sum to 1 (all zero for an empty portfolio).
 * @param {BucketAmounts} dollars
 * @returns {BucketAmounts}
 */
export function shares(dollars) {
  const total = dollars.preservation + dollars.income + dollars.equities;
  if (!(total > 0)) return { preservation: 0, income: 0, equities: 0 };
  return { preservation: dollars.preservation / total, income: dollars.income / total, equities: dollars.equities / total };
}
