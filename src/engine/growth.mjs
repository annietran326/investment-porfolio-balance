// Growth in actual (nominal) dollars. A value entered in today's dollars grows
// from the current year at its own rate, or at inflation when its rate is
// blank (null). `yearsFromStart` is the simulation year offset (0 at currentYear).

/**
 * The rate a line actually grows at: its own, or inflation when blank.
 * @param {number|null|undefined} growthPct
 * @param {number} inflationPct
 */
export function effectiveGrowthPct(growthPct, inflationPct) {
  return typeof growthPct === "number" ? growthPct : inflationPct;
}

/**
 * @param {number} base value in today's dollars at the current year
 * @param {number} growthPct actual growth, %/yr
 * @param {number} yearsFromStart offset from the current year (>= 0 in practice)
 * @returns {number} the value in that year's actual dollars
 */
export function grownValue(base, growthPct, yearsFromStart) {
  if (!growthPct || !yearsFromStart) return base;
  return base * (1 + growthPct / 100) ** yearsFromStart;
}
