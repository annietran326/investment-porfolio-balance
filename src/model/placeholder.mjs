// Obviously fake example data. Ships with the app so the UI is alive on first
// run; NEVER written to disk until the user's first real edit (R13), since a
// saved placeholder would pollute the trend line with fiction forever.
// Shows off: one account of each type, a 401(k) still being contributed to
// (in its own fund), a spouse, and a time-boxed dependent cost.
import { SCHEMA_VERSION, newBuckets, newEconomy, newTaxes, newSimulation } from "./schema.mjs";

/** @returns {import("./schema.mjs").RunwayState} */
export function placeholderState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    profile: { currentAge: 45, endAge: 95, currentYear: 2026 },
    economy: newEconomy(),
    accounts: [
      { name: "Example brokerage", type: "taxable", balance: 600_000, costBasis: 380_000, contributionAnnual: 0, employerMatchAnnual: 0, contributeYears: 0, contributionGrowthPct: null, invest: "buckets", ownReturnPct: 7, ownVolPct: 15 },
      { name: "Example rollover IRA", type: "traditional_ira", balance: 250_000, costBasis: null, contributionAnnual: 0, employerMatchAnnual: 0, contributeYears: 0, contributionGrowthPct: null, invest: "buckets", ownReturnPct: 7, ownVolPct: 15 },
      { name: "Example 401(k)", type: "401k", balance: 180_000, costBasis: null, contributionAnnual: 23_500, employerMatchAnnual: 6_000, contributeYears: 10, contributionGrowthPct: null, invest: "own", ownReturnPct: 7, ownVolPct: 15 },
      { name: "Example Roth IRA", type: "roth_ira", balance: 40_000, costBasis: null, contributionAnnual: 0, employerMatchAnnual: 0, contributeYears: 0, contributionGrowthPct: null, invest: "buckets", ownReturnPct: 7, ownVolPct: 15 },
    ],
    buckets: newBuckets(),
    taxes: newTaxes(),
    incomes: [
      { name: "Example take-home pay", annual: 150_000, fromYear: 2026, toYear: 2035, growthPct: null },
    ],
    spending: [
      { name: "housing (own)", monthly: 3500, fromYear: null, toYear: null, growthPct: null, variable: false },
      { name: "living", monthly: 3000, fromYear: null, toYear: null, growthPct: null, variable: true },
      { name: "travel/fun", monthly: 1200, fromYear: null, toYear: null, growthPct: null, variable: true },
    ],
    social: { startAge: 67, monthly: 2800, haircutPct: 25 },
    health: { preMedicareAnnual: 16_000, postMedicareAnnual: 7_500, employerCoverageUntilAge: 55 },
    household: {
      people: [
        {
          name: "Example Spouse",
          role: "spouse",
          currentAge: 43,
          annualCost: 0,
          fromYear: null,
          toYear: null,
          social: { startAge: 67, monthly: 2000, haircutPct: 25 },
          health: { preMedicareAnnual: 16_000, postMedicareAnnual: 7_500, employerCoverageUntilAge: 55 },
        },
        { name: "Example Dependent (support through 2040)", role: "dependent", currentAge: null, annualCost: 18_000, fromYear: null, toYear: 2040 },
      ],
    },
    endState: { mode: "zero", amounts: { bequest: 0, floor: 0 } },
    simulation: newSimulation(),
  };
}
