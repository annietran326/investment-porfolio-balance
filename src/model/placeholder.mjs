// Obviously fake example data. Ships with the app so the UI is alive on first
// run; NEVER written to disk until the user's first real edit (R13), since a
// saved placeholder would pollute the trend line with fiction forever.
// Shows off the v6 features: one account of each type, a 401(k) still being
// contributed to, a spouse, a time-boxed dependent cost, and a rental.
import { SCHEMA_VERSION, newBuckets, newEconomy, newTaxes } from "./schema.mjs";

/** @returns {import("./schema.mjs").RunwayState} */
export function placeholderState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    profile: { currentAge: 45, endAge: 95, currentYear: 2026 },
    economy: newEconomy(),
    accounts: [
      { name: "Example brokerage", type: "taxable", balance: 600_000, costBasis: 380_000, contributionAnnual: 0, employerMatchAnnual: 0, contributeUntilAge: null, contributionGrowthPct: null },
      { name: "Example rollover IRA", type: "traditional_ira", balance: 250_000, costBasis: null, contributionAnnual: 0, employerMatchAnnual: 0, contributeUntilAge: null, contributionGrowthPct: null },
      { name: "Example 401(k)", type: "401k", balance: 180_000, costBasis: null, contributionAnnual: 23_500, employerMatchAnnual: 6_000, contributeUntilAge: 55, contributionGrowthPct: null },
      { name: "Example Roth IRA", type: "roth_ira", balance: 40_000, costBasis: null, contributionAnnual: 0, employerMatchAnnual: 0, contributeUntilAge: null, contributionGrowthPct: null },
    ],
    buckets: newBuckets(),
    taxes: newTaxes(),
    properties: [
      {
        name: "Example rental (keeping)",
        rentMonthly: 2800,
        costsMonthly: 800,
        mortgageMonthly: 1900,
        payoffYear: 2047,
        saleYear: null,
        saleNetProceeds: null,
        rentGrowthPct: 3.5,
        costsGrowthPct: null,
      },
    ],
    incomes: [
      { name: "Example take-home pay", annual: 150_000, fromYear: 2026, toYear: 2035, growthPct: null },
    ],
    spending: [
      { name: "housing (own)", monthly: 3500, fromYear: null, toYear: null, growthPct: null },
      { name: "living", monthly: 3000, fromYear: null, toYear: null, growthPct: null },
      { name: "travel/fun", monthly: 1200, fromYear: null, toYear: null, growthPct: null },
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
    work: { untilAge: 55 },
  };
}
