// The domain model: every entity, every default, and validation.
// Conventions that are load-bearing across the app:
//   - Amounts are ENTERED in today's dollars. The engine runs in actual
//     (nominal) dollars using one inflation assumption, then reports results
//     back in today's dollars so they are easy to judge.
//   - Every rate is an ACTUAL rate (before inflation): bucket returns, spending
//     and income increases, rent growth. A growth rate left blank (null) means
//     "rises with inflation".
//   - Money lives in accounts (taxable, traditional IRA, 401(k), Roth IRA). The
//     account type decides how withdrawals are taxed. Each account is either
//     invested in the household's three-bucket plan or dedicated to one bucket
//     (e.g. an IRA held entirely in high income), which counts toward that
//     bucket's target.
//   - Spending lines carry an optional [fromYear, toYear] window (null = open).
//   - The household is self (profile/social/health) plus `household.people` for a
//     spouse and dependents. You and a spouse each live to the plan-to age;
//     the plan runs until the younger of you reaches it.
//   - Defaults live HERE, once. No `||`-style fallbacks at use sites: code either
//     receives a validated state or rejects it.

export const SCHEMA_VERSION = 13;

// The year the pure defaults are authored against. The engine and model never
// read the clock (a purity guarantee); the SERVER re-anchors fresh/placeholder
// state to the real current year at serve time via reanchorYears().
export const BASE_YEAR = 2026;

/**
 * @typedef {Object} Profile
 * @property {number} currentAge
 * @property {number} endAge     plan-to age (presets 90/95/100)
 * @property {number} currentYear simulation clock origin; the engine never reads Date
 *
 * @typedef {Object} Economy
 * @property {number} inflationPct the one inflation assumption, %/yr
 *
 * @typedef {"taxable"|"traditional_ira"|"401k"|"roth_ira"} AccountType
 * @typedef {"buckets"|"preservation"|"income"|"equities"} AccountInvest
 * @typedef {Object} Account
 * @property {string} name
 * @property {AccountType} type
 * @property {number} balance              current value, $
 * @property {number|null} costBasis       taxable only: what you paid in total. null = same as balance (no gain yet)
 * @property {number} contributionAnnual   your own contribution, $/yr in today's dollars (payroll for a 401(k))
 * @property {number} employerMatchAnnual  employer match, $/yr in today's dollars
 * @property {number} contributeYears     how many more years contributions continue (0 = none), starting this year
 * @property {number|null} contributionGrowthPct how fast contributions rise, %/yr; null = with inflation
 * @property {AccountInvest} invest        "buckets" = follows the bucket plan's split; otherwise the one bucket this
 *                                         account is dedicated to (it earns that bucket's return and counts toward its target)
 * @property {AccountOwner} owner          whose account it is; sets when required minimum distributions start (traditional IRA / 401(k))
 *                                         and when the money can be spent without a penalty (59 1/2, retirement accounts)
 *
 * @typedef {"self"|"spouse"} AccountOwner
 *
 * @typedef {Object} Buckets
 * The three investment buckets and the time-based rule that splits money
 * between them. Money needed in the next `preservationYears` years sits in
 * capital preservation; money needed through year `incomeThroughYear` sits in
 * high income; everything further out sits in global equities.
 * @property {number} preservationReturnPct capital preservation return, %/yr (before inflation)
 * @property {number} incomeReturnPct       high income return, %/yr (before inflation)
 * @property {number} equitiesReturnPct     global equities return, %/yr (before inflation)
 * @property {number} preservationYears     years 1..N of withdrawals held in capital preservation
 * @property {number} incomeThroughYear     years N+1..M held in high income
 * @property {number} preservationVolPct    capital preservation's typical yearly swing (standard deviation), %
 * @property {number} incomeVolPct          high income's typical yearly swing, %
 * @property {number} equitiesVolPct        global equities' typical yearly swing, %
 *
 * @typedef {Object} Simulation
 * @property {number} targetSuccessPct the share of simulated futures the plan should succeed in (the gap aims for it)
 * @property {number} spendMorePct     the "spend more" scenario: % increase on variable spending lines
 *
 * @typedef {Object} Taxes
 * Effective (average) rates, federal plus state, applied to money taken out of
 * accounts. Income streams are entered after tax.
 * @property {number} ordinaryIncomePct  on traditional IRA / 401(k) withdrawals
 * @property {number} capitalGainsPct    on the gain portion of taxable-account sales
 *
 * @typedef {Object} Income
 * @property {string} name
 * @property {number} annual   after tax (and after any 401(k) payroll deduction), today's $
 * @property {number} fromYear
 * @property {number} toYear   inclusive
 * @property {number|null} growthPct %/yr; null = with inflation
 *
 * @typedef {Object} SpendingCategory
 * @property {string} name
 * @property {number} monthly  today's $, excl. healthcare (modeled separately)
 * @property {number|null} fromYear first year this cost applies; null = from the start
 * @property {number|null} toYear   last year this cost applies; null = perpetual
 * @property {number|null} growthPct %/yr increase; null = with inflation
 * @property {boolean} variable  flexible spending the "spend more" scenario applies to (not housing, property tax, etc.)
 *
 * @typedef {Object} Social
 * @property {number} startAge
 * @property {number} monthly    today's $, pre-haircut (rises with inflation, like the real COLA)
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
 * @property {number} annualCost   ongoing support cost (today's $/yr). 0 = none
 * @property {number|null} fromYear  first year the cost applies; null = from the start
 * @property {number|null} toYear    last year the cost applies; null = for the whole plan
 * @property {Social} [social]  a spouse's own Social Security (absent = none)
 * @property {Health} [health]  a spouse's own healthcare load (absent = none)
 *
 * @typedef {Object} Household
 * @property {Person[]} people  spouse + dependents (self lives in profile/social/health)
 *
 * @typedef {"zero"|"bequest"|"floor"} EndStateMode
 * @typedef {Object} EndState
 * @property {EndStateMode} mode
 * @property {{bequest: number, floor: number}} amounts today's $, preserved across switches
 *
 * @typedef {Object} RunwayState
 * @property {number} schemaVersion
 * @property {Profile} profile
 * @property {Economy} economy
 * @property {Account[]} accounts
 * @property {Buckets} buckets
 * @property {Taxes} taxes
 * @property {Income[]} incomes
 * @property {SpendingCategory[]} spending
 * @property {Social} social
 * @property {Health} health
 * @property {Household} household
 * @property {EndState} endState
 * @property {Simulation} simulation
 */

// A growth or return rate this far out is almost certainly a typo.
const RATE_SANITY_ABS = 25;

export const ACCOUNT_TYPES = /** @type {AccountType[]} */ (["taxable", "traditional_ira", "401k", "roth_ira"]);
export const ACCOUNT_INVEST = /** @type {AccountInvest[]} */ (["buckets", "preservation", "income", "equities"]);
export const ACCOUNT_OWNERS = /** @type {AccountOwner[]} */ (["self", "spouse"]);
export const ACCOUNT_TYPE_LABELS = {
  taxable: "Taxable brokerage",
  traditional_ira: "Traditional IRA",
  "401k": "401(k) (traditional)",
  roth_ira: "Roth IRA",
};

// ---- Factories: the single source of per-item defaults (UI + migration share) ----

/** @param {Partial<SpendingCategory>} [o] @returns {SpendingCategory} */
export function newSpendingCategory(o = {}) {
  return { name: o.name ?? "", monthly: o.monthly ?? 0, fromYear: o.fromYear ?? null, toYear: o.toYear ?? null, growthPct: o.growthPct ?? null, variable: o.variable ?? true };
}
/** @param {Partial<Income>} [o] @returns {Income} */
export function newIncome(o = {}) {
  return { name: o.name ?? "", annual: o.annual ?? 0, fromYear: o.fromYear ?? 0, toYear: o.toYear ?? 0, growthPct: o.growthPct ?? null };
}
/**
 * Where a new account is invested by default: traditional IRAs in high income
 * (their withdrawals are taxed as ordinary income, so they're a natural home
 * for income investments rather than stocks); everything else in the bucket plan.
 * @param {AccountType} type @returns {AccountInvest}
 */
export function defaultInvest(type) {
  return type === "traditional_ira" ? "income" : "buckets";
}
/** @param {Partial<Account>} [o] @returns {Account} */
export function newAccount(o = {}) {
  return {
    name: o.name ?? "", type: o.type ?? "taxable", balance: o.balance ?? 0, costBasis: o.costBasis ?? null,
    contributionAnnual: o.contributionAnnual ?? 0, employerMatchAnnual: o.employerMatchAnnual ?? 0,
    contributeYears: o.contributeYears ?? 0, contributionGrowthPct: o.contributionGrowthPct ?? null,
    invest: o.invest ?? defaultInvest(o.type ?? "taxable"),
    owner: o.owner ?? "self",
  };
}
/** @returns {Buckets} */
export function newBuckets() {
  return {
    // Expected returns before inflation, near 2026 professional forecasts
    // (e.g. J.P. Morgan global equities 7.0%, high yield ~6%, cash ~3.3%).
    preservationReturnPct: 3, incomeReturnPct: 6, equitiesReturnPct: 8, preservationYears: 8, incomeThroughYear: 15,
    // Typical yearly swings, a bit cautious vs. the 2024 Horizon Actuarial
    // survey averages (cash 1.1%, core bonds 5.9%, high yield 9.9%, US large
    // cap 16.5%, non-US developed 18.1%).
    preservationVolPct: 1, incomeVolPct: 8, equitiesVolPct: 17,
  };
}
/** @returns {Simulation} */
export function newSimulation() {
  return { targetSuccessPct: 90, spendMorePct: 20 };
}
/** @returns {Taxes} */
export function newTaxes() {
  return { ordinaryIncomePct: 22, capitalGainsPct: 15 };
}
/** @returns {Economy} */
export function newEconomy() {
  return { inflationPct: 2.5 };
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
    annualCost: o.annualCost ?? 0,
    fromYear: o.fromYear ?? null,
    toYear: o.toYear ?? null,
  };
  if (role === "spouse") {
    p.social = o.social ?? newSocial();
    p.health = o.health ?? newHealth();
  }
  return p;
}

// 2026 defaults (all user-editable): inflation 2.5%; bucket returns 3 / 6 /
// 8% before inflation (about 0.5 / 3.4 / 5.4% after); bucket cutoffs 8 and 15
// years; SS haircut 25% (Trustees Report: 22–28% cut at 2032); pre-65
// healthcare $16K/yr (unsubsidized ACA anchor); Medicare-age $7,500/yr.
/** @returns {RunwayState} */
export function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    profile: { currentAge: 40, endAge: 95, currentYear: 2026 },
    economy: newEconomy(),
    accounts: [],
    buckets: newBuckets(),
    taxes: newTaxes(),
    incomes: [],
    spending: [],
    social: { startAge: 67, monthly: 0, haircutPct: 25 },
    health: { preMedicareAnnual: 16000, postMedicareAnnual: 7500, employerCoverageUntilAge: 40 },
    household: { people: [] },
    endState: { mode: "zero", amounts: { bequest: 0, floor: 0 } },
    simulation: newSimulation(),
  };
}

/** Total of every account balance. @param {RunwayState} s */
export function totalBalance(s) {
  return s.accounts.reduce((sum, a) => sum + (typeof a.balance === "number" ? a.balance : 0), 0);
}

/**
 * Re-anchor a state to a target current year, shifting every year-bearing field
 * by the delta so relative timing (a sale next year, a cost ending in 18 years)
 * is preserved. PURE: the caller supplies the target year (the server reads the
 * clock; the model never does).
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
  for (const inc of next.incomes) {
    inc.fromYear += delta;
    inc.toYear += delta;
  }
  for (const c of next.spending) {
    c.fromYear = shift(c.fromYear);
    c.toYear = shift(c.toYear);
  }
  for (const person of next.household.people) {
    person.fromYear = shift(person.fromYear);
    person.toYear = shift(person.toYear);
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
    add(errors, path, `must be a number, got ${v === null ? "empty" : typeof v}`);
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

/** @param {Issue[]} warnings @param {unknown} g @param {string} path */
function warnIfExtremeRate(warnings, g, path) {
  if (typeof g === "number" && Math.abs(g) > RATE_SANITY_ABS) {
    add(warnings, path, `${g}% a year is extreme. Is that a typo?`);
  }
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

  for (const key of /** @type {const} */ (["profile", "economy", "buckets", "taxes", "social", "health", "household", "endState", "simulation"])) {
    if (!s[key] || typeof s[key] !== "object") add(errors, key, "missing section");
  }
  for (const key of /** @type {const} */ (["accounts", "incomes", "spending"])) {
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

  if (requireNumber(errors, s.economy.inflationPct, "economy.inflationPct")) {
    if (s.economy.inflationPct < -5 || s.economy.inflationPct > 15) {
      add(warnings, "economy.inflationPct", `${s.economy.inflationPct}% inflation is far outside the usual 1–5% range`);
    }
  }

  // Buckets: three returns plus the two year cutoffs.
  const b = s.buckets;
  for (const k of /** @type {const} */ (["preservationReturnPct", "incomeReturnPct", "equitiesReturnPct"])) {
    if (requireNumber(errors, b[k], `buckets.${k}`)) warnIfExtremeRate(warnings, b[k], `buckets.${k}`);
  }
  for (const k of /** @type {const} */ (["preservationVolPct", "incomeVolPct", "equitiesVolPct"])) {
    if (requireNumber(errors, b[k], `buckets.${k}`) && (b[k] < 0 || b[k] > 60)) add(errors, `buckets.${k}`, "swing must be between 0 and 60%");
  }
  const pyOk = requireNumber(errors, b.preservationYears, "buckets.preservationYears");
  const iyOk = requireNumber(errors, b.incomeThroughYear, "buckets.incomeThroughYear");
  if (pyOk && b.preservationYears < 0) add(errors, "buckets.preservationYears", "can't be negative (0 = no capital preservation bucket)");
  if (pyOk && iyOk && b.incomeThroughYear < b.preservationYears) {
    add(errors, "buckets.incomeThroughYear", `must be at least the capital preservation years (${b.preservationYears})`);
  }
  if (
    typeof b.preservationReturnPct === "number" && typeof b.incomeReturnPct === "number" && typeof b.equitiesReturnPct === "number" &&
    !(b.preservationReturnPct <= b.incomeReturnPct && b.incomeReturnPct <= b.equitiesReturnPct)
  ) {
    add(warnings, "buckets.equitiesReturnPct", "returns usually rise from capital preservation to high income to equities. Check the order.");
  }

  // Taxes: effective rates, warned (not rejected) outside a plausible band.
  for (const k of /** @type {const} */ (["ordinaryIncomePct", "capitalGainsPct"])) {
    if (requireNumber(errors, s.taxes[k], `taxes.${k}`) && (s.taxes[k] < 0 || s.taxes[k] > 60)) {
      add(warnings, `taxes.${k}`, `${s.taxes[k]}% is outside the expected 0–60% range`);
    }
  }

  s.accounts.forEach((a, i) => {
    const at = `accounts[${i}]`;
    if (typeof a.name !== "string" || !a.name.trim()) add(errors, `${at}.name`, "name required");
    if (!ACCOUNT_TYPES.includes(a.type)) add(errors, `${at}.type`, `must be one of ${ACCOUNT_TYPES.join(", ")}`);
    requireNumber(errors, a.balance, `${at}.balance`);
    requireNumberOrNull(errors, a.costBasis, `${at}.costBasis`);
    requireNumber(errors, a.contributionAnnual, `${at}.contributionAnnual`);
    requireNumber(errors, a.employerMatchAnnual, `${at}.employerMatchAnnual`);
    const yearsOk = requireNumber(errors, a.contributeYears, `${at}.contributeYears`);
    requireNumberOrNull(errors, a.contributionGrowthPct, `${at}.contributionGrowthPct`);
    warnIfExtremeRate(warnings, a.contributionGrowthPct, `${at}.contributionGrowthPct`);
    if (!ACCOUNT_INVEST.includes(a.invest)) add(errors, `${at}.invest`, `must be one of ${ACCOUNT_INVEST.join(", ")}`);
    if (!ACCOUNT_OWNERS.includes(a.owner)) add(errors, `${at}.owner`, `must be one of ${ACCOUNT_OWNERS.join(", ")}`);
    else if (a.owner === "spouse" && !(s.household?.people ?? []).some((p) => p.role === "spouse" && typeof p.currentAge === "number")) {
      add(warnings, `${at}.owner`, "no spouse with an age is set up under Household profile, so this account is treated as yours");
    }
    if (yearsOk && a.contributeYears < 0) add(errors, `${at}.contributeYears`, "can't be negative");
    if (yearsOk && a.contributeYears === 0 && ((a.contributionAnnual ?? 0) > 0 || (a.employerMatchAnnual ?? 0) > 0)) {
      add(warnings, `${at}.contributeYears`, "contributions are set but for 0 years, so none will be added. How many more years will you contribute?");
    }
    if (typeof a.balance === "number" && a.balance < 0) add(errors, `${at}.balance`, "balance can't be negative");
    if (a.type === "taxable" && typeof a.costBasis === "number") {
      if (a.costBasis < 0) add(errors, `${at}.costBasis`, "cost basis can't be negative");
      else if (typeof a.balance === "number" && a.costBasis > a.balance) {
        add(warnings, `${at}.costBasis`, "cost basis is above the balance (an unrealized loss). That's fine, just double-check it.");
      }
    }
    if (a.type === "roth_ira" && typeof a.employerMatchAnnual === "number" && a.employerMatchAnnual > 0) {
      add(warnings, `${at}.employerMatchAnnual`, "IRAs don't get an employer match. Did you mean the 401(k)?");
    }
  });

  s.incomes.forEach((inc, i) => {
    const at = `incomes[${i}]`;
    if (typeof inc.name !== "string" || !inc.name.trim()) add(errors, `${at}.name`, "name required");
    requireNumber(errors, inc.annual, `${at}.annual`);
    requireNumber(errors, inc.fromYear, `${at}.fromYear`);
    requireNumber(errors, inc.toYear, `${at}.toYear`);
    requireNumberOrNull(errors, inc.growthPct, `${at}.growthPct`);
    warnIfExtremeRate(warnings, inc.growthPct, `${at}.growthPct`);
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
    requireNumberOrNull(errors, c.growthPct, `${at}.growthPct`);
    warnIfExtremeRate(warnings, c.growthPct, `${at}.growthPct`);
    if (typeof c.variable !== "boolean") add(errors, `${at}.variable`, "must be checked or unchecked");
    if (typeof c.fromYear === "number" && typeof c.toYear === "number" && c.toYear < c.fromYear) {
      add(errors, `${at}.toYear`, `to-year ${c.toYear} is before from-year ${c.fromYear}`);
    }
    if (typeof c.toYear === "number" && c.toYear < currentYear) {
      add(warnings, `${at}.toYear`, `end year ${c.toYear} is in the past, so this cost will never apply`);
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
    requireNumber(errors, person.annualCost, `${at}.annualCost`);
    requireNumberOrNull(errors, person.fromYear, `${at}.fromYear`);
    requireNumberOrNull(errors, person.toYear, `${at}.toYear`);
    if (typeof person.fromYear === "number" && typeof person.toYear === "number" && person.toYear < person.fromYear) {
      add(errors, `${at}.toYear`, `to-year ${person.toYear} is before from-year ${person.fromYear}`);
    }
    if (typeof person.toYear === "number" && person.toYear < currentYear) {
      add(warnings, `${at}.toYear`, `end year ${person.toYear} is in the past, so this cost will never apply`);
    }
    if (person.role === "spouse") {
      spouseCount++;
      if (person.currentAge === null) add(warnings, `${at}.currentAge`, "spouse age is needed to time their Social Security and healthcare");
      else if (typeof person.currentAge === "number" && typeof s.profile.endAge === "number" && person.currentAge >= s.profile.endAge) {
        add(warnings, `${at}.currentAge`, `already at or past the plan-to age (${s.profile.endAge}), so their Social Security and healthcare aren't counted`);
      }
      if (person.social !== undefined) validateSocial(errors, warnings, person.social, `${at}.social`);
      if (person.health !== undefined) validateHealth(errors, person.health, `${at}.health`);
    }
  });
  if (spouseCount > 1) add(warnings, "household.people", "more than one spouse is unusual, but all are modeled");

  if (requireNumber(errors, s.simulation.targetSuccessPct, "simulation.targetSuccessPct")) {
    const t = s.simulation.targetSuccessPct;
    if (t < 50 || t > 99) add(errors, "simulation.targetSuccessPct", "pick a target between 50% and 99%");
  }
  if (requireNumber(errors, s.simulation.spendMorePct, "simulation.spendMorePct")) {
    if (s.simulation.spendMorePct < 0) add(errors, "simulation.spendMorePct", "can't be negative");
    else if (s.simulation.spendMorePct > 200) add(warnings, "simulation.spendMorePct", `${s.simulation.spendMorePct}% more is a very large increase. Is that a typo?`);
  }

  if (!END_STATE_MODES.includes(s.endState.mode)) {
    add(errors, "endState.mode", `must be one of ${END_STATE_MODES.join(", ")}`);
  }
  if (!s.endState.amounts || typeof s.endState.amounts !== "object") {
    add(errors, "endState.amounts", "missing amounts");
  } else {
    requireNumber(errors, s.endState.amounts.bequest, "endState.amounts.bequest");
    requireNumber(errors, s.endState.amounts.floor, "endState.amounts.floor");
  }


  return { errors, warnings };
}
