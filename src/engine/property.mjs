// Per-property yearly cash flow. Pure — no clock, no I/O; the simulation year
// and all overlay knobs arrive as arguments.
import { grownValue, effectiveGrowthPct } from "./growth.mjs";

// Sale-year convention: the property is owned for half the sale year (sell
// mid-year), so 6 months of rent/costs/mortgage book alongside the proceeds.
// A named constant so the convention is visible and testable, not folklore.
export const SALE_YEAR_OWNED_MONTHS = 6;

/**
 * Scenario knobs threaded into property cash flow.
 * @typedef {Object} PropertyOverlay
 * @property {number} [saleDelayYears]   shift every sale year later (stress: delayed sale)
 * @property {number} [vacancyMonths]    vacancy months per year during the vacancy window
 * @property {number} [vacancyYears]     length of the vacancy window from simulation start
 * @property {number} [startYear]        simulation start (anchors the vacancy window)
 * @property {number} [inflationPct]     inflation, %/yr: blank growth rates follow it and
 *                                       sale proceeds (entered in today's $) rise with it
 */

/**
 * Cash flow and sale proceeds for one property in one calendar year.
 *
 * Semantics (pinned by tests):
 *   - Sale proceeds are booked exactly once, in the (possibly delayed) sale year.
 *   - After the sale year: no cash flow, no proceeds.
 *   - Mortgage P&I is paid THROUGH the payoff year and stops after it,
 *     independent of any sale. P&I is a fixed dollar payment, and the
 *     simulation runs in actual dollars, so it correctly stays flat while
 *     everything else rises with inflation.
 *   - All amounts returned are in that year's actual dollars.
 *   - A sale year already in the past (before the simulation window) never
 *     books proceeds — in ANY scenario, saleDelayYears included — validation
 *     warns about this upstream.
 *
 * @param {import("../model/schema.mjs").Property} p
 * @param {number} year
 * @param {PropertyOverlay} [overlay]
 * @returns {{cf: number, proceeds: number}}
 */
export function propertyCashflowYear(p, year, overlay = {}) {
  // A sale predating the simulation window stays sold in every scenario — saleDelayYears must never resurrect it.
  const pastSale = p.saleYear !== null && typeof overlay.startYear === "number" && p.saleYear < overlay.startYear;
  const saleYear = p.saleYear === null ? null : pastSale ? p.saleYear : p.saleYear + (overlay.saleDelayYears ?? 0);
  if (saleYear !== null && year > saleYear) return { cf: 0, proceeds: 0 };

  const inflationPct = overlay.inflationPct ?? 0;
  const yfs = typeof overlay.startYear === "number" ? year - overlay.startYear : 0;
  // Proceeds are entered in today's dollars; the sale lands in future dollars.
  const proceeds = saleYear !== null && year === saleYear ? grownValue(p.saleNetProceeds ?? 0, inflationPct, yfs) : 0;
  const ownedMonths = saleYear !== null && year === saleYear ? SALE_YEAR_OWNED_MONTHS : 12;

  let vacancyMonths = 0;
  const { vacancyMonths: vm = 0, vacancyYears: vy = 0, startYear } = overlay;
  if (vm > 0 && vy > 0 && typeof startYear === "number" && year - startYear < vy) {
    vacancyMonths = vm;
  }

  // Rent and costs grow at their own rates (blank = inflation), compounding from
  // the current year. Mortgage P&I is a fixed dollar amount, so it does NOT grow.
  const rentM = grownValue(p.rentMonthly, effectiveGrowthPct(p.rentGrowthPct, inflationPct), yfs);
  const costM = grownValue(p.costsMonthly, effectiveGrowthPct(p.costsGrowthPct, inflationPct), yfs);

  const rent = rentM * Math.max(0, ownedMonths - vacancyMonths);
  const costs = costM * ownedMonths;
  const mortgage = p.payoffYear !== null && year > p.payoffYear ? 0 : p.mortgageMonthly * ownedMonths;

  return { cf: rent - costs - mortgage, proceeds };
}
