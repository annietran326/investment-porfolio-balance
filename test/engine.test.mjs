import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { simulate, EARLY_WITHDRAWAL_START_AGE } from "../src/engine/simulate.mjs";
import { propertyCashflowYear, SALE_YEAR_OWNED_MONTHS } from "../src/engine/property.mjs";
import { pvFactor, bucketTargets, allocate, bucketFor, shares } from "../src/engine/buckets.mjs";
import { placeholderState } from "../src/model/placeholder.mjs";
import { newAccount, newBuckets, newTaxes, validate } from "../src/model/schema.mjs";

const state = () => placeholderState();

/** Equal within a cent (rows convert through inflation, so exact equality can drift by float noise). */
function near(actual, expected, msg, tol = 0.01) {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ""} expected ${expected}, got ${actual}`);
}

/**
 * A bare plan for hand-computed tests: no inflation, every bucket earning the
 * same return (so the split can't change the result), no Social Security,
 * healthcare, property, household, or income unless a test adds it.
 * @param {{age?: number, years?: number, returnPct?: number, inflationPct?: number, accounts?: any[], spendMonthly?: number}} [o]
 */
function flat(o = {}) {
  const s = state();
  const age = o.age ?? 60;
  s.profile = { currentAge: age, endAge: age + (o.years ?? 3), currentYear: 2026 };
  s.economy = { inflationPct: o.inflationPct ?? 0 };
  const r = o.returnPct ?? 0;
  s.buckets = { ...newBuckets(), preservationReturnPct: r, incomeReturnPct: r, equitiesReturnPct: r };
  s.taxes = { ordinaryIncomePct: 0, capitalGainsPct: 0 };
  s.accounts = o.accounts ?? [newAccount({ name: "Brokerage", type: "taxable", balance: 100_000 })];
  s.properties = [];
  s.incomes = [];
  s.spending = o.spendMonthly ? [{ name: "living", monthly: o.spendMonthly, fromYear: null, toYear: null, growthPct: null }] : [];
  s.social = { startAge: 67, monthly: 0, haircutPct: 0 };
  s.health = { preMedicareAnnual: 0, postMedicareAnnual: 0, employerCoverageUntilAge: 200 };
  s.household = { people: [] };
  s.endState = { mode: "zero", amounts: { bequest: 0, floor: 0 } };
  s.work = { untilAge: age };
  return s;
}

// ---------------------------------------------------------------------------
// shape and ordering
// ---------------------------------------------------------------------------

test("simulates from the current year to plan-to age; the current year shows the starting balance", () => {
  const s = state();
  const years = s.profile.endAge - s.profile.currentAge;
  const sim = simulate(s);
  const total = s.accounts.reduce((sum, a) => sum + a.balance, 0);
  assert.equal(sim.path.length, years + 1);
  assert.equal(sim.path[0].year, s.profile.currentYear);
  assert.equal(sim.path[0].age, s.profile.currentAge);
  assert.equal(sim.path[0].bal, total, "starts EXACTLY at the sum of the accounts");
  assert.equal(sim.path.at(-1)?.age, s.profile.endAge);
  assert.equal(sim.rows.length, years);
  assert.equal(sim.rows.at(-1)?.age, s.profile.endAge - 1);
});

test("balance-update ordering: growth on the start-of-year balance, then net cash lands", () => {
  // 1000 at 10%, +100/yr income: 1000*1.1 + 100 = 1200; 1200*1.1 + 100 = 1420.
  const s = flat({ returnPct: 10, accounts: [newAccount({ name: "b", type: "taxable", balance: 1000 })] });
  s.incomes = [{ name: "x", annual: 100, fromYear: 2026, toYear: 9999, growthPct: 0 }];
  const sim = simulate(s);
  near(sim.rows[0].bal, 1200);
  near(sim.rows[1].bal, 1420);
});

test("results are in today's dollars: inflation-linked spending with a matching return holds the balance flat", () => {
  // Inflation 10%, every bucket earns 10% (0% after inflation), spending
  // $12,000/yr rising with inflation. Year 0 in actual dollars:
  // 1,000,000 × 1.1 − 12,000 = 1,088,000, reported in today's dollars by
  // dividing by one year of inflation (÷ 1.1). Each row's spend reads $12,000.
  const s = flat({ returnPct: 10, inflationPct: 10, spendMonthly: 1000, accounts: [newAccount({ name: "b", type: "taxable", balance: 1_000_000 })] });
  const sim = simulate(s);
  near(sim.rows[0].spend, 12_000, "spend in today's $");
  near(sim.rows[0].bal, (1_000_000 * 1.1 - 12_000) / 1.1, "year-end balance in today's $");
  near(sim.rows[1].spend, 12_000, "inflation-linked spending is flat in today's $");
});

test("a line's own increase rate compounds from the current year (actual dollars, reported in today's $)", () => {
  const s = flat({ inflationPct: 2, years: 8 });
  s.incomes = [{ name: "grows", annual: 100_000, fromYear: 2026, toYear: 9999, growthPct: 4 }];
  s.spending = [{ name: "tuition (starts 2031)", monthly: 1000, fromYear: 2031, toYear: null, growthPct: 5 }];
  const sim = simulate(s);
  near(sim.rows[0].income, 100_000);
  near(sim.rows[5].income, (100_000 * 1.04 ** 5) / 1.02 ** 5, "4% actual growth, shown after 2% inflation");
  assert.equal(sim.rows[4].spend, 0, "inactive before its window");
  near(sim.rows[5].spend, (12_000 * 1.05 ** 5) / 1.02 ** 5, "grows from the current year, not from its start year");
});

// ---------------------------------------------------------------------------
// taxes: cost basis, ordinary income, penalty, Roth, order
// ---------------------------------------------------------------------------

test("taxable account: tax on the gain share, grossed up; a sale keeps the gain share unchanged", () => {
  // $100k, basis $60k → gain share 40%. Capital gains 20% → 8% of each sale.
  // Covering $10k after tax means selling 10000 / 0.92 = 10,869.57 with
  // $869.57 tax. Basis falls by 60% of the sale; value and basis shrink
  // together, so the gain share stays 40%.
  const s = flat({ spendMonthly: 10_000 / 12, accounts: [newAccount({ name: "b", type: "taxable", balance: 100_000, costBasis: 60_000 })] });
  s.taxes.capitalGainsPct = 20;
  const sim = simulate(s);
  const sold = 10_000 / 0.92;
  near(sim.rows[0].withdrawn, sold);
  near(sim.rows[0].tax, sold * 0.08);
  near(sim.rows[0].bal, 100_000 - sold);
  near(sim.rows[1].tax, sim.rows[0].tax, "same gain share next year → same tax");
});

test("taxable account: growth raises the gain share, so later sales are taxed more", () => {
  // $100k with basis $100k (no gain), 10% growth, first withdrawal in year 1.
  // Year 0: 100k → 110k, no sale. Year 1: 110k → 121k; gain share = 1 − 100/121.
  const s = flat({ returnPct: 10, accounts: [newAccount({ name: "b", type: "taxable", balance: 100_000, costBasis: null })] });
  s.taxes.capitalGainsPct = 20;
  s.spending = [{ name: "later", monthly: 1000, fromYear: 2027, toYear: null, growthPct: 0 }];
  const sim = simulate(s);
  assert.equal(sim.rows[0].tax, 0);
  const rate = (1 - 100_000 / 121_000) * 0.2;
  const sold = 12_000 / (1 - rate);
  near(sim.rows[1].withdrawn, sold);
  near(sim.rows[1].tax, sold * rate);
});

test("taxable basis is in actual dollars: inflation alone creates taxable gain", () => {
  // Returns equal inflation (0% real). The balance holds its value in today's
  // dollars, but its actual-dollar value rises above the basis, so a sale owes tax.
  const s = flat({ returnPct: 3, inflationPct: 3, spendMonthly: 1000, accounts: [newAccount({ name: "b", type: "taxable", balance: 100_000 })] });
  s.taxes.capitalGainsPct = 15;
  const sim = simulate(s);
  assert.ok(sim.rows[0].tax > 0, "a purely inflationary gain is still taxed");
});

test("traditional IRA / 401(k): ordinary rate on the whole withdrawal; +10% before 59½", () => {
  const trad = (age) => {
    const s = flat({ age, spendMonthly: 7500 / 12, accounts: [newAccount({ name: "ira", type: "traditional_ira", balance: 100_000 })] });
    s.taxes.ordinaryIncomePct = 25;
    return simulate(s);
  };
  const at60 = trad(60);
  near(at60.rows[0].withdrawn, 10_000, "7500 / (1 − 0.25)");
  near(at60.rows[0].tax, 2_500);
  assert.deepEqual(at60.earlyDeferredYears, []);

  const at50 = trad(50);
  near(at50.rows[0].withdrawn, 7500 / 0.65, "25% tax + 10% penalty");
  assert.deepEqual(at50.earlyDeferredYears, [2026, 2027, 2028]);
  assert.equal(EARLY_WITHDRAWAL_START_AGE, 59, "penalty applies while under 59½ at mid-year");
  assert.deepEqual(trad(58).earlyDeferredYears, [2026], "58 penalized; 59 (turns 59½ mid-year) not");
});

test("Roth: tax-free, and tapping it before 59½ is flagged", () => {
  const s = flat({ age: 50, spendMonthly: 1000, accounts: [newAccount({ name: "roth", type: "roth_ira", balance: 100_000 })] });
  s.taxes = { ordinaryIncomePct: 30, capitalGainsPct: 30 };
  const sim = simulate(s);
  assert.equal(sim.rows[0].tax, 0);
  near(sim.rows[0].withdrawn, 12_000);
  assert.deepEqual(sim.earlyRothYears, [2026, 2027, 2028]);
});

test("withdrawal order: taxable first, then traditional, then Roth", () => {
  // Need $30k/yr. Taxable holds $20k (no gain), IRA $15k, Roth $100k, no tax.
  // Year 0: all $20k taxable + $10k IRA. Year 1: last $5k IRA + $25k Roth.
  const s = flat({
    spendMonthly: 2500,
    accounts: [
      newAccount({ name: "roth", type: "roth_ira", balance: 100_000 }),
      newAccount({ name: "ira", type: "traditional_ira", balance: 15_000 }),
      newAccount({ name: "brk", type: "taxable", balance: 20_000 }),
    ],
  });
  s.taxes.ordinaryIncomePct = 20;
  const sim = simulate(s);
  // Year 0: 20k taxable (untaxed, no gain) + 10k net from the IRA = 12.5k gross.
  near(sim.rows[0].withdrawn, 20_000 + 12_500);
  near(sim.rows[0].tax, 2_500);
  // Year 1: IRA has 2.5k left (net 2k), Roth covers the other 28k.
  near(sim.rows[1].withdrawn, 2_500 + 28_000);
  near(sim.rows[1].tax, 500);
});

test("surplus income is saved to the taxable account at full basis (no tax when it comes back out)", () => {
  const s = flat({ accounts: [newAccount({ name: "b", type: "taxable", balance: 0 })], years: 2 });
  s.taxes.capitalGainsPct = 20;
  s.incomes = [{ name: "job", annual: 50_000, fromYear: 2026, toYear: 2026, growthPct: 0 }];
  s.spending = [{ name: "later", monthly: 1000, fromYear: 2027, toYear: null, growthPct: 0 }];
  const sim = simulate(s);
  near(sim.rows[0].bal, 50_000);
  assert.equal(sim.rows[1].tax, 0, "saved cash has no gain at 0% growth");
});

test("when every account is empty the shortfall is borrowed: balance goes negative", () => {
  const s = flat({ spendMonthly: 1000, accounts: [newAccount({ name: "b", type: "taxable", balance: 5_000 })] });
  const sim = simulate(s);
  near(sim.rows[0].bal, 5_000 - 12_000);
  assert.equal(sim.firstNegYear, 2027);
});

// ---------------------------------------------------------------------------
// contributions
// ---------------------------------------------------------------------------

test("401(k) contributions + employer match land at year end for the number of years entered", () => {
  // Age 50, contribute $20k + $5k match for 2 more years. No growth, no inflation.
  const s = flat({ age: 50, years: 4, accounts: [newAccount({ name: "401k", type: "401k", balance: 0, contributionAnnual: 20_000, employerMatchAnnual: 5_000, contributeYears: 2 })] });
  const sim = simulate(s);
  near(sim.rows[0].contrib, 25_000);
  near(sim.rows[1].contrib, 25_000);
  assert.equal(sim.rows[2].contrib, 0, "stops after the years entered");
  near(sim.rows[1].bal, 50_000);
});

test("contributions rise with inflation when the increase is blank, and 0 years means none", () => {
  const s = flat({ age: 50, years: 4, inflationPct: 3, accounts: [newAccount({ name: "401k", type: "401k", balance: 0, contributionAnnual: 10_000, contributeYears: 3 })] });
  const sim = simulate(s);
  near(sim.rows[2].contrib, 10_000, "flat in today's $ (rises with inflation in actual $)");
  assert.equal(sim.rows[3].contrib, 0);
  const none = flat({ accounts: [newAccount({ name: "401k", type: "401k", balance: 0, contributionAnnual: 10_000, contributeYears: 0 })] });
  assert.ok(simulate(none).rows.every((r) => r.contrib === 0));
  assert.ok(validate(none).warnings.some((w) => w.path === "accounts[0].contributeYears"), "contributions with 0 years is flagged");
});

test("an own-fund account earns its own return and stays out of the split", () => {
  // Bucket plan earns 0%; the 401(k) sits in its own fund at 7%. No spending.
  const s = flat({
    accounts: [
      newAccount({ name: "Brokerage", type: "taxable", balance: 100_000 }),
      newAccount({ name: "401k", type: "401k", balance: 50_000, invest: "own", ownReturnPct: 7 }),
    ],
  });
  const sim = simulate(s);
  near(sim.startOwn, 50_000);
  const split = sim.startMix;
  near(split.preservation + split.income + split.equities, 100_000, "the split covers only bucket-plan money");
  near(sim.rows[0].bal, 100_000 + 50_000 * 1.07);
  near(sim.rows[0].returnPct, ((150_000 + 3_500) / 150_000 - 1) * 100, "row return is for everything combined", 1e-9);
  near(sim.rows[1].ownBal, 53_500);
});

test("own-fund money counts as long-term: it reduces the equities target first", () => {
  // Cutoffs 1 / 2, all returns 0, $12k/yr for 3 years → targets 12k / 12k / 12k.
  const s = flat({ spendMonthly: 1000, accounts: [newAccount({ name: "b", type: "taxable", balance: 36_000 })] });
  s.buckets = { preservationReturnPct: 0, incomeReturnPct: 0, equitiesReturnPct: 0, preservationYears: 1, incomeThroughYear: 2 };
  assert.deepEqual(simulate(s).startMix, { preservation: 12_000, income: 12_000, equities: 12_000 });
  // Add $12k in an own fund: the bucket plan no longer needs equities.
  s.accounts.push(newAccount({ name: "401k", type: "401k", balance: 12_000, invest: "own", ownReturnPct: 0 }));
  assert.deepEqual(simulate(s).startMix, { preservation: 12_000, income: 12_000, equities: 12_000 }, "the extra $12k in the plan is surplus, so it sits in equities");
  s.accounts[0].balance = 24_000;
  assert.deepEqual(simulate(s).startMix, { preservation: 12_000, income: 12_000, equities: 0 });
});

test("withdrawals use bucket-plan money before own-fund money of the same tax type", () => {
  const s = flat({
    spendMonthly: 1000,
    accounts: [
      newAccount({ name: "401k (own)", type: "401k", balance: 100_000, invest: "own", ownReturnPct: 0 }),
      newAccount({ name: "IRA", type: "traditional_ira", balance: 15_000 }),
    ],
  });
  const sim = simulate(s);
  // Year 0 takes $12k from the IRA; year 1 takes the IRA's last $3k then $9k from the 401(k).
  near(sim.rows[0].ownBal, 100_000);
  near(sim.rows[1].ownBal, 100_000, "own fund untouched in year 0");
  near(sim.rows[2].ownBal, 91_000);
});

test("market crash: own funds fall the full equity drop", () => {
  const s = flat({ accounts: [newAccount({ name: "401k", type: "401k", balance: 100_000, invest: "own", ownReturnPct: 0 })] });
  near(simulate(s, { drawdownPct: 30 }).path[0].bal, 70_000);
});

// ---------------------------------------------------------------------------
// the three buckets
// ---------------------------------------------------------------------------

test("bucketFor and pvFactor follow the time-based rule (hand-computed)", () => {
  const b = newBuckets(); // 8 / 15; 2.5 / 5.5 / 9.5 %
  assert.equal(bucketFor(1, b), "preservation");
  assert.equal(bucketFor(8, b), "preservation");
  assert.equal(bucketFor(9, b), "income");
  assert.equal(bucketFor(15, b), "income");
  assert.equal(bucketFor(16, b), "equities");
  const r = { preservation: 0.025, income: 0.055, equities: 0.095 };
  near(pvFactor(3, b, r), 1 / 1.025 ** 3, "", 1e-12);
  near(pvFactor(10, b, r), 1 / (1.025 ** 8 * 1.055 ** 2), "", 1e-12);
  near(pvFactor(20, b, r), 1 / (1.025 ** 8 * 1.055 ** 7 * 1.095 ** 5), "20 years out: 5 in equities, 7 in high income, 8 in preservation", 1e-12);
});

test("allocate: surplus goes to equities; a shortfall scales every bucket by the same share", () => {
  // Cutoffs 2 / 4, all returns 0 → each bucket's target is just the sum of its needs.
  const b = { ...newBuckets(), preservationYears: 2, incomeThroughYear: 4 };
  const needs = [10, 10, 10, 10, 10, 10].map((x) => x * 1000);
  const factors = [0, 1, 1, 1, 1, 1, 1];
  const targets = bucketTargets(needs, 0, factors, b);
  assert.deepEqual(targets, { preservation: 20_000, income: 20_000, equities: 20_000 });
  assert.deepEqual(allocate(90_000, targets), { preservation: 20_000, income: 20_000, equities: 50_000 });
  assert.deepEqual(allocate(30_000, targets), { preservation: 10_000, income: 10_000, equities: 10_000 });
  assert.deepEqual(allocate(0, targets), { preservation: 0, income: 0, equities: 0 });
  assert.deepEqual(allocate(5_000, { preservation: 0, income: 0, equities: 0 }), { preservation: 0, income: 0, equities: 5_000 }, "no withdrawals ahead → all equities");
  // Standing at year 3, only years 3..5 remain: 20k preservation, 10k income.
  assert.deepEqual(bucketTargets(needs, 3, factors, b), { preservation: 20_000, income: 10_000, equities: 0 });
});

test("the year's return is the split-weighted blend of the bucket returns", () => {
  // Returns 0% / 5% / 10%; cutoffs 1 / 2; $12k/yr spending for 3 years; big
  // portfolio, so targets are met in full and the rest is equities.
  const s = flat({ spendMonthly: 1000, accounts: [newAccount({ name: "b", type: "taxable", balance: 1_000_000 })] });
  s.buckets = { preservationReturnPct: 0, incomeReturnPct: 5, equitiesReturnPct: 10, preservationYears: 1, incomeThroughYear: 2 };
  const sim = simulate(s);
  const pres = 12_000; // year 1, held 1 year at 0%
  const inc = 12_000 / 1.05; // year 2: 1 year in income, 1 in preservation
  const eq = 1_000_000 - pres - inc;
  near(sim.startMix.preservation, pres);
  near(sim.startMix.income, inc);
  near(sim.startMix.equities, eq);
  const blended = (inc * 0.05 + eq * 0.1) / 1_000_000;
  near(sim.rows[0].returnPct, blended * 100, "", 1e-9);
  near(sim.rows[0].bal, 1_000_000 * (1 + blended) - 12_000);
  const m = sim.rows[0].mix;
  near(m.preservation + m.income + m.equities, 1, "", 1e-12);
});

test("working years with no withdrawals ahead in the safe window → capital preservation is empty", () => {
  const s = state(); // placeholder: working until 55, age 45
  const sim = simulate(s);
  assert.equal(sim.startMix.preservation, 0, "no withdrawals in years 1–8");
  assert.ok(sim.startMix.income > 0, "withdrawals start inside the high income window");
  const later = sim.rows.find((r) => r.age === 55);
  assert.ok(/** @type {any} */ (later).mix.preservation > 0.2, "near retirement the safe bucket fills");
});

test("shares() sums to 1, or all zero for an empty portfolio", () => {
  const sh = shares({ preservation: 1, income: 1, equities: 2 });
  assert.deepEqual(sh, { preservation: 0.25, income: 0.25, equities: 0.5 });
  assert.deepEqual(shares({ preservation: 0, income: 0, equities: 0 }), { preservation: 0, income: 0, equities: 0 });
});

test("returnsByYear (the Monte Carlo hook) overrides actual returns, not the plan's split", () => {
  const s = flat({ returnPct: 5, spendMonthly: 1000, accounts: [newAccount({ name: "b", type: "taxable", balance: 100_000 })] });
  const base = simulate(s);
  const crash = simulate(s, { returnsByYear: [{ preservation: 0, income: -0.1, equities: -0.3 }] });
  assert.deepEqual(crash.startMix, base.startMix, "the split plans with the assumptions");
  assert.ok(crash.rows[0].bal < base.rows[0].bal);
  near(crash.rows[1].returnPct, base.rows[1].returnPct, "later years fall back to the assumptions", 1e-9);
});

// ---------------------------------------------------------------------------
// stress overlays
// ---------------------------------------------------------------------------

test("market crash hits equities fully, high income half, capital preservation not at all", () => {
  const s = flat({ spendMonthly: 1000, accounts: [newAccount({ name: "b", type: "taxable", balance: 1_000_000 })] });
  s.buckets = { preservationReturnPct: 0, incomeReturnPct: 0, equitiesReturnPct: 0, preservationYears: 1, incomeThroughYear: 2 };
  const base = simulate(s);
  const crash = simulate(s, { drawdownPct: 30 });
  const { income, equities } = base.startMix; // preservation 12k, income 12k, equities 976k
  near(crash.path[0].bal, 1_000_000 - equities * 0.3 - income * 0.15);
});

test("one-time cost lands in its year, in today's dollars", () => {
  const s = flat({ inflationPct: 3, years: 5 });
  const base = simulate(s);
  const shock = simulate(s, { oneTimeCost: 50_000, oneTimeCostYearIdx: 3 });
  near(shock.rows[3].spend - base.rows[3].spend, 50_000);
  near(shock.rows[2].spend, base.rows[2].spend);
});

test("floor mode: firstBreachYear marks the first dip below the floor while firstNegYear stays null", () => {
  // 600k, flat, 24k/yr: 2027=576, 2028=552, 2029=528, 2030=504, 2031=480 (< 500k floor).
  const s = flat({ years: 10, spendMonthly: 2000, accounts: [newAccount({ name: "b", type: "taxable", balance: 600_000 })] });
  s.endState = { mode: "floor", amounts: { bequest: 0, floor: 500_000 } };
  const sim = simulate(s);
  assert.equal(sim.firstNegYear, null, "never below $0");
  assert.equal(sim.firstBreachYear, 2031);
  s.endState = { mode: "zero", amounts: { bequest: 0, floor: 500_000 } };
  assert.equal(simulate(s).firstBreachYear, null);
});

test("zero assets and no income runs out immediately", () => {
  const s = state();
  s.accounts = [];
  s.incomes = [];
  s.properties = [];
  assert.deepEqual(validate(s).errors, []);
  assert.notEqual(simulate(s).firstNegYear, null);
});

// ---------------------------------------------------------------------------
// property cash flow
// ---------------------------------------------------------------------------

const rental = (o = {}) => ({ name: "r", rentMonthly: 3200, costsMonthly: 900, mortgageMonthly: 2400, payoffYear: 2049, saleYear: 2027, saleNetProceeds: 250_000, rentGrowthPct: 0, costsGrowthPct: 0, ...o });

test("sale year books part-year ownership plus proceeds exactly once", () => {
  const p = rental();
  const inSale = propertyCashflowYear(p, 2027);
  assert.equal(inSale.proceeds, 250_000);
  assert.equal(inSale.cf, (3200 - 900 - 2400) * SALE_YEAR_OWNED_MONTHS);
  assert.deepEqual(propertyCashflowYear(p, 2028), { cf: 0, proceeds: 0 });
  assert.equal(propertyCashflowYear(p, 2026).cf, (3200 - 900 - 2400) * 12);
});

test("sale proceeds are entered in today's dollars and land inflated in the sale year", () => {
  const p = rental({ saleYear: 2030 });
  near(propertyCashflowYear(p, 2030, { startYear: 2026, inflationPct: 3 }).proceeds, 250_000 * 1.03 ** 4);
});

test("a sale predating the simulation window stays sold under saleDelayYears", () => {
  const p = rental({ saleYear: 2025 });
  const overlay = { startYear: 2026, saleDelayYears: 2 };
  for (let year = 2026; year <= 2032; year++) {
    assert.deepEqual(propertyCashflowYear(p, year, overlay), { cf: 0, proceeds: 0 }, `year ${year}`);
  }
});

test("delayed sale shifts proceeds; keep-forever property cash flows forever", () => {
  const p = rental();
  assert.equal(propertyCashflowYear(p, 2027, { saleDelayYears: 2 }).proceeds, 0);
  assert.equal(propertyCashflowYear(p, 2029, { saleDelayYears: 2 }).proceeds, 250_000);
  const keep = rental({ saleYear: null, saleNetProceeds: null });
  assert.notEqual(propertyCashflowYear(keep, 2080).cf, 0);
  assert.equal(propertyCashflowYear(keep, 2080).proceeds, 0);
});

test("mortgage is paid through the payoff year and stops after it", () => {
  const keep = rental({ saleYear: null });
  const during = propertyCashflowYear(keep, 2049);
  const after = propertyCashflowYear(keep, 2050);
  assert.equal(after.cf, during.cf + 2400 * 12);
});

test("vacancy overlay knocks months off rent only inside the window", () => {
  const keep = rental({ saleYear: null });
  const inWindow = propertyCashflowYear(keep, 2026, { startYear: 2026, vacancyMonths: 4, vacancyYears: 2 });
  const outWindow = propertyCashflowYear(keep, 2028, { startYear: 2026, vacancyMonths: 4, vacancyYears: 2 });
  assert.equal(outWindow.cf - inWindow.cf, 3200 * 4);
});

test("rent and costs follow inflation when blank; the mortgage is a fixed dollar amount", () => {
  const p = rental({ saleYear: null, rentMonthly: 2000, costsMonthly: 500, mortgageMonthly: 1000, rentGrowthPct: null, costsGrowthPct: null });
  const y10 = propertyCashflowYear(p, 2036, { startYear: 2026, inflationPct: 3 });
  near(y10.cf, (2000 * 1.03 ** 10 - 500 * 1.03 ** 10 - 1000) * 12);
  const own = propertyCashflowYear({ ...p, rentGrowthPct: 5 }, 2036, { startYear: 2026, inflationPct: 3 });
  near(own.cf, (2000 * 1.05 ** 10 - 500 * 1.03 ** 10 - 1000) * 12, "an explicit rent increase overrides inflation");
});

// ---------------------------------------------------------------------------
// Social Security, healthcare, household (today's $, rising with inflation)
// ---------------------------------------------------------------------------

test("healthcare: pre-65 bridge starts when employer coverage ends, Medicare at 65, flat in today's $", () => {
  const s = flat({ age: 40, years: 30, inflationPct: 3 });
  s.health = { preMedicareAnnual: 18000, postMedicareAnnual: 7000, employerCoverageUntilAge: 45 };
  const sim = simulate(s);
  const at = (age) => /** @type {number} */ (sim.rows.find((r) => r.age === age)?.health);
  assert.equal(at(44), 0);
  near(at(45), 18000);
  near(at(64), 18000);
  near(at(65), 7000);
});

test("Social Security starts at its start age with the haircut, flat in today's $ (COLA)", () => {
  const s = flat({ age: 60, years: 10, inflationPct: 3 });
  s.social = { startAge: 67, monthly: 2000, haircutPct: 25 };
  const sim = simulate(s);
  assert.equal(sim.rows.find((r) => r.age === 66)?.ss, 0);
  near(/** @type {number} */ (sim.rows.find((r) => r.age === 67)?.ss), 18_000);
  near(/** @type {number} */ (sim.rows.find((r) => r.age === 69)?.ss), 18_000);
});

test("spouse contributes Social Security and healthcare on their own age", () => {
  const s = flat({ age: 60, years: 10 });
  s.household = {
    people: [{ name: "Spouse", role: "spouse", currentAge: 62, annualCost: 0, fromYear: null, toYear: null, social: { startAge: 67, monthly: 2000, haircutPct: 25 }, health: { preMedicareAnnual: 16000, postMedicareAnnual: 7500, employerCoverageUntilAge: 40 } }],
  };
  const sim = simulate(s);
  assert.equal(sim.rows.find((r) => r.year === 2030)?.ss, 0);
  near(/** @type {number} */ (sim.rows.find((r) => r.year === 2031)?.ss), 18_000, "spouse turns 67 in 2031");
  near(sim.rows[0].health, 16000, "spouse on the pre-65 bridge");
  near(/** @type {number} */ (sim.rows.find((r) => r.year === 2029)?.health), 7500, "spouse turns 65 in 2029");
});

test("spending window: a time-boxed cost applies only within [fromYear, toYear]", () => {
  const s = flat({ years: 10 });
  s.spending = [
    { name: "perpetual", monthly: 1000, fromYear: null, toYear: null, growthPct: null },
    { name: "car loan", monthly: 500, fromYear: null, toYear: 2030, growthPct: null },
  ];
  const sim = simulate(s);
  near(/** @type {number} */ (sim.rows.find((r) => r.year === 2030)?.spend), 18_000);
  near(/** @type {number} */ (sim.rows.find((r) => r.year === 2031)?.spend), 12_000);
});

test("a dependent's support cost applies within its window and scales with the spending shock", () => {
  const s = flat({ years: 25, inflationPct: 2 });
  s.household = { people: [{ name: "Kid", role: "dependent", currentAge: null, annualCost: 18_000, fromYear: null, toYear: 2044 }] };
  const sim = simulate(s);
  near(/** @type {number} */ (sim.rows.find((r) => r.year === 2044)?.spend), 18_000);
  assert.equal(sim.rows.find((r) => r.year === 2045)?.spend, 0);
  near(/** @type {number} */ (simulate(s, { spendMult: 1.2 }).rows.find((r) => r.year === 2030)?.spend), 21_600);
  const none = structuredClone(s);
  none.household.people[0].annualCost = 0;
  assert.ok(simulate(none).rows.every((r) => r.spend === 0), "no support cost → no engine effect");
});

// ---------------------------------------------------------------------------
// purity
// ---------------------------------------------------------------------------

test("engine purity: no node imports, no Date, no clock anywhere in src/engine", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "engine");
  for (const f of readdirSync(dir)) {
    const text = readFileSync(join(dir, f), "utf8");
    assert.ok(!/from\s+["']node:/.test(text), `${f} imports a node builtin`);
    assert.ok(!/\bDate\b/.test(text), `${f} reads the clock`);
    assert.ok(!/\bprocess\b/.test(text), `${f} touches process`);
  }
});

test("the placeholder simulates cleanly with default taxes", () => {
  const s = state();
  assert.deepEqual(s.taxes, newTaxes());
  const sim = simulate(s);
  assert.ok(sim.rows.every((r) => Number.isFinite(r.bal) && Number.isFinite(r.tax)));
});
