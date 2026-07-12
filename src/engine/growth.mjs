// Real growth: how a line's value in today's dollars changes over time relative
// to inflation. 0 = grows with inflation (holds constant in real terms — the
// default and the whole v1 behavior). Compounds from the current year, so
// `yearsFromStart` is the simulation year offset (0 at currentYear).

/**
 * @param {number} base value in today's dollars at the current year
 * @param {number} realGrowthPct real growth vs inflation, %/yr
 * @param {number} yearsFromStart offset from the current year (>= 0 in practice)
 * @returns {number}
 */
export function grownValue(base, realGrowthPct, yearsFromStart) {
  const g = realGrowthPct ?? 0;
  if (g === 0) return base; // exact identity for the default — zero drift vs v1
  return base * (1 + g / 100) ** yearsFromStart;
}
