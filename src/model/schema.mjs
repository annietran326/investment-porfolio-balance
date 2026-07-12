// The domain model: every entity, every default, and validation.
// Conventions that are load-bearing across the app:
//   - All amounts are in TODAY'S dollars. Returns are real (after inflation and tax).
//   - `saleYear: null` means "keep this property forever". Empty is meaningful;
//     0 is an error, never coerced. Import parsers must preserve this distinction.
//   - `realGrowthPct` on a line is REAL growth vs inflation: 0 = grows with
//     inflation (holds constant in today's dollars, the default), +1.5 = outpaces
//     inflation by 1.5%/yr, −2 = lags it. Compounds from `profile.currentYear`.
//   - Spending lines carry an optional [fromYear, toYear] window (null = open):
//     perpetual costs leave both blank; time-boxed costs (a dependent, a loan) end.
//   - The household is self (profile/social/health) plus `household.people` for a
//     spouse and dependents. A spouse can carry their own Social Security and
//     healthcare; dependents mainly drive time-boxed spending. No death modeling.
//   - Defaults live HERE, once. No `||`-style fallbacks at use sites — code either
//     receives a validated state or rejects it.

export const SCHEMA_VERSION = 3;

// The year the pure defaults are authored against. The engine and model never
// read the clock (a purity guarantee); the SERVER re-anchors fresh/placeholder
// state to the real current year at serve time via reanchorYears().
export const BASE_YEAR = 2026;

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
 * @property {number} rentRealGrowthPct  real growth vs inflation on rent (default 0)
 * @property {number} costsRealGrowthPct real growth vs inflation on costs (default 0)
 *
 * @typedef {Object} Income
 * @property {string} name
 * @property {number} annual   net of tax, today's $
 * @property {number} fromYear
 * @property {number} toYear   inclusive
 * @property {number} realGrowthPct real growth vs inflation (default 0)
 *
 * @typedef {Object} SpendingCategory
 * @property {string} name
 * @property {number} monthly  excl. property costs and healthcare (modeled separately)
 * @property {number|null} fromYear first year this cost applies; null = from the start
 * @property {number|null} toYear   last year this cost applies; null = perpetual
 * @property {number} realGrowthPct real growth vs inflation (default 0)
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
 * @typedef {"spouse"|"dependent"} PersonRole
 * @typedef {Object} Person
 * @property {string} name
 * @property {PersonRole} role
 * @property {number|null} currentAge  needed for a spouse's SS/healthcare timing
 * @property {number} lumpSum   a one-time cost (today's $) — a dependent's big future expense (college, a wedding). 0 = none
 * @property {number|null} lumpSumYear  the year the lump sum lands; null = none
 * @property {Social} [social]  a spouse's own Social Security (absent = none)
 * @property {Health} [health]  a spouse's own healthcare load (absent = none)
 *
 * @typedef {Object} Household
 * @property {Person[]} people  spouse + dependents (self lives in profile/social/health)
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
 * @property {Household} household
 * @property {EndState} endState
 * @property {Work} work
 */

// A real growth rate this far from 0 is almost certainly a nominal figure typed
// by mistake (e.g. 25 instead of ~2 real) — warn, don't reject.
const GROWTH_SANITY_ABS = 15;

// ---- Factories: the single source of per-item defaults (UI + migration share) ----

/** @param {Partial<SpendingCategory>} [o] @returns {SpendingCategory} */
export function newSpendingCategory(o = {}) {
  return { name: o.name ?? "", monthly: o.monthly ?? 0, fromYear: o.fromYear ?? null, toYear: o.toYear ?? null, realGrowthPct: o.realGrowthPct ?? 0 };
}
/** @param {Partial<Income>} [o] @returns {Income} */
export function newIncome(o = {}) {
  return { name: o.name ?? "", annual: o.annual ?? 0, fromYear: o.fromYear ?? 0, toYear: o.toYear ?? 0, realGrowthPct: o.realGrowthPct ?? 0 };
}
/** @param {Partial<Property>} [o] @returns {Property} */
export function newProperty(o = {}) {
  return {
    name: o.name ?? "", rentMonthly: o.rentMonthly ?? 0, costsMonthly: o.costsMonthly ?? 0, mortgageMonthly: o.mortgageMonthly ?? 0,
    payoffYear: o.payoffYear ?? null, saleYear: o.saleYear ?? null, saleNetProceeds: o.saleNetProceeds ?? null,
    rentRealGrowthPct: o.rentRealGrowthPct ?? 0, costsRealGrowthPct: o.costsRealGrowthPct ?? 0,
  };
}
/** @returns {Social} */
export function newSocial() {
  return { startAge: 67, monthly: 0, haircutPct: 25 };
}
/** @returns {Health} */
export function newHealth() {
  return { preMedicareAnnual: 16000, postMedicareAnnual: 7500, employerCoverageUntilAge: 65 };
}
/** @param {PersonRole} role @param {Partial<Person>} [o] @returns {Person} */
export function newPerson(role, o = {}) {
  /** @type {Person} */
  const p = {
    name: o.name ?? (role === "spouse" ? "Spouse" : "Dependent"),
    role,
    currentAge: o.currentAge ?? null,
    lumpSum: o.lumpSum ?? 0,
    lumpSumYear: o.lumpSumYear ?? null,
  };
  if (role === "spouse") {
    p.social = o.social ?? newSocial();
    p.health = o.health ?? newHealth();
  }
  return p;
}

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
    household: { people: [] },
    endState: { mode: "zero", amounts: { bequest: 0, floor: 0 } },
    work: { untilAge: 50 },
  };
}

/**
 * Re-anchor a state to a target current year, shifting every year-bearing field
 * by the delta so relative timing (a sale next year, a lump sum in 18 years) is
 * preserved. PURE — the caller supplies the target year (the server reads the
 * clock; the model never does). Used to stamp fresh/placeholder state with the
 * real current year so the app stays correct in future years, without touching
 * a user's already-saved plan.
 * @param {RunwayState} state
 * @param {number} targetYear
 * @returns {RunwayState}
 */
export function reanchorYears(state, targetYear) {
  const delta = targetYear - state.profile.currentYear;
  if (delta === 0) return state;
  const shift = (/** @type {number|null} */ y) => (typeof y === "number" ? y + delta : y);
  const next = structuredClone(state);
  next.profile.currentYear = targetYear;
  for (const p of next.properties) {
    p.payoffYear = shift(p.payoffYear);
    p.saleYear = shift(p.saleYear);
  }
  for (const inc of next.incomes) {
    inc.fromYear += delta;
    inc.toYear += delta;
  }
  for (const c of next.spending) {
    c.fromYear = shift(c.fromYear);
    c.toYear = shift(c.toYear);
  }
  for (const person of next.household.people) {
    person.lumpSumYear = shift(person.lumpSumYear);
  }
  return next;
}

export const END_STATE_MODES = /** @type {EndStateMode[]} */ (["zero", "bequest", "floor"]);
export const PERSON_ROLES = /** @type {PersonRole[]} */ (["spouse", "dependent"]);
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

/** @param {Issue[]} errors @param {Issue[]} warnings @param {any} social @param {string} path */
function validateSocial(errors, warnings, social, path) {
  if (!social || typeof social !== "object") {
    add(errors, path, "missing section");
    return;
  }
  requireNumber(errors, social.startAge, `${path}.startAge`);
  requireNumber(errors, social.monthly, `${path}.monthly`);
  requireNumber(errors, social.haircutPct, `${path}.haircutPct`);
}

/** @param {Issue[]} errors @param {any} health @param {string} path */
function validateHealth(errors, health, path) {
  if (!health || typeof health !== "object") {
    add(errors, path, "missing section");
    return;
  }
  requireNumber(errors, health.preMedicareAnnual, `${path}.preMedicareAnnual`);
  requireNumber(errors, health.postMedicareAnnual, `${path}.postMedicareAnnual`);
  requireNumber(errors, health.employerCoverageUntilAge, `${path}.employerCoverageUntilAge`);
}

/** @param {Issue[]} warnings @param {unknown} g @param {string} path */
function warnIfNominalGrowth(warnings, g, path) {
  if (typeof g === "number" && Math.abs(g) > GROWTH_SANITY_ABS) {
    add(warnings, path, `real growth of ${g}% is extreme — did you mean a nominal rate? this is growth ABOVE inflation`);
  }
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

  for (const key of /** @type {const} */ (["profile", "portfolio", "social", "health", "household", "endState", "work"])) {
    if (!s[key] || typeof s[key] !== "object") add(errors, key, "missing section");
  }
  for (const key of /** @type {const} */ (["properties", "incomes", "spending"])) {
    if (!Array.isArray(s[key])) add(errors, key, "must be an array");
  }
  if (errors.length) return { errors, warnings };
  if (!Array.isArray(s.household.people)) {
    add(errors, "household.people", "must be an array");
    return { errors, warnings };
  }

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
    requireNumber(errors, p.rentRealGrowthPct, `${at}.rentRealGrowthPct`);
    requireNumber(errors, p.costsRealGrowthPct, `${at}.costsRealGrowthPct`);
    warnIfNominalGrowth(warnings, p.rentRealGrowthPct, `${at}.rentRealGrowthPct`);
    warnIfNominalGrowth(warnings, p.costsRealGrowthPct, `${at}.costsRealGrowthPct`);
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
    requireNumber(errors, inc.realGrowthPct, `${at}.realGrowthPct`);
    warnIfNominalGrowth(warnings, inc.realGrowthPct, `${at}.realGrowthPct`);
    if (typeof inc.fromYear === "number" && typeof inc.toYear === "number" && inc.toYear < inc.fromYear) {
      add(errors, `${at}.toYear`, `to-year ${inc.toYear} is before from-year ${inc.fromYear}`);
    }
  });

  s.spending.forEach((c, i) => {
    const at = `spending[${i}]`;
    if (typeof c.name !== "string" || !c.name.trim()) add(errors, `${at}.name`, "name required");
    requireNumber(errors, c.monthly, `${at}.monthly`);
    requireNumberOrNull(errors, c.fromYear, `${at}.fromYear`);
    requireNumberOrNull(errors, c.toYear, `${at}.toYear`);
    requireNumber(errors, c.realGrowthPct, `${at}.realGrowthPct`);
    warnIfNominalGrowth(warnings, c.realGrowthPct, `${at}.realGrowthPct`);
    if (typeof c.fromYear === "number" && typeof c.toYear === "number" && c.toYear < c.fromYear) {
      add(errors, `${at}.toYear`, `to-year ${c.toYear} is before from-year ${c.fromYear}`);
    }
    if (typeof c.toYear === "number" && c.toYear < currentYear) {
      add(warnings, `${at}.toYear`, `end year ${c.toYear} is in the past — this cost will never apply`);
    }
  });

  validateSocial(errors, warnings, s.social, "social");
  validateHealth(errors, s.health, "health");

  let spouseCount = 0;
  s.household.people.forEach((person, i) => {
    const at = `household.people[${i}]`;
    if (typeof person.name !== "string" || !person.name.trim()) add(errors, `${at}.name`, "name required");
    if (!PERSON_ROLES.includes(person.role)) add(errors, `${at}.role`, `must be one of ${PERSON_ROLES.join(", ")}`);
    requireNumberOrNull(errors, person.currentAge, `${at}.currentAge`);
    requireNumber(errors, person.lumpSum, `${at}.lumpSum`);
    requireNumberOrNull(errors, person.lumpSumYear, `${at}.lumpSumYear`);
    if (typeof person.lumpSumYear === "number" && person.lumpSumYear < currentYear) {
      add(warnings, `${at}.lumpSumYear`, `lump-sum year ${person.lumpSumYear} is in the past — this cost will never apply`);
    }
    if (person.role === "spouse") {
      spouseCount++;
      if (person.currentAge === null) add(warnings, `${at}.currentAge`, "spouse age is needed to time their Social Security and healthcare");
      if (person.social !== undefined) validateSocial(errors, warnings, person.social, `${at}.social`);
      if (person.health !== undefined) validateHealth(errors, person.health, `${at}.health`);
    }
  });
  if (spouseCount > 1) add(warnings, "household.people", "more than one spouse is unusual — all are modeled");

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
