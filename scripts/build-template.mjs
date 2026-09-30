// The XLSX template's single source of truth (U8). TEMPLATE_DEF describes
// every tab, column, unit, and assumption key; src/import/template.mjs imports
// it, so the parser and the generated template can never drift apart.
//
// Run directly (`node scripts/build-template.mjs`) to regenerate
// template/runway-template.xlsx from the schema defaults. This is an optional
// maintenance tool — it is NOT part of npm start or npm test.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {Object} ColumnDef
 * @property {string} header   carries the unit — this exact text is matched on import
 * @property {string} field    state field the column maps to; may be dotted for
 *   nested household fields (e.g. "social.startAge")
 * @property {"text"|"number"} type
 * @property {boolean} [nullable] empty cell → null (meaningful), NEVER 0
 * @property {boolean} [emptyZero] empty cell → 0 (e.g. a support cost or a
 *   contribution). Distinct from nullable, where empty means "open" / "with inflation".
 * @property {string[]} [choices] text column that must be one of these values
 * @property {boolean} [bool] a yes/no column stored as true/false
 * @property {boolean} [optional] column may be absent from an imported sheet
 * @property {"spouse"} [role] household column that applies only to this role;
 *   a dependent row leaves it blank
 * @property {string} [zeroError] error message when the cell holds 0 (sale year)
 *
 * @typedef {Object} SettingDef
 * @property {string} key   dotted state path ("endState.bequest" → endState.amounts.bequest)
 * @property {"number"|"mode"} type
 * @property {string} doc   unit / notes column text
 *
 * @typedef {Object} TabDef
 * @property {"accounts"|"income"|"spending"|"household"|"assumptions"} key
 * @property {string} name  sheet name (matched case-insensitively on import)
 * @property {"list"|"household"|"settings"} kind
 * @property {"accounts"|"incomes"|"spending"} [section] state array for list tabs
 * @property {ColumnDef[]} columns
 * @property {SettingDef[]} [settings]
 * @property {string} [note] comment row ("#" prefix — ignored by the parser)
 */

/** @type {{tabs: TabDef[]}} */
export const TEMPLATE_DEF = {
  tabs: [
    {
      key: "accounts",
      name: "Accounts",
      kind: "list",
      section: "accounts",
      columns: [
        { header: "Name", field: "name", type: "text" },
        { header: "Type (taxable, traditional_ira, 401k, roth_ira)", field: "type", type: "text", choices: ["taxable", "traditional_ira", "401k", "roth_ira"] },
        { header: "Balance $", field: "balance", type: "number" },
        { header: "Cost basis $ (taxable only; blank = same as balance)", field: "costBasis", type: "number", nullable: true, optional: true },
        { header: "Your contribution $/yr", field: "contributionAnnual", type: "number", emptyZero: true, optional: true },
        { header: "Employer match $/yr", field: "employerMatchAnnual", type: "number", emptyZero: true, optional: true },
        { header: "Contribute for how many more years", field: "contributeYears", type: "number", emptyZero: true, optional: true },
        { header: "Contribution increase %/yr (blank = inflation)", field: "contributionGrowthPct", type: "number", nullable: true, optional: true },
        { header: "Invested in (buckets or own)", field: "invest", type: "text", choices: ["buckets", "own"], optional: true },
        { header: "Own fund return %/yr (used when invested in own)", field: "ownReturnPct", type: "number", optional: true },
        { header: "Own fund swing %/yr (used when invested in own)", field: "ownVolPct", type: "number", optional: true },
        { header: "Owner (self or spouse; for RMDs)", field: "owner", type: "text", choices: ["self", "spouse"], optional: true },
      ],
    },
    {
      key: "income",
      name: "Income",
      kind: "list",
      section: "incomes",
      columns: [
        { header: "Name", field: "name", type: "text" },
        { header: "Net $/yr", field: "annual", type: "number" },
        { header: "From year", field: "fromYear", type: "number" },
        { header: "To year", field: "toYear", type: "number" },
        { header: "Increase %/yr (blank = inflation)", field: "growthPct", type: "number", nullable: true, optional: true },
      ],
    },
    {
      key: "spending",
      name: "Spending",
      kind: "list",
      section: "spending",
      columns: [
        { header: "Name", field: "name", type: "text" },
        { header: "$/mo (excl. healthcare)", field: "monthly", type: "number" },
        { header: "From year (blank = from start)", field: "fromYear", type: "number", nullable: true, optional: true },
        { header: "To year (blank = perpetual)", field: "toYear", type: "number", nullable: true, optional: true },
        { header: "Increase %/yr (blank = inflation)", field: "growthPct", type: "number", nullable: true, optional: true },
        { header: "Variable (yes/no)", field: "variable", type: "text", choices: ["yes", "no"], bool: true, optional: true },
      ],
    },
    {
      key: "household",
      name: "Household",
      kind: "household",
      columns: [
        { header: "Name", field: "name", type: "text" },
        { header: "Role (spouse or dependent)", field: "role", type: "text" },
        { header: "Current age", field: "currentAge", type: "number", nullable: true },
        // Support cost: a dependent's ONGOING cost over a window (raising a kid,
        // supporting a parent), in today's $/yr. The cost defaults to 0 (like a
        // growth rate) when blank; the window years are nullable (blank = open —
        // from-start / whole-plan, never 0, same as sale year). Spouses leave the
        // cost 0 and both years blank.
        { header: "Support cost $/yr", field: "annualCost", type: "number", emptyZero: true, optional: true },
        { header: "From year", field: "fromYear", type: "number", nullable: true, optional: true },
        { header: "Through year", field: "toYear", type: "number", nullable: true, optional: true },
        // spouse-only: a dependent row leaves these blank. Optional so a minimal
        // Household sheet (Name/Role/Age only) still imports dependents.
        { header: "SS start age", field: "social.startAge", type: "number", nullable: true, optional: true, role: "spouse" },
        { header: "SS $/mo (pre-haircut)", field: "social.monthly", type: "number", nullable: true, optional: true, role: "spouse" },
        { header: "SS haircut %", field: "social.haircutPct", type: "number", nullable: true, optional: true, role: "spouse" },
        { header: "Health pre-65 $/yr", field: "health.preMedicareAnnual", type: "number", nullable: true, optional: true, role: "spouse" },
        { header: "Health 65+ $/yr", field: "health.postMedicareAnnual", type: "number", nullable: true, optional: true, role: "spouse" },
        { header: "Employer coverage until age", field: "health.employerCoverageUntilAge", type: "number", nullable: true, optional: true, role: "spouse" },
      ],
    },
    {
      key: "assumptions",
      name: "Assumptions",
      kind: "settings",
      columns: [
        { header: "Setting", field: "key", type: "text" },
        { header: "Value", field: "value", type: "number" },
        { header: "Unit / notes", field: "doc", type: "text", optional: true },
      ],
      settings: [
        { key: "profile.currentAge", type: "number", doc: "years" },
        { key: "profile.endAge", type: "number", doc: "plan-to age (years)" },
        { key: "profile.currentYear", type: "number", doc: "simulation clock origin (calendar year)" },
        { key: "economy.inflationPct", type: "number", doc: "inflation %/yr (plain number, 2.5 = 2.5%)" },
        { key: "buckets.preservationReturnPct", type: "number", doc: "capital preservation return %/yr, before inflation" },
        { key: "buckets.incomeReturnPct", type: "number", doc: "high income return %/yr, before inflation" },
        { key: "buckets.equitiesReturnPct", type: "number", doc: "global equities return %/yr, before inflation" },
        { key: "buckets.preservationYears", type: "number", doc: "years of withdrawals held in capital preservation (years 1 to N)" },
        { key: "buckets.incomeThroughYear", type: "number", doc: "high income holds years N+1 through this year; equities hold the rest" },
        { key: "buckets.preservationVolPct", type: "number", doc: "capital preservation's typical yearly swing %, for the simulation" },
        { key: "buckets.incomeVolPct", type: "number", doc: "high income's typical yearly swing %" },
        { key: "buckets.equitiesVolPct", type: "number", doc: "global equities' typical yearly swing %" },
        { key: "simulation.targetSuccessPct", type: "number", doc: "the plan should work in this % of simulated futures (the gap aims for it)" },
        { key: "simulation.spendMorePct", type: "number", doc: "spend more scenario: % increase on variable spending lines" },
        { key: "taxes.ordinaryIncomePct", type: "number", doc: "effective tax % on traditional IRA / 401(k) withdrawals (federal + state)" },
        { key: "taxes.capitalGainsPct", type: "number", doc: "effective tax % on gains when selling in a taxable account (federal + state)" },
        { key: "social.startAge", type: "number", doc: "Social Security start age (years)" },
        { key: "social.monthly", type: "number", doc: "Social Security $/mo, today's dollars, pre-haircut" },
        { key: "social.haircutPct", type: "number", doc: "% cut applied to Social Security (plain number, 25 = 25%)" },
        { key: "health.preMedicareAnnual", type: "number", doc: "healthcare $/yr before 65, after employer coverage ends" },
        { key: "health.postMedicareAnnual", type: "number", doc: "healthcare $/yr from age 65" },
        { key: "health.employerCoverageUntilAge", type: "number", doc: "age employer health coverage ends" },
        { key: "endState.mode", type: "mode", doc: "one of: zero, bequest, floor" },
        { key: "endState.bequest", type: "number", doc: "$ to leave (used when mode is bequest)" },
        { key: "endState.floor", type: "number", doc: "$ the balance never drops below (used when mode is floor)" },
      ],
      note: "# Amounts are in today's dollars; rates are actual (before inflation)",
    },
  ],
};

// --- maintenance entry point ------------------------------------------------
// template.mjs statically imports TEMPLATE_DEF from this file, so the writer
// must import template.mjs DYNAMICALLY and must NOT block this module's
// evaluation (no top-level await) — otherwise the circular import deadlocks.
async function main() {
  const { buildTemplateWorkbook } = await import("../src/import/template.mjs");
  const { defaultState } = await import("../src/model/schema.mjs");
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "template", "runway-template.xlsx");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buildTemplateWorkbook(defaultState()));
  process.stdout.write(`wrote ${out}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`build-template failed: ${e instanceof Error ? e.stack : e}\n`);
    process.exitCode = 1;
  });
}
