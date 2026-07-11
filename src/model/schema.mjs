// The domain model: every entity, every default, and validation.
// Conventions that are load-bearing across the app:
//   - All amounts are in TODAY'S dollars. Returns are real (after inflation and tax).
//   - `saleYear: null` means "keep this property forever". Empty is meaningful;
//     0 is an error, never coerced. Import parsers must preserve this distinction.
//   - Defaults live HERE, once. No `||`-style fallbacks at use sites — code either
//     receives a validated state or rejects it.

export const SCHEMA_VERSION = 1;

/**
 * @typedef {Object} Profile
 * @property {number} currentAge
 * @property {number} endAge     plan-to age (presets 90/95/100)
 * @property {number} currentYear simulation clock origin — the engine never reads Date
 *
 * @typedef {Object} Portfolio
 * @property {number} balance        liquid + invested, single bucket
 * @property {number} realReturnPct  real (after inflation and tax) %/yr
 *
 * @typedef {Object} Property
 * @property {string} name
 * @property {number} rentMonthly
 * @property {number} costsMonthly   tax/insurance/HOA/maintenance, excl. mortgage
 * @property {number} mortgageMonthly P&I; fixed NOMINAL — real cost overstated late (documented bias)
 * @property {number|null} payoffYear mortgage ends after this year; null = never (interest-only/none)
 * @property {number|null} saleYear   null = keep forever
 * @property {number|null} saleNetProceeds net cash after payoff, costs, taxes
 *
 * @typedef {Object} Income
 * @property {string} name
 * @property {number} annual   net of tax, today's $
 * @property {number} fromYear
 * @property {number} toYear   inclusive
 *
 * @typedef {Object} SpendingCategory
 * @property {string} name
 * @property {number} monthly  excl. property costs and healthcare (modeled separately)
 *
 * @typedef {Object} Social
 * @property {number} startAge
 * @property {number} monthly    today's $, pre-haircut
 * @property {number} haircutPct trust-fund-depletion discount (2026 default: 25)
 *
 * @typedef {Object} Health
 * @property {number} preMedicareAnnual  pre-65 bridge, applies after employer coverage ends
 * @property {number} postMedicareAnnual 65+
 * @property {number} employerCoverageUntilAge
 *
 * @typedef {"zero"|"bequest"|"floor"} EndStateMode
 * @typedef {Object} EndState
 * @property {EndStateMode} mode
 * @property {{bequest: number, floor: number}} amounts amount per mode, preserved across switches
 *
 * @typedef {Object} Work
 * @property {number} untilAge willing-to-work-until age — the solver's income window
 *
 * @typedef {Object} RunwayState
 * @property {number} schemaVersion
 * @property {Profile} profile
 * @property {Portfolio} portfolio
 * @property {Property[]} properties
 * @property {Income[]} incomes
 * @property {SpendingCategory[]} spending
 * @property {Social} social
 * @property {Health} health
 * @property {EndState} endState
 * @property {Work} work
 */

// Research-grounded 2026 defaults (all user-editable; vintage documented in README):
// SS haircut 25% (Trustees Report: 22–28% cut at 2032), pre-65 healthcare $16K/yr
// (unsubsidized ACA anchor), Medicare-age $7,500/yr, real return 3.5%.
/** @returns {RunwayState} */
export function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    profile: { currentAge: 40, endAge: 95, currentYear: 2026 },
    portfolio: { balance: 0, realReturnPct: 3.5 },
    properties: [],
    incomes: [],
    spending: [],
    social: { startAge: 67, monthly: 0, haircutPct: 25 },
    health: { preMedicareAnnual: 16000, postMedicareAnnual: 7500, employerCoverageUntilAge: 40 },
    endState: { mode: "zero", amounts: { bequest: 0, floor: 0 } },
    work: { untilAge: 50 },
  };
}

export const END_STATE_MODES = /** @type {EndStateMode[]} */ (["zero", "bequest", "floor"]);
export const PLAN_TO_AGE_PRESETS = [90, 95, 100];

/**
 * @typedef {{path: string, message: string}} Issue
 * @typedef {{errors: Issue[], warnings: Issue[]}} ValidationResult
 */

/** @param {Issue[]} list @param {string} path @param {string} message */
function add(list, path, message) {
  list.push({ path, message });
}

/**
 * @param {Issue[]} errors @param {unknown} v @param {string} path
 * @returns {v is number}
 */
function requireNumber(errors, v, path) {
  if (typeof v !== "number" || Number.isNaN(v)) {
    add(errors, path, `must be a number, got ${v === null ? "null" : typeof v}`);
    return false;
  }
  return true;
}

/**
 * Nullable numeric field: null is meaningful, non-number/non-null is an error.
 * @param {Issue[]} errors @param {unknown} v @param {string} path
 */
function requireNumberOrNull(errors, v, path) {
  if (v === null) return true;
  return requireNumber(errors, v, path);
}

/**
 * Validate a candidate state. Errors reject the state; warnings surface in the
 * UI but the state still simulates.
 * @param {RunwayState} s
 * @returns {ValidationResult}
 */
export function validate(s) {
  /** @type {Issue[]} */ const errors = [];
  /** @type {Issue[]} */ const warnings = [];

  if (!s || typeof s !== "object") {
    add(errors, "", "state must be an object");
    return { errors, warnings };
  }
  if (s.schemaVersion !== SCHEMA_VERSION) {
    add(errors, "schemaVersion", `expected ${SCHEMA_VERSION}, got ${s.schemaVersion}`);
  }

  for (const key of /** @type {const} */ (["profile", "portfolio", "social", "health", "endState", "work"])) {
    if (!s[key] || typeof s[key] !== "object") add(errors, key, "missing section");
  }
  for (const key of /** @type {const} */ (["properties", "incomes", "spending"])) {
    if (!Array.isArray(s[key])) add(errors, key, "must be an array");
  }
  if (errors.length) return { errors, warnings };

  const { currentYear } = s.profile;
  requireNumber(errors, s.profile.currentAge, "profile.currentAge");
  requireNumber(errors, s.profile.endAge, "profile.endAge");
  requireNumber(errors, s.profile.currentYear, "profile.currentYear");
  if (typeof s.profile.endAge === "number" && typeof s.profile.currentAge === "number" && s.profile.endAge <= s.profile.currentAge) {
    add(errors, "profile.endAge", "plan-to age must be greater than current age");
  }

  requireNumber(errors, s.portfolio.balance, "portfolio.balance");
  requireNumber(errors, s.portfolio.realReturnPct, "portfolio.realReturnPct");

  s.properties.forEach((p, i) => {
    const at = `properties[${i}]`;
    if (typeof p.name !== "string" || !p.name.trim()) add(errors, `${at}.name`, "name required");
    requireNumber(errors, p.rentMonthly, `${at}.rentMonthly`);
    requireNumber(errors, p.costsMonthly, `${at}.costsMonthly`);
    requireNumber(errors, p.mortgageMonthly, `${at}.mortgageMonthly`);
    requireNumberOrNull(errors, p.payoffYear, `${at}.payoffYear`);
    requireNumberOrNull(errors, p.saleYear, `${at}.saleYear`);
    requireNumberOrNull(errors, p.saleNetProceeds, `${at}.saleNetProceeds`);
    if (p.saleYear === 0) add(errors, `${at}.saleYear`, "0 is not a year — leave empty (null) to keep forever");
    if (typeof p.saleYear === "number" && p.saleYear !== 0) {
      if (p.saleYear < currentYear) {
        add(warnings, `${at}.saleYear`, `sale year ${p.saleYear} is in the past — proceeds will never be counted`);
      }
      if (p.saleNetProceeds === null) {
        add(warnings, `${at}.saleNetProceeds`, "sale year set but net proceeds empty — sale will add $0");
      }
    }
    if (typeof p.payoffYear === "number" && p.payoffYear < currentYear) {
      add(warnings, `${at}.payoffYear`, `payoff year ${p.payoffYear} is in the past — treating mortgage as already paid off`);
    }
  });

  s.incomes.forEach((inc, i) => {
    const at = `incomes[${i}]`;
    if (typeof inc.name !== "string" || !inc.name.trim()) add(errors, `${at}.name`, "name required");
    requireNumber(errors, inc.annual, `${at}.annual`);
    requireNumber(errors, inc.fromYear, `${at}.fromYear`);
    requireNumber(errors, inc.toYear, `${at}.toYear`);
    if (typeof inc.fromYear === "number" && typeof inc.toYear === "number" && inc.toYear < inc.fromYear) {
      add(errors, `${at}.toYear`, `to-year ${inc.toYear} is before from-year ${inc.fromYear}`);
    }
  });

  s.spending.forEach((c, i) => {
    const at = `spending[${i}]`;
    if (typeof c.name !== "string" || !c.name.trim()) add(errors, `${at}.name`, "name required");
    requireNumber(errors, c.monthly, `${at}.monthly`);
  });

  requireNumber(errors, s.social.startAge, "social.startAge");
  requireNumber(errors, s.social.monthly, "social.monthly");
  requireNumber(errors, s.social.haircutPct, "social.haircutPct");

  requireNumber(errors, s.health.preMedicareAnnual, "health.preMedicareAnnual");
  requireNumber(errors, s.health.postMedicareAnnual, "health.postMedicareAnnual");
  requireNumber(errors, s.health.employerCoverageUntilAge, "health.employerCoverageUntilAge");

  if (!END_STATE_MODES.includes(s.endState.mode)) {
    add(errors, "endState.mode", `must be one of ${END_STATE_MODES.join(", ")}`);
  }
  if (!s.endState.amounts || typeof s.endState.amounts !== "object") {
    add(errors, "endState.amounts", "missing amounts");
  } else {
    requireNumber(errors, s.endState.amounts.bequest, "endState.amounts.bequest");
    requireNumber(errors, s.endState.amounts.floor, "endState.amounts.floor");
  }

  requireNumber(errors, s.work.untilAge, "work.untilAge");
  if (typeof s.work.untilAge === "number" && typeof s.profile.currentAge === "number" && s.work.untilAge < s.profile.currentAge) {
    add(warnings, "work.untilAge", "work-until age is below current age — the income window is empty");
  }

  return { errors, warnings };
}
