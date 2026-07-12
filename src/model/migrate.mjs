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
import { SCHEMA_VERSION, defaultState, newSpendingCategory, newIncome, newProperty } from "./schema.mjs";

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
      realReturnPct: num(v0?.portfolio?.realReturnPct, d.portfolio.realReturnPct),
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
    work: { untilAge: num(v0?.work?.untilAge, d.work.untilAge) },
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
    properties: arr(v1.properties).map((p) => newProperty(p)),
    incomes: arr(v1.incomes).map((inc) => newIncome(inc)),
    spending: arr(v1.spending).map((c) => newSpendingCategory(c)),
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

/** @type {Record<number, (data: any) => any>} rung N migrates version N → N+1 */
const RUNGS = {
  0: migrateV0,
  1: migrateV1,
  2: migrateV2,
  3: migrateV3,
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
