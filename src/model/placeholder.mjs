// Obviously fake example data. Ships with the app so the UI is alive on first
// run; NEVER written to disk until the user's first real edit (R13) — a saved
// placeholder would pollute the trend line with fiction forever.
import { SCHEMA_VERSION } from "./schema.mjs";

/** @returns {import("./schema.mjs").RunwayState} */
export function placeholderState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    profile: { currentAge: 40, endAge: 95, currentYear: 2026 },
    portfolio: { balance: 1_500_000, realReturnPct: 3.5 },
    properties: [
      {
        name: "Example Rental A (selling next year)",
        rentMonthly: 3200,
        costsMonthly: 900,
        mortgageMonthly: 2400,
        payoffYear: 2049,
        saleYear: 2027,
        saleNetProceeds: 250_000,
      },
      {
        name: "Example Rental B (keeping)",
        rentMonthly: 2800,
        costsMonthly: 800,
        mortgageMonthly: 1900,
        payoffYear: 2047,
        saleYear: null,
        saleNetProceeds: null,
      },
    ],
    incomes: [
      { name: "Example W2 (last year)", annual: 180_000, fromYear: 2026, toYear: 2026 },
      { name: "Example side business", annual: 40_000, fromYear: 2026, toYear: 2030 },
    ],
    spending: [
      { name: "housing (own)", monthly: 3500 },
      { name: "living", monthly: 2500 },
      { name: "travel/fun", monthly: 1200 },
    ],
    social: { startAge: 67, monthly: 2800, haircutPct: 25 },
    health: { preMedicareAnnual: 16_000, postMedicareAnnual: 7_500, employerCoverageUntilAge: 40 },
    endState: { mode: "zero", amounts: { bequest: 0, floor: 0 } },
    work: { untilAge: 50 },
  };
}
