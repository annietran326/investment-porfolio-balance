import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate, defaultState, SCHEMA_VERSION, newSocial, newHealth, newBuckets, newTaxes, newEconomy, newSimulation, reanchorYears } from "../src/model/schema.mjs";
import { migrate, MissingVersionError, FutureVersionError } from "../src/model/migrate.mjs";
import { placeholderState } from "../src/model/placeholder.mjs";

// A v0 export fixture matching the prototype's localStorage shape (no schemaVersion,
// endState {mode, amount}, silent-fallback-era gaps like a missing toYear).
const V0_EXPORT = {
  profile: { currentAge: 40, endAge: 92, currentYear: 2026 },
  portfolio: { balance: 1500000, realReturnPct: 4.0 },
  properties: [
    { name: "Rental A", rentMonthly: 3200, costsMonthly: 900, mortgageMonthly: 2400, payoffYear: 2049, saleYear: 2027, saleNetProceeds: 250000 },
    { name: "Rental B (keep)", rentMonthly: 2800, costsMonthly: 800, mortgageMonthly: 1900, payoffYear: 2047, saleYear: null, saleNetProceeds: null },
  ],
  incomes: [{ name: "W2", annual: 180000, fromYear: 2026 }], // toYear missing on purpose
  spending: [{ name: "living", monthly: 2500 }],
  social: { startAge: 67, monthly: 2800, haircutPct: 25 },
  health: { preMedicareAnnual: 18000, postMedicareAnnual: 7000, employerCoverageUntilAge: 40 },
  endState: { mode: "bequest", amount: 500000 },
  work: { untilAge: 50 },
};

test("placeholder and default states pass validation with no errors or warnings", () => {
  for (const s of [placeholderState(), defaultState()]) {
    const { errors, warnings } = validate(s);
    assert.deepEqual(errors, []);
    // placeholder has a 2027 sale with proceeds — no warnings expected either
    assert.deepEqual(warnings, []);
  }
});

test("text in a numeric field is an error naming the path", () => {
  const s = placeholderState();
  // @ts-expect-error deliberate corruption
  s.spending[0].monthly = "abc";
  const { errors } = validate(s);
  assert.ok(errors.some((e) => e.path === "spending[0].monthly" && e.message.includes("number")));
});

test("simulation inputs: swings 0–60%, success target 50–99%", () => {
  const s = placeholderState();
  s.buckets.equitiesVolPct = 70;
  s.accounts[2].ownVolPct = -1;
  s.simulation.targetSuccessPct = 100;
  const paths = validate(s).errors.map((e) => e.path);
  assert.ok(paths.includes("buckets.equitiesVolPct"));
  assert.ok(paths.includes("accounts[2].ownVolPct"));
  assert.ok(paths.includes("simulation.targetSuccessPct"));
  const ok = placeholderState();
  ok.buckets.preservationVolPct = 0; // a perfectly steady bucket is allowed
  assert.deepEqual(validate(ok).errors, []);
});

test("income window and end-age ordering rules", () => {
  const s = placeholderState();
  s.incomes[0].toYear = s.incomes[0].fromYear - 1;
  assert.ok(validate(s).errors.some((e) => e.path === "incomes[0].toYear"));

  const s2 = placeholderState();
  s2.profile.endAge = s2.profile.currentAge;
  assert.ok(validate(s2).errors.some((e) => e.path === "profile.endAge"));

  const s3 = placeholderState();
  s3.household.people[0].currentAge = s3.profile.endAge + 1; // spouse already past the plan-to age
  const r3 = validate(s3);
  assert.deepEqual(r3.errors, []);
  assert.ok(r3.warnings.some((w) => w.path === "household.people[0].currentAge"));
});

test("v0 export migrates via declaredVersion 0 and passes validation", () => {
  const { state, fromVersion, migrated } = migrate(V0_EXPORT, { declaredVersion: 0 });
  assert.equal(fromVersion, 0);
  assert.equal(migrated, true);
  assert.equal(state.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(validate(state).errors, []);
  // endState amount landed in the right mode slot
  assert.equal(state.endState.mode, "bequest");
  assert.equal(state.endState.amounts.bequest, 500000);
  assert.equal(state.endState.amounts.floor, 0);
  // missing toYear preserved v0's income-forever behavior (horizon end)
  assert.equal(state.incomes[0].toYear, 2026 + (92 - 40));
});

test("migration is idempotent on already-current data", () => {
  const once = migrate(V0_EXPORT, { declaredVersion: 0 }).state;
  const twice = migrate(once);
  assert.equal(twice.migrated, false);
  assert.deepEqual(twice.state, once);
});

test("missing schemaVersion without declaration is corrupt, never sniffed", () => {
  assert.throws(() => migrate(V0_EXPORT), MissingVersionError);
  assert.throws(() => migrate({ some: "garbage" }), MissingVersionError);
  assert.throws(() => migrate({ schemaVersion: "1" }), MissingVersionError);
});

test("future schemaVersion refuses with a clear message", () => {
  assert.throws(() => migrate({ schemaVersion: SCHEMA_VERSION + 1 }), FutureVersionError);
  try {
    migrate({ schemaVersion: 99 });
  } catch (e) {
    assert.match(/** @type {Error} */ (e).message, /update the app/);
  }
});

test("ladder purity: migrate.mjs performs no I/O (no node:fs, no Date, no clock)", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/model/migrate.mjs", import.meta.url)), "utf8");
  assert.ok(!/node:fs/.test(src), "migrate.mjs must not import node:fs");
  assert.ok(!/\bDate\b/.test(src), "migrate.mjs must not read the clock");
});

// ---- v2 (household + growth + expense windows) ----

const V1_FIXTURE = {
  schemaVersion: 1,
  profile: { currentAge: 45, endAge: 90, currentYear: 2026 },
  portfolio: { balance: 900000, realReturnPct: 3 },
  properties: [{ name: "Rental", rentMonthly: 3000, costsMonthly: 700, mortgageMonthly: 1500, payoffYear: 2040, saleYear: null, saleNetProceeds: null }],
  incomes: [{ name: "W2", annual: 150000, fromYear: 2026, toYear: 2028 }],
  spending: [{ name: "living", monthly: 4000 }],
  social: { startAge: 67, monthly: 2600, haircutPct: 25 },
  health: { preMedicareAnnual: 16000, postMedicareAnnual: 7500, employerCoverageUntilAge: 45 },
  endState: { mode: "bequest", amounts: { bequest: 100000, floor: 0 } },
  work: { untilAge: 55 },
};

test("v1 → current migration is additive: preserves values, adds safe defaults, validates", () => {
  const { state, fromVersion, migrated } = migrate(V1_FIXTURE);
  assert.equal(fromVersion, 1);
  assert.equal(migrated, true);
  assert.equal(state.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(validate(state).errors, []);
  // every v1 value preserved (the single balance became one taxable account)
  assert.equal(state.accounts.length, 1);
  assert.equal(state.accounts[0].type, "taxable");
  assert.equal(state.accounts[0].balance, 900000);
  assert.equal(state.incomes[0].annual, 150000);
  assert.equal(state.incomes[0].toYear, 2028);
  assert.equal(state.spending[0].monthly, 4000);
  assert.equal(state.endState.amounts.bequest, 100000);
  assert.ok(!("properties" in state), "rental properties are dropped in v9");
  // new fields default to "no change": open windows, rates that follow inflation
  assert.equal(state.spending[0].fromYear, null);
  assert.equal(state.spending[0].toYear, null);
  assert.equal(state.spending[0].growthPct, null);
  assert.equal(state.incomes[0].growthPct, null);
  assert.deepEqual(state.household, { people: [] });
});

test("migrating an already-current state is a no-op", () => {
  const cur = migrate(V1_FIXTURE).state;
  const again = migrate(cur);
  assert.equal(again.migrated, false);
  assert.deepEqual(again.state, cur);
});

test("v0 → … → current chains through every rung", () => {
  const { state } = migrate(V0_EXPORT, { declaredVersion: 0 });
  assert.equal(state.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(validate(state).errors, []);
  assert.deepEqual(state.household, { people: [] });
  assert.equal(state.spending[0].growthPct, null);
  assert.equal(state.accounts[0].balance, 1500000);
});

test("v2 → current migration adds dependent support fields; v3 lump sum becomes a one-year window", () => {
  const v2 = {
    ...migrate(V1_FIXTURE).state,
    schemaVersion: 2,
    household: {
      people: [
        { name: "Spouse", role: "spouse", currentAge: 40, social: { startAge: 67, monthly: 2000, haircutPct: 25 }, health: { preMedicareAnnual: 16000, postMedicareAnnual: 7500, employerCoverageUntilAge: 65 } },
        { name: "Kid", role: "dependent", currentAge: 8 },
      ],
    },
  };
  const { state } = migrate(v2);
  assert.equal(state.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(validate(state).errors, []);
  for (const person of state.household.people) {
    assert.equal(person.annualCost, 0);
    assert.equal(person.fromYear, null);
    assert.equal(person.toYear, null);
  }

  // a v3 lump sum migrates losslessly to a one-year window
  const v3 = { ...state, schemaVersion: 3, household: { people: [{ name: "Kid", role: "dependent", currentAge: null, lumpSum: 150000, lumpSumYear: 2044 }] } };
  const { state: s4 } = migrate(v3);
  assert.deepEqual(validate(s4).errors, []);
  assert.equal(s4.household.people[0].annualCost, 150000);
  assert.equal(s4.household.people[0].fromYear, 2044);
  assert.equal(s4.household.people[0].toYear, 2044);
});

test("reanchorYears shifts every year field by the delta and preserves nulls", () => {
  const s = placeholderState(); // BASE_YEAR 2026
  const moved = reanchorYears(s, 2030); // +4
  assert.equal(moved.profile.currentYear, 2030);
  assert.equal(moved.incomes[0].fromYear, s.incomes[0].fromYear + 4);
  assert.equal(moved.incomes[0].toYear, s.incomes[0].toYear + 4);
  assert.equal(moved.spending[0].toYear, null); // perpetual stays null
  assert.equal(moved.household.people[1].toYear, 2040 + 4);
  // delta 0 is identity
  assert.equal(reanchorYears(s, s.profile.currentYear), s);
  // original untouched (pure)
  assert.equal(s.profile.currentYear, 2026);
});

test("spending validation: window ordering, growth type, and extreme-growth warning", () => {
  const s = placeholderState();
  s.spending[1].fromYear = 2030;
  s.spending[1].toYear = 2025;
  assert.ok(validate(s).errors.some((e) => e.path === "spending[1].toYear"));

  const s2 = placeholderState();
  // @ts-expect-error deliberate wrong type
  s2.spending[0].growthPct = "3%";
  assert.ok(validate(s2).errors.some((e) => e.path === "spending[0].growthPct"));

  const s3 = placeholderState();
  s3.spending[0].growthPct = 40; // extreme → warn (likely a typo)
  assert.ok(validate(s3).warnings.some((w) => w.path === "spending[0].growthPct"));

  const s3b = placeholderState();
  s3b.spending[0].growthPct = null; // blank = with inflation, valid
  assert.deepEqual(validate(s3b).errors, []);

  const s4 = placeholderState();
  s4.spending[0].toYear = 2000; // ended in the past
  assert.ok(validate(s4).warnings.some((w) => w.path === "spending[0].toYear"));
});

test("v2 validation: household people and spouse sub-objects", () => {
  assert.deepEqual(validate(placeholderState()).errors, []); // placeholder spouse+dependent are valid

  const bad = placeholderState();
  // @ts-expect-error deliberate wrong type on the spouse's SS
  bad.household.people[0].social.startAge = "67";
  assert.ok(validate(bad).errors.some((e) => e.path === "household.people[0].social.startAge"));

  const twoSpouses = placeholderState();
  twoSpouses.household.people.push({ name: "Second spouse", role: "spouse", currentAge: 40, lumpSum: 0, lumpSumYear: null, social: newSocial(), health: newHealth() });
  assert.ok(validate(twoSpouses).warnings.some((w) => w.path === "household.people"));

  const spouseNoAge = placeholderState();
  spouseNoAge.household.people[0].currentAge = null;
  assert.ok(validate(spouseNoAge).warnings.some((w) => w.path === "household.people[0].currentAge"));

  const badRole = placeholderState();
  // @ts-expect-error deliberate bad role
  badRole.household.people[1].role = "pet";
  assert.ok(validate(badRole).errors.some((e) => e.path === "household.people[1].role"));
});

// ---- v6: accounts, buckets, taxes, inflation ----

test("default and placeholder states carry v6 sections that validate clean", () => {
  for (const s of [defaultState(), placeholderState()]) {
    assert.deepEqual(s.economy, newEconomy());
    assert.deepEqual(s.buckets, newBuckets());
    assert.deepEqual(s.taxes, newTaxes());
    const { errors, warnings } = validate(s);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  }
  assert.deepEqual(newBuckets(), {
    preservationReturnPct: 3, incomeReturnPct: 6, equitiesReturnPct: 8, preservationYears: 8, incomeThroughYear: 15,
    preservationVolPct: 1, incomeVolPct: 8, equitiesVolPct: 17,
  });
  assert.deepEqual(newSimulation(), { targetSuccessPct: 90 });
  assert.equal(newEconomy().inflationPct, 2.5);
});

test("account validation: type, numbers, negative balance, basis and match sanity", () => {
  const badType = placeholderState();
  // @ts-expect-error deliberate bad type
  badType.accounts[0].type = "hsa";
  assert.ok(validate(badType).errors.some((e) => e.path === "accounts[0].type"));

  const neg = placeholderState();
  neg.accounts[1].balance = -5;
  assert.ok(validate(neg).errors.some((e) => e.path === "accounts[1].balance"));

  const text = placeholderState();
  // @ts-expect-error deliberate wrong type
  text.accounts[0].costBasis = "380k";
  assert.ok(validate(text).errors.some((e) => e.path === "accounts[0].costBasis"));

  const loss = placeholderState();
  loss.accounts[0].costBasis = loss.accounts[0].balance + 1; // unrealized loss: fine, but flagged
  const lossResult = validate(loss);
  assert.deepEqual(lossResult.errors, []);
  assert.ok(lossResult.warnings.some((w) => w.path === "accounts[0].costBasis"));

  const rothMatch = placeholderState();
  rothMatch.accounts[3].employerMatchAnnual = 1000;
  assert.ok(validate(rothMatch).warnings.some((w) => w.path === "accounts[3].employerMatchAnnual"));
});

test("bucket validation: cutoffs ordered, returns numeric, odd return order warns", () => {
  const order = placeholderState();
  order.buckets.incomeThroughYear = 5; // before preservation's 8
  assert.ok(validate(order).errors.some((e) => e.path === "buckets.incomeThroughYear"));

  const neg = placeholderState();
  neg.buckets.preservationYears = -1;
  assert.ok(validate(neg).errors.some((e) => e.path === "buckets.preservationYears"));

  const zero = placeholderState();
  zero.buckets.preservationYears = 0; // no capital preservation bucket at all: allowed
  assert.deepEqual(validate(zero).errors, []);

  const flipped = placeholderState();
  flipped.buckets.equitiesReturnPct = 1;
  const r = validate(flipped);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.path === "buckets.equitiesReturnPct"));

  const missing = placeholderState();
  // @ts-expect-error deliberate missing section
  delete missing.buckets;
  assert.ok(validate(missing).errors.some((e) => e.path === "buckets" && /missing section/.test(e.message)));
});

test("tax rates and inflation outside expected bands warn but do not reject", () => {
  const hot = placeholderState();
  hot.taxes.ordinaryIncomePct = 80;
  hot.economy.inflationPct = 30;
  const { errors, warnings } = validate(hot);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.path === "taxes.ordinaryIncomePct"));
  assert.ok(warnings.some((w) => w.path === "economy.inflationPct"));
});

test("v5 → v6: balance becomes a taxable account with basis from the old gain share; real growth becomes actual", () => {
  const v5 = {
    schemaVersion: 5,
    profile: { currentAge: 40, endAge: 95, currentYear: 2026 },
    portfolio: { balance: 1_000_000, realReturnPct: 3.5 },
    tax: { enabled: true, effectiveGainsRatePct: 20, embeddedGainPct: 40 },
    properties: [{ name: "Rental", rentMonthly: 2000, costsMonthly: 500, mortgageMonthly: 1000, payoffYear: 2040, saleYear: null, saleNetProceeds: null, rentRealGrowthPct: 1, costsRealGrowthPct: 0 }],
    incomes: [{ name: "Job", annual: 100_000, fromYear: 2026, toYear: 2030, realGrowthPct: 0 }],
    spending: [{ name: "living", monthly: 4000, fromYear: null, toYear: null, realGrowthPct: -1 }],
    social: { startAge: 67, monthly: 2000, haircutPct: 25 },
    health: { preMedicareAnnual: 16000, postMedicareAnnual: 7500, employerCoverageUntilAge: 50 },
    household: { people: [] },
    endState: { mode: "zero", amounts: { bequest: 0, floor: 0 } },
    work: { untilAge: 50 },
  };
  const { state, fromVersion } = migrate(v5);
  assert.equal(fromVersion, 5);
  assert.equal(state.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(validate(state).errors, []);
  assert.ok(!("portfolio" in state) && !("tax" in state), "old sections are gone");
  assert.equal(state.accounts.length, 1);
  assert.equal(state.accounts[0].type, "taxable");
  assert.equal(state.accounts[0].balance, 1_000_000);
  assert.equal(state.accounts[0].costBasis, 600_000, "40% gain share → basis is 60% of the balance");
  assert.equal(state.taxes.capitalGainsPct, 20, "the old gains rate carries over");
  assert.ok(!("properties" in state), "the rental is dropped by the v9 rung");
  assert.equal(state.incomes[0].growthPct, null);
  assert.equal(state.spending[0].growthPct, 1.47, "−1% real → 1.47% actual (0.99 × 1.025)");
  assert.ok(!("realGrowthPct" in state.spending[0]));
});

test("v5 → v6 with no balance makes no account", () => {
  const { tax, ...rest } = /** @type {any} */ ({ ...migrate(V1_FIXTURE).state });
  void tax;
  const v5 = { ...rest, schemaVersion: 5, portfolio: { balance: 0, realReturnPct: 3.5 } };
  const { state } = migrate(v5);
  assert.deepEqual(state.accounts, []);
  assert.deepEqual(validate(state).errors, []);
});

test("v6 → v7: contribute-until age becomes years; a 401(k) moves to its own fund; others stay in the buckets", () => {
  const base = placeholderState();
  const v6 = {
    ...base,
    schemaVersion: 6,
    profile: { currentAge: 45, endAge: 95, currentYear: 2026 },
    work: { untilAge: 55 },
    accounts: [
      { name: "Brokerage", type: "taxable", balance: 100_000, costBasis: 80_000, contributionAnnual: 0, employerMatchAnnual: 0, contributeUntilAge: null, contributionGrowthPct: null },
      { name: "401k", type: "401k", balance: 50_000, costBasis: null, contributionAnnual: 20_000, employerMatchAnnual: 5_000, contributeUntilAge: 50, contributionGrowthPct: null },
      { name: "Roth", type: "roth_ira", balance: 10_000, costBasis: null, contributionAnnual: 7_000, employerMatchAnnual: 0, contributeUntilAge: null, contributionGrowthPct: 2 },
    ],
  };
  const { state, fromVersion } = migrate(v6);
  assert.equal(fromVersion, 6);
  assert.deepEqual(validate(state).errors, []);
  const [brk, k401, roth] = state.accounts;
  assert.equal(brk.contributeYears, 0, "no contributions → 0 years");
  assert.equal(k401.contributeYears, 6, "ages 45..50 → 6 years");
  assert.equal(roth.contributeYears, 11, "blank age meant 'until work-until age' (55) → ages 45..55");
  assert.equal(k401.invest, "own");
  assert.equal(k401.ownReturnPct, 7);
  assert.equal(brk.invest, "buckets");
  assert.equal(roth.invest, "buckets");
  assert.ok(!("contributeUntilAge" in k401));
  assert.equal(roth.contributionGrowthPct, 2, "other fields carry over");
});

test("v7 → v8 drops the work-until age; nothing else changes", () => {
  const v7 = { ...placeholderState(), schemaVersion: 7, work: { untilAge: 55 } };
  const { state, fromVersion } = migrate(v7);
  assert.equal(fromVersion, 7);
  assert.ok(!("work" in state));
  assert.deepEqual(validate(state).errors, []);
  const { schemaVersion, work, ...before } = v7;
  void schemaVersion;
  void work;
  const { schemaVersion: _sv, ...after } = state;
  void _sv;
  assert.deepEqual(after, before);
});

test("v8 → v9 drops rental properties, adds swings and the success target, and moves untouched default returns to 3 / 6 / 8", () => {
  const { simulation, ...base } = placeholderState();
  void simulation;
  const v8 = {
    ...base,
    schemaVersion: 8,
    properties: [{ name: "Rental", rentMonthly: 2000, costsMonthly: 500, mortgageMonthly: 1000, payoffYear: 2040, saleYear: null, saleNetProceeds: null, rentGrowthPct: null, costsGrowthPct: null }],
    buckets: { preservationReturnPct: 2.5, incomeReturnPct: 5.5, equitiesReturnPct: 9.5, preservationYears: 8, incomeThroughYear: 15 },
    accounts: base.accounts.map(({ ownVolPct, ...a }) => (void ownVolPct, a)),
  };
  const { state, fromVersion } = migrate(v8);
  assert.equal(fromVersion, 8);
  assert.deepEqual(validate(state).errors, []);
  assert.ok(!("properties" in state));
  assert.deepEqual(state.buckets, newBuckets(), "old default returns → new defaults, swings added");
  assert.ok(state.accounts.every((a) => a.ownVolPct === 15));
  assert.deepEqual(state.simulation, newSimulation());

  const custom = { ...v8, buckets: { ...v8.buckets, equitiesReturnPct: 7.25 } };
  const kept = migrate(custom).state;
  assert.equal(kept.buckets.equitiesReturnPct, 7.25, "a rate you changed is kept");
  assert.equal(kept.buckets.preservationReturnPct, 2.5);
});
