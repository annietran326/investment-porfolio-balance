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
import { SCHEMA_VERSION, defaultState } from "./schema.mjs";

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
 * @param {any} v0
 * @returns {import("./schema.mjs").RunwayState}
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

/** @type {Record<number, (data: any) => any>} rung N migrates version N → N+1 */
const RUNGS = {
  0: migrateV0,
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
