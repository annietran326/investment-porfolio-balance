// Monte Carlo: run the plan through many random futures and report how often
// it succeeds, the range of outcomes, and the gap to a target success rate.
// Pure and REPEATABLE: the random numbers come from a fixed seed, so the same
// inputs always give the same answer (numbers don't jump as you edit), and
// every solver step reuses the same futures, so comparisons are fair.
//
// How a year's returns are drawn:
//   - Each bucket's yearly return is lognormal. The rate you entered is its
//     MEDIAN (the long-run compound average), so a typical future lines up
//     with the expected-return plan; the "swing" (volatility) you entered
//     sets how far a year strays: in about 2 years out of 3 a bucket lands
//     within one swing of its rate.
//   - Global equities and high income tend to move together (correlation
//     0.5); capital preservation moves on its own. An own-fund account (a
//     target-date fund) follows equities closely (correlation 0.9).
//   - Inflation is fixed.
import { prepare, runPlan } from "./simulate.mjs";
import { goalMet } from "./solver.mjs";

export const MC_RUNS = 1000;
export const MC_SEED = 20260928;
export const EQUITY_INCOME_CORRELATION = 0.5;
export const OWN_FUND_EQUITY_CORRELATION = 0.9;
// The gap search's ceiling: more than $50M short is "unreachable".
export const MC_GAP_CAP = 50_000_000;
export const MC_GAP_ROUND_TO = 1000;

/** mulberry32: a small, fast, seedable random generator. @param {number} seed */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draws via Box–Muller. @param {() => number} rand */
function normals(rand) {
  /** @type {number|null} */ let spare = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    while (u <= Number.EPSILON) u = rand();
    const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

/**
 * A lognormal yearly return with the given median rate and swing.
 * @param {number} rate median, decimal @param {number} vol swing, decimal @param {number} z standard normal
 */
export function drawReturn(rate, vol, z) {
  if (!vol) return rate;
  const sigma = vol / (1 + rate); // the swing, in log terms
  return (1 + rate) * Math.exp(sigma * z) - 1;
}

/**
 * The random futures for a plan: `runs` paths of `years` returns each.
 * @param {import("./simulate.mjs").Prepared} P
 * @param {{runs?: number, seed?: number}} [opts]
 * @returns {import("./simulate.mjs").ReturnPath[]}
 */
export function makePaths(P, opts = {}) {
  const runs = opts.runs ?? MC_RUNS;
  const z = normals(rng(opts.seed ?? MC_SEED));
  const b = P.s.buckets;
  const own = P.holdings.filter((h) => h.own);
  const rho = EQUITY_INCOME_CORRELATION;
  const rhoOwn = OWN_FUND_EQUITY_CORRELATION;
  const paths = [];
  for (let r = 0; r < runs; r++) {
    const pres = new Float64Array(P.years);
    const inc = new Float64Array(P.years);
    const eq = new Float64Array(P.years);
    const ownRets = own.map(() => new Float64Array(P.years));
    for (let i = 0; i < P.years; i++) {
      const zEq = z();
      const zInc = rho * zEq + Math.sqrt(1 - rho * rho) * z();
      const zPres = z();
      eq[i] = drawReturn(b.equitiesReturnPct / 100, b.equitiesVolPct / 100, zEq);
      inc[i] = drawReturn(b.incomeReturnPct / 100, b.incomeVolPct / 100, zInc);
      pres[i] = drawReturn(b.preservationReturnPct / 100, b.preservationVolPct / 100, zPres);
      own.forEach((h, k) => {
        const zOwn = rhoOwn * zEq + Math.sqrt(1 - rhoOwn * rhoOwn) * z();
        ownRets[k][i] = drawReturn(h.ownRate, h.ownVol, zOwn);
      });
    }
    paths.push({ preservation: pres, income: inc, equities: eq, own: ownRets });
  }
  return paths;
}

/** The value at a quantile q (0..1) of an ascending-sorted array. @param {Float64Array} sorted @param {number} q */
function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * @typedef {Object} MonteCarloResult
 * @property {number} runs
 * @property {number} successRate share of futures that reach the goal (0..1)
 * @property {{year: number, age: number, p50: number, p80: number, p90: number}[]} bands
 *   balance by year (today's $): p50 = the middle future; p80 = 80% of futures
 *   end the year at least this high; p90 = 90% of futures at least this high
 * @property {{p50: number, p80: number, p90: number}} end ending balance, same meaning
 */

/**
 * Run a plan through the random futures.
 * @param {import("./simulate.mjs").Prepared} P
 * @param {import("./simulate.mjs").ReturnPath[]} paths
 * @param {number} [extraSavingsToday]
 * @param {{bands?: boolean}} [opts] bands: also compute the outcome lines (skipped inside the gap search)
 * @returns {MonteCarloResult}
 */
export function runFutures(P, paths, extraSavingsToday = 0, opts = {}) {
  const wantBands = opts.bands ?? true;
  const years = P.years;
  let ok = 0;
  const cols = wantBands ? Array.from({ length: years + 1 }, () => new Float64Array(paths.length)) : [];
  paths.forEach((path, r) => {
    const res = runPlan(P, { path, extraSavingsToday, detail: false });
    if (goalMet(P.s, /** @type {any} */ (res))) ok++;
    if (wantBands) for (let i = 0; i <= years; i++) cols[i][r] = res.balances[i];
  });
  const bands = [];
  if (wantBands) {
    for (let i = 0; i <= years; i++) {
      const sorted = cols[i].sort();
      bands.push({
        year: P.startYear + i,
        age: P.s.profile.currentAge + i,
        p50: quantile(sorted, 0.5),
        p80: quantile(sorted, 0.2),
        p90: quantile(sorted, 0.1),
      });
    }
  }
  const last = bands.at(-1);
  return {
    runs: paths.length,
    successRate: paths.length ? ok / paths.length : 0,
    bands,
    end: last ? { p50: last.p50, p80: last.p80, p90: last.p90 } : { p50: 0, p80: 0, p90: 0 },
  };
}

/**
 * The Monte Carlo gap: the smallest extra amount (today's $), invested today
 * in the recommended split, that makes the plan succeed in at least
 * `targetPct` of the futures.
 * @param {import("./simulate.mjs").Prepared} P
 * @param {import("./simulate.mjs").ReturnPath[]} paths
 * @param {number} targetPct e.g. 90
 * @returns {import("./solver.mjs").GapResult}
 */
export function gapToTarget(P, paths, targetPct) {
  const target = targetPct / 100;
  const succeeds = (/** @type {number} */ x) => runFutures(P, paths, x, { bands: false }).successRate >= target - 1e-12;
  if (succeeds(0)) return { kind: "met" };
  // Grow the bracket from a small guess (fewer steps than starting at the cap).
  let lo = 0;
  let hi = 100_000;
  while (!succeeds(hi)) {
    lo = hi;
    hi *= 2;
    if (hi > MC_GAP_CAP) {
      if (!succeeds(MC_GAP_CAP)) return { kind: "unreachable", cap: MC_GAP_CAP };
      hi = MC_GAP_CAP;
      break;
    }
  }
  while (hi - lo > Math.max(MC_GAP_ROUND_TO / 2, hi * 0.002)) {
    const mid = (lo + hi) / 2;
    if (succeeds(mid)) hi = mid;
    else lo = mid;
  }
  return { kind: "value", amount: Math.ceil(hi / MC_GAP_ROUND_TO) * MC_GAP_ROUND_TO };
}

/**
 * Everything the results panel needs for one scenario.
 * @param {import("../model/schema.mjs").RunwayState} s
 * @param {import("./simulate.mjs").ScenarioOverlay} [overlay]
 * @param {{runs?: number, seed?: number}} [opts]
 */
export function monteCarlo(s, overlay = {}, opts = {}) {
  const P = prepare(s, overlay);
  const paths = makePaths(P, opts);
  const result = runFutures(P, paths, 0);
  const gap = gapToTarget(P, paths, s.simulation.targetSuccessPct);
  return { ...result, gap };
}
