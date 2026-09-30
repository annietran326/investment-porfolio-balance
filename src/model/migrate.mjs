// Migration ladder. PURE: this module performs zero I/O — no filesystem
// imports, no clock reads, returns new objects. The caller (the store)
// owns the pre-migration snapshot and the single atomic write that lands the
// result, so a crash mid-ladder leaves the old file intact.
//
// Versioning rules (R14):
//   - Every persisted file carries its own schemaVersion; each file migrates
//     independently. manifest.json is advisory, never authoritative.
//   - A MISSING schemaVersion on the load path is corrupt — never sniffed or
//     assumed. The one exception is the v0 localStorage export, which predates
//     versioning and enters ONLY via an explicit user-initiated import that
//     declares version 0 (`declaredVersion: 0`).
import { SCHEMA_VERSION, defaultState, newSpendingCategory, newIncome, newAccount, newBuckets, newEconomy, newTaxes, newSimulation } from "./schema.mjs";

// Old "own fund" defaults, used only by the rungs that created and then retired own funds.
const DEFAULT_OWN_RETURN_PCT = 7;
const DEFAULT_OWN_VOL_PCT = 15;

export class MissingVersionError extends Error {
  constructor() {
    super("data has no schemaVersion — treating as corrupt (v0 exports must be imported explicitly, not loaded)");
    this.name = "MissingVersionError";
  }
}

export class FutureVersionError extends Error {
  /** @param {number} found */
  constructor(found) {
    super(`data is schemaVersion ${found} but this app understands up to ${SCHEMA_VERSION} — update the app, never downgrade the data`);
    this.name = "FutureVersionError";
  }
}

/**
 * v0 (the prototype's localStorage export) → v1.
 * Field names were kept stable on purpose, so this is mostly identity plus:
 *   - schemaVersion stamp
 *   - endState {mode, amount} → {mode, amounts: {bequest, floor}}
 *   - explicit defaults for anything v0 left undefined (v0 had silent `||` fallbacks)
 * Returns an intermediate v1-shaped state; the ladder then runs migrateV1 on it.
 * @param {any} v0
 * @returns {any}
 */
function migrateV0(v0) {
  const d = defaultState();
  const mode = ["zero", "bequest", "floor"].includes(v0?.endState?.mode) ? v0.endState.mode : "zero";
  const amount = typeof v0?.endState?.amount === "number" ? v0.endState.amount : 0;
  return {
    schemaVersion: 1,
    profile: {
      currentAge: num(v0?.profile?.currentAge, d.profile.currentAge),
      endAge: num(v0?.profile?.endAge, d.profile.endAge),
      currentYear: num(v0?.profile?.currentYear, d.profile.currentYear),
    },
    portfolio: {
      balance: num(v0?.portfolio?.balance, 0),
      realReturnPct: num(v0?.portfolio?.realReturnPct, 3.5),
    },
    properties: arr(v0?.properties).map((p) => ({
      name: str(p?.name, "property"),
      rentMonthly: num(p?.rentMonthly, 0),
      costsMonthly: num(p?.costsMonthly, 0),
      mortgageMonthly: num(p?.mortgageMonthly, 0),
      payoffYear: numOrNull(p?.payoffYear),
      saleYear: numOrNull(p?.saleYear),
      saleNetProceeds: numOrNull(p?.saleNetProceeds),
    })),
    incomes: arr(v0?.incomes).map((inc) => {
      const currentYear = num(v0?.profile?.currentYear, d.profile.currentYear);
      // v0's engine treated a missing toYear as `?? 9999` (income forever).
      // Preserve that behavior explicitly: default to the last simulated year.
      const horizonEnd = currentYear + num(v0?.profile?.endAge, d.profile.endAge) - num(v0?.profile?.currentAge, d.profile.currentAge);
      return {
        name: str(inc?.name, "income"),
        annual: num(inc?.annual, 0),
        fromYear: num(inc?.fromYear, currentYear),
        toYear: num(inc?.toYear, horizonEnd),
      };
    }),
    spending: arr(v0?.spending).map((c) => ({ name: str(c?.name, "category"), monthly: num(c?.monthly, 0) })),
    social: {
      startAge: num(v0?.social?.startAge, d.social.startAge),
      monthly: num(v0?.social?.monthly, 0),
      haircutPct: num(v0?.social?.haircutPct, d.social.haircutPct),
    },
    health: {
      preMedicareAnnual: num(v0?.health?.preMedicareAnnual, d.health.preMedicareAnnual),
      postMedicareAnnual: num(v0?.health?.postMedicareAnnual, d.health.postMedicareAnnual),
      employerCoverageUntilAge: num(v0?.health?.employerCoverageUntilAge, d.health.employerCoverageUntilAge),
    },
    endState: {
      mode,
      amounts: {
        bequest: mode === "bequest" ? amount : 0,
        floor: mode === "floor" ? amount : 0,
      },
    },
    work: { untilAge: num(v0?.work?.untilAge, 50) },
  };
}

/**
 * v1 → v2. Purely additive — every v1 field is preserved; the new fields default
 * to "no change" (growth 0 = grows with inflation, open spending windows, empty
 * household), so a migrated v1 state produces IDENTICAL results until the user
 * touches the new fields. Factories are the single source of the defaults.
 * @param {any} v1
 * @returns {import("./schema.mjs").RunwayState}
 */
function migrateV1(v1) {
  return {
    ...v1,
    schemaVersion: 2,
    // v2 shapes, written literally: the factories now build v6 rows, and the
    // v5 -> v6 rung below is what converts the real-growth fields.
    properties: arr(v1.properties).map((p) => ({ ...p, rentRealGrowthPct: p.rentRealGrowthPct ?? 0, costsRealGrowthPct: p.costsRealGrowthPct ?? 0 })),
    incomes: arr(v1.incomes).map((inc) => ({ ...inc, realGrowthPct: inc.realGrowthPct ?? 0 })),
    spending: arr(v1.spending).map((c) => ({ fromYear: null, toYear: null, ...c, realGrowthPct: c.realGrowthPct ?? 0 })),
    household: { people: [] },
  };
}

/**
 * v2 → v3. Additive: each household person gains a one-time lump-sum cost
 * (a dependent's big future expense) defaulting to none, so a migrated v2 state
 * produces identical results until the user sets one.
 * @param {any} v2
 * @returns {import("./schema.mjs").RunwayState}
 */
function migrateV2(v2) {
  return {
    ...v2,
    schemaVersion: 3,
    household: {
      people: arr(v2.household?.people).map((p) => ({ ...p, lumpSum: p.lumpSum ?? 0, lumpSumYear: p.lumpSumYear ?? null })),
    },
  };
}

/**
 * v3 → v4. The v3 dependent lump-sum (one-time cost at a year) becomes an
 * ongoing annual cost over a window. A lump sum is losslessly a one-year
 * window (annualCost = lumpSum, fromYear = toYear = lumpSumYear); no lump sum
 * (0) becomes no cost with an open window.
 * @param {any} v3
 * @returns {import("./schema.mjs").RunwayState}
 */
function migrateV3(v3) {
  return {
    ...v3,
    schemaVersion: 4,
    household: {
      people: arr(v3.household?.people).map((p) => {
        const { lumpSum, lumpSumYear, ...rest } = p;
        const hasLump = typeof lumpSum === "number" && lumpSum !== 0 && typeof lumpSumYear === "number";
        return {
          ...rest,
          annualCost: hasLump ? lumpSum : 0,
          fromYear: hasLump ? lumpSumYear : null,
          toYear: hasLump ? lumpSumYear : null,
        };
      }),
    },
  };
}

/**
 * v4 → v5. Additive: adds the optional withdrawal-tax section, disabled, so a
 * migrated v4 state simulates IDENTICALLY until the user enables it. The factory
 * is the single source of the defaults.
 * @param {any} v4
 * @returns {import("./schema.mjs").RunwayState}
 */
function migrateV4(v4) {
  return { ...v4, schemaVersion: 5, tax: { enabled: false, effectiveGainsRatePct: 18, embeddedGainPct: 50 } };
}

// The inflation rate assumed when converting old "real" (after-inflation)
// growth rates into the actual rates v6 stores. Matches newEconomy().
const MIGRATION_INFLATION_PCT = 2.5;

/**
 * Old real growth (vs inflation) -> v6 actual growth. 0 meant "moves with
 * inflation", which v6 spells as null; anything else is compounded with
 * inflation, e.g. +1% real -> 3.53% actual.
 * @param {unknown} real
 * @returns {number|null}
 */
function realToActualGrowth(real) {
  if (typeof real !== "number" || Number.isNaN(real) || real === 0) return null;
  const actual = ((1 + real / 100) * (1 + MIGRATION_INFLATION_PCT / 100) - 1) * 100;
  return Math.round(actual * 100) / 100;
}

/**
 * v5 -> v6: the multi-account, three-bucket model.
 *   - The single portfolio balance becomes one taxable account. Its cost basis
 *     comes from the old "taxable-gain share" (50% gain share -> basis is half
 *     the balance), which was the old model's only notion of basis.
 *   - The old single real return is dropped: returns now come from the three
 *     bucket assumptions and the time-based split.
 *   - The old withdrawal-tax section becomes the taxes section (its capital
 *     gains rate carries over).
 *   - Every real growth rate becomes an actual rate (null = with inflation).
 * @param {any} v5
 * @returns {import("./schema.mjs").RunwayState}
 */
function migrateV5(v5) {
  const { portfolio, tax, ...rest } = v5;
  const balance = num(portfolio?.balance, 0);
  const gainShare = Math.min(100, Math.max(0, num(tax?.embeddedGainPct, 50)));
  const accounts = balance > 0
    ? [{ name: "Portfolio (from the old app)", type: "taxable", balance, costBasis: Math.round(balance * (1 - gainShare / 100)), contributionAnnual: 0, employerMatchAnnual: 0, contributeUntilAge: null, contributionGrowthPct: null }]
    : [];
  return {
    ...rest,
    schemaVersion: 6,
    economy: newEconomy(),
    accounts,
    buckets: newBuckets(),
    taxes: { ...newTaxes(), capitalGainsPct: num(tax?.effectiveGainsRatePct, newTaxes().capitalGainsPct) },
    properties: arr(v5.properties).map((/** @type {any} */ p) => {
      const { rentRealGrowthPct, costsRealGrowthPct, ...pr } = p;
      return { ...pr, rentGrowthPct: realToActualGrowth(rentRealGrowthPct), costsGrowthPct: realToActualGrowth(costsRealGrowthPct) };
    }),
    incomes: arr(v5.incomes).map((/** @type {any} */ inc) => {
      const { realGrowthPct, ...ir } = inc;
      return newIncome({ ...ir, growthPct: realToActualGrowth(realGrowthPct) });
    }),
    spending: arr(v5.spending).map((/** @type {any} */ c) => {
      const { realGrowthPct, ...cr } = c;
      return newSpendingCategory({ ...cr, growthPct: realToActualGrowth(realGrowthPct) });
    }),
  };
}

/**
 * v6 -> v7: account contributions run for a number of years instead of until
 * an age, and each account says how it's invested.
 *   - contributeUntilAge A -> contributeYears = A - currentAge + 1 (contributing
 *     at ages currentAge..A). A blank age meant "until the work-until age", so
 *     it converts the same way from work.untilAge, but only when contributions
 *     are actually set.
 *   - A 401(k) moves to its own fund (a target-date fund you don't manage) at
 *     the default own-fund return; every other account stays in the buckets.
 * @param {any} v6
 * @returns {import("./schema.mjs").RunwayState}
 */
function migrateV6(v6) {
  const age = num(v6.profile?.currentAge, 0);
  const workUntil = num(v6.work?.untilAge, age);
  return {
    ...v6,
    schemaVersion: 7,
    accounts: arr(v6.accounts).map((/** @type {any} */ a) => {
      const { contributeUntilAge, ...rest } = a;
      const contributes = num(a.contributionAnnual, 0) > 0 || num(a.employerMatchAnnual, 0) > 0;
      const until = typeof contributeUntilAge === "number" ? contributeUntilAge : contributes ? workUntil : age - 1;
      return newAccount({
        ...rest,
        contributeYears: Math.max(0, until - age + 1),
        invest: a.type === "401k" ? "own" : "buckets",
        ownReturnPct: DEFAULT_OWN_RETURN_PCT,
      });
    }),
  };
}

/**
 * v7 -> v8: the work-until age is gone. It only set the window for the old
 * "or earn $X/yr" answer, which was removed.
 * @param {any} v7
 * @returns {import("./schema.mjs").RunwayState}
 */
function migrateV7(v7) {
  const { work, ...rest } = v7;
  void work;
  return { ...rest, schemaVersion: 8 };
}

/**
 * v8 -> v9 (the Monte Carlo version): rental properties are removed, and the
 * simulation's inputs arrive with their defaults: each bucket's typical yearly
 * swing, each own-fund account's swing, and the success target. Bucket
 * returns still at the old defaults move to the new 3 / 6 / 8%.
 * @param {any} v8
 * @returns {import("./schema.mjs").RunwayState}
 */
function migrateV8(v8) {
  const { properties, ...rest } = v8;
  void properties;
  const fresh = newBuckets();
  const old = v8.buckets ?? {};
  // Returns still at the old defaults (2.5 / 5.5 / 9.5) move to the new ones;
  // any rate you changed yourself is kept.
  const untouched = old.preservationReturnPct === 2.5 && old.incomeReturnPct === 5.5 && old.equitiesReturnPct === 9.5;
  const returns = untouched
    ? { preservationReturnPct: fresh.preservationReturnPct, incomeReturnPct: fresh.incomeReturnPct, equitiesReturnPct: fresh.equitiesReturnPct }
    : {};
  return {
    ...rest,
    schemaVersion: 9,
    buckets: { ...old, ...returns, preservationVolPct: fresh.preservationVolPct, incomeVolPct: fresh.incomeVolPct, equitiesVolPct: fresh.equitiesVolPct },
    accounts: arr(v8.accounts).map((/** @type {any} */ a) => ({ ...a, ownVolPct: a.ownVolPct ?? DEFAULT_OWN_VOL_PCT })),
    simulation: newSimulation(),
  };
}

// Spending lines whose names sound fixed (not flexible) start unchecked as
// "variable" when a plan is upgraded to v10. Everything else starts checked.
const FIXED_SPENDING_RE = /hous|mortgage|\brent\b|property tax|\bhoa\b|insurance|child ?care|daycare|tuition|utilit/i;

/**
 * v9 -> v10: the "spend more" scenario becomes an input that applies only to
 * variable spending lines. Each line gains a `variable` flag (a best guess
 * from its name, shown as a checkbox to review), and the scenario's percent
 * (20, the old fixed shock) is added.
 * @param {any} v9
 * @returns {import("./schema.mjs").RunwayState}
 */
function migrateV9(v9) {
  return {
    ...v9,
    schemaVersion: 10,
    spending: arr(v9.spending).map((/** @type {any} */ c) => ({ ...c, variable: !FIXED_SPENDING_RE.test(String(c.name ?? "")) })),
    simulation: { ...newSimulation(), ...(v9.simulation ?? {}), spendMorePct: 20 },
  };
}

/**
 * v10 -> v11: required minimum distributions. Each account gains an owner
 * (you, by default) so RMDs start at the right person's age.
 * @param {any} v10
 * @returns {import("./schema.mjs").RunwayState}
 */
function migrateV10(v10) {
  return { ...v10, schemaVersion: 11, accounts: arr(v10.accounts).map((/** @type {any} */ a) => ({ ...a, owner: a.owner ?? "self" })) };
}

/**
 * v11 -> v12: "own fund" accounts (their own return and swing) are replaced by
 * accounts dedicated to one bucket, which earn that bucket's return and count
 * toward its target. Each own-fund account moves to the bucket whose swing is
 * closest to its own (ties: the closest return); review the choice.
 * @param {any} v11
 * @returns {import("./schema.mjs").RunwayState}
 */
function migrateV11(v11) {
  const b = { ...newBuckets(), ...(v11.buckets ?? {}) };
  const options = /** @type {const} */ ([
    ["preservation", b.preservationVolPct, b.preservationReturnPct],
    ["income", b.incomeVolPct, b.incomeReturnPct],
    ["equities", b.equitiesVolPct, b.equitiesReturnPct],
  ]);
  return {
    ...v11,
    schemaVersion: 12,
    accounts: arr(v11.accounts).map((/** @type {any} */ a) => {
      const { ownReturnPct, ownVolPct, ...rest } = a;
      if (a.invest !== "own") return rest;
      const vol = num(ownVolPct, DEFAULT_OWN_VOL_PCT);
      const ret = num(ownReturnPct, DEFAULT_OWN_RETURN_PCT);
      const best = [...options].sort((x, y) => Math.abs(x[1] - vol) - Math.abs(y[1] - vol) || Math.abs(x[2] - ret) - Math.abs(y[2] - ret))[0];
      return { ...rest, invest: best[0] };
    }),
  };
}

/** @type {Record<number, (data: any) => any>} rung N migrates version N → N+1 */
const RUNGS = {
  0: migrateV0,
  1: migrateV1,
  2: migrateV2,
  3: migrateV3,
  4: migrateV4,
  5: migrateV5,
  6: migrateV6,
  7: migrateV7,
  8: migrateV8,
  9: migrateV9,
  10: migrateV10,
  11: migrateV11,
};

/**
 * Run the ladder from the data's version to SCHEMA_VERSION. Pure and
 * idempotent: already-current data returns an identical deep copy.
 * @param {any} data
 * @param {{declaredVersion?: number}} [opts] explicit-import path only (v0 export)
 * @returns {{state: import("./schema.mjs").RunwayState, fromVersion: number, migrated: boolean}}
 */
export function migrate(data, opts = {}) {
  let version = typeof data?.schemaVersion === "number" ? data.schemaVersion : opts.declaredVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) throw new MissingVersionError();
  if (version > SCHEMA_VERSION) throw new FutureVersionError(version);
  const fromVersion = version;
  let state = structuredClone(data);
  while (version < SCHEMA_VERSION) {
    const rung = RUNGS[version];
    if (!rung) throw new Error(`no migration rung from version ${version}`);
    state = rung(state);
    version = state.schemaVersion ?? version + 1;
  }
  return { state, fromVersion, migrated: fromVersion !== SCHEMA_VERSION };
}

/** @param {unknown} v @param {number} fallback */
function num(v, fallback) {
  return typeof v === "number" && !Number.isNaN(v) ? v : fallback;
}
/** @param {unknown} v */
function numOrNull(v) {
  return typeof v === "number" && !Number.isNaN(v) && v !== 0 ? v : null;
}
/** @param {unknown} v @param {string} fallback */
function str(v, fallback) {
  return typeof v === "string" && v.trim() ? v : fallback;
}
/** @param {unknown} v @returns {any[]} */
function arr(v) {
  return Array.isArray(v) ? v : [];
}
