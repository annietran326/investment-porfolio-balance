import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { simulate, prepare, runPlan, EARLY_WITHDRAWAL_START_AGE } from "../src/engine/simulate.mjs";
import { monteCarlo, makePaths, runFutures, gapToTarget, drawReturn } from "../src/engine/montecarlo.mjs";
import { goalMet } from "../src/engine/solver.mjs";
import { pvFactor, bucketTargets, allocate, bucketFor, shares, surplusShares } from "../src/engine/buckets.mjs";
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
 * healthcare, household, or income unless a test adds it.
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
  s.incomes = [];
  s.spending = o.spendMonthly ? [{ name: "living", monthly: o.spendMonthly, fromYear: null, toYear: null, growthPct: null, variable: true }] : [];
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
  s.household.people = s.household.people.filter((p) => p.role !== "spouse"); // just you: the plan ends at your plan-to age
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
  // Add $12k in an own fund: it covers the equities need, so the bucket plan's
  // targets become 12k / 12k / 0, and its extra $12k follows the glide: with
  // 3 years left (more than the 2-year cutoff) extra money is all equities.
  s.accounts.push(newAccount({ name: "401k", type: "401k", balance: 12_000, invest: "own", ownReturnPct: 0 }));
  assert.deepEqual(simulate(s).startMix, { preservation: 12_000, income: 12_000, equities: 12_000 });
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

// ---------------------------------------------------------------------------
// the three buckets
// ---------------------------------------------------------------------------

test("bucketFor and pvFactor follow the time-based rule (hand-computed)", () => {
  const b = newBuckets(); // cutoffs 8 / 15
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

test("allocate: safe buckets hold exactly their targets; extra money follows the glide; a shortfall scales every bucket", () => {
  // Cutoffs 2 / 4, all returns 0 → each bucket's target is just the sum of its needs.
  const b = { ...newBuckets(), preservationYears: 2, incomeThroughYear: 4 };
  const needs = [10, 10, 10, 10, 10, 10].map((x) => x * 1000);
  const factors = [0, 1, 1, 1, 1, 1, 1];
  const targets = bucketTargets(needs, 0, factors, b);
  assert.deepEqual(targets, { preservation: 20_000, income: 20_000, equities: 20_000 });
  assert.deepEqual(allocate(90_000, targets), { preservation: 20_000, income: 20_000, equities: 50_000 }, "extra money defaults to equities");
  assert.deepEqual(allocate(90_000, targets, { preservation: 0.5, income: 0.5, equities: 0 }), { preservation: 35_000, income: 35_000, equities: 20_000 }, "or follows the shares given");
  assert.deepEqual(allocate(0, targets), { preservation: 0, income: 0, equities: 0 });
  assert.deepEqual(allocate(5_000, { preservation: 0, income: 0, equities: 0 }), { preservation: 0, income: 0, equities: 5_000 }, "no withdrawals ahead → all equities");
  // Standing at year 3, only years 3..5 remain: 20k preservation, 10k income.
  assert.deepEqual(bucketTargets(needs, 3, factors, b), { preservation: 20_000, income: 10_000, equities: 0 });
});

test("surplusShares: extra money goes to equities with >15 years left, high income with 9–15, capital preservation with 8 or fewer", () => {
  const b = newBuckets(); // 8 / 15
  assert.deepEqual(surplusShares(30, b), { preservation: 0, income: 0, equities: 1 });
  assert.deepEqual(surplusShares(16, b), { preservation: 0, income: 0, equities: 1 });
  assert.deepEqual(surplusShares(15, b), { preservation: 0, income: 1, equities: 0 });
  assert.deepEqual(surplusShares(9, b), { preservation: 0, income: 1, equities: 0 });
  assert.deepEqual(surplusShares(8, b), { preservation: 1, income: 0, equities: 0 });
  assert.deepEqual(surplusShares(1, b), { preservation: 1, income: 0, equities: 0 });
});

test("allocate fills in order: capital preservation, then high income, then equities", () => {
  const targets = { preservation: 20_000, income: 20_000, equities: 20_000 };
  assert.deepEqual(allocate(30_000, targets), { preservation: 20_000, income: 10_000, equities: 0 }, "short: later buckets are short first");
  assert.deepEqual(allocate(15_000, targets), { preservation: 15_000, income: 0, equities: 0 });
});

test("a well-funded plan keeps capital preservation at its fixed cushion; late in the plan, gains move to it instead of selling", () => {
  // Retired at 60 with far more than needed: capital preservation holds the
  // next 8 years of withdrawals only (a modest share), equities hold the rest.
  // With 15 or fewer years left, equities stop growing (their gains move to
  // capital preservation) but aren't sold; in the last 8, high income's gains move too.
  const s = flat({ age: 60, years: 35, returnPct: 5, spendMonthly: 4000, accounts: [newAccount({ name: "b", type: "taxable", balance: 5_000_000 })] });
  const sim = simulate(s);
  const first = sim.rows[0].mix;
  near(sim.startMix.preservation, 48_000 * (1 / 1.05 + 1 / 1.05 ** 2 + 1 / 1.05 ** 3 + 1 / 1.05 ** 4 + 1 / 1.05 ** 5 + 1 / 1.05 ** 6 + 1 / 1.05 ** 7 + 1 / 1.05 ** 8), "exactly 8 years of withdrawals", 1e-6);
  assert.ok(first.preservation < 0.1 && first.equities > 0.8, "a small cushion; the rest is long-term money");
  // Equities in dollars (nominal): share × balance × inflation factor (inflation is 0 here).
  const eqDollars = (/** @type {any} */ r, /** @type {number} */ k) => sim.path[k].bal * r.mix.equities;
  const late = sim.rows.map((r, k) => ({ r, k })).filter(({ r }) => r.age > 60 + 35 - 15);
  for (let j = 1; j < late.length; j++) {
    near(eqDollars(late[j].r, late[j].k), eqDollars(late[j - 1].r, late[j - 1].k), `equities held steady at age ${late[j].r.age} (not sold, not grown)`, 1);
  }
  assert.ok((late.at(-1)?.r.mix.equities ?? 0) > 0.2, "equities are never sold off late in the plan");
  const cp = late.map(({ r }) => r.mix.preservation);
  assert.ok(cp.every((x, j) => j === 0 || x >= cp[j - 1] - 1e-9), "capital preservation's share only grows late in the plan");
});

test("the year's return is the split-weighted blend of the bucket returns", () => {
  // Returns 0% / 5% / 10%; cutoffs 1 / 2; $12k/yr spending for 3 years.
  // Targets: year 1 → 12k preservation; year 2 → 12k/1.05 income; year 3 →
  // 12k/(1.1 × 1.05) equities. 3 years left ≥ the 2-year cutoff, so the
  // extra money is all equities.
  const s = flat({ spendMonthly: 1000, accounts: [newAccount({ name: "b", type: "taxable", balance: 1_000_000 })] });
  s.buckets = { preservationReturnPct: 0, incomeReturnPct: 5, equitiesReturnPct: 10, preservationYears: 1, incomeThroughYear: 2 };
  const sim = simulate(s);
  const pres = 12_000;
  const inc = 12_000 / 1.05;
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

// ---------------------------------------------------------------------------
// ending conditions
// ---------------------------------------------------------------------------

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
  assert.deepEqual(validate(s).errors, []);
  assert.notEqual(simulate(s).firstNegYear, null);
});

// ---------------------------------------------------------------------------
// shared plan-to age and the survivor benefit
// ---------------------------------------------------------------------------

/** You at `self`, a spouse at `spouse`, plan-to age 90, SS $2,000/mo each (no haircut) from 67. */
function couple(self, spouse) {
  const s = flat({ age: self, years: 90 - self });
  s.profile.endAge = 90;
  s.social = { startAge: 67, monthly: 2000, haircutPct: 0 };
  s.health = { preMedicareAnnual: 10_000, postMedicareAnnual: 5_000, employerCoverageUntilAge: 0 };
  s.household = {
    people: [{ name: "Spouse", role: "spouse", currentAge: spouse, annualCost: 0, fromYear: null, toYear: null, social: { startAge: 67, monthly: 1000, haircutPct: 0 }, health: { preMedicareAnnual: 10_000, postMedicareAnnual: 5_000, employerCoverageUntilAge: 0 } }],
  };
  return s;
}

test("older spouse: the plan ends at YOUR plan-to age; their costs and SS stop at theirs", () => {
  const sim = simulate(couple(60, 65)); // spouse reaches 90 when you're 85
  assert.equal(sim.rows.at(-1)?.age, 89, "plan runs until you reach 90");
  const at = (age) => /** @type {any} */ (sim.rows.find((r) => r.age === age));
  near(at(84).health, 10_000, "both on Medicare at 5k");
  near(at(85).health, 5_000, "spouse has passed 90: only your healthcare");
  near(at(84).ss, (2000 + 1000) * 12, "both collecting");
  near(at(85).ss, 2000 * 12, "survivor keeps the larger check (yours)");
});

test("younger spouse: the plan runs until THEY reach the plan-to age, and they keep the larger check", () => {
  const sim = simulate(couple(65, 60)); // you reach 90 when the spouse is 85
  assert.equal(sim.rows.at(-1)?.age, 94, "plan runs until the spouse reaches 90 (you'd be 95)");
  const at = (age) => /** @type {any} */ (sim.rows.find((r) => r.age === age));
  near(at(89).ss, (2000 + 1000) * 12);
  near(at(90).ss, 2000 * 12, "surviving spouse steps up to your $2,000 check");
  near(at(90).health, 5_000, "only the spouse's healthcare remains");
  assert.equal(sim.path.at(-1)?.age, 95);
});

test("no spouse: the plan ends at your plan-to age as before", () => {
  const s = couple(60, 60);
  s.household.people = [];
  assert.equal(simulate(s).rows.length, 30);
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
    { name: "perpetual", monthly: 1000, fromYear: null, toYear: null, growthPct: null, variable: true },
    { name: "car loan", monthly: 500, fromYear: null, toYear: 2030, growthPct: null, variable: true },
  ];
  const sim = simulate(s);
  near(/** @type {number} */ (sim.rows.find((r) => r.year === 2030)?.spend), 18_000);
  near(/** @type {number} */ (sim.rows.find((r) => r.year === 2031)?.spend), 12_000);
});

test("a dependent's support cost applies within its window, and the spend more scenario leaves it alone", () => {
  const s = flat({ years: 25, inflationPct: 2 });
  s.household = { people: [{ name: "Kid", role: "dependent", currentAge: null, annualCost: 18_000, fromYear: null, toYear: 2044 }] };
  const sim = simulate(s);
  near(/** @type {number} */ (sim.rows.find((r) => r.year === 2044)?.spend), 18_000);
  assert.equal(sim.rows.find((r) => r.year === 2045)?.spend, 0);
  near(/** @type {number} */ (simulate(s, { spendMore: true }).rows.find((r) => r.year === 2030)?.spend), 18_000, "support costs like childcare aren't variable spending");
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

// ---------------------------------------------------------------------------
// the refill rule (real bucket balances)
// ---------------------------------------------------------------------------

/**
 * A 3-year plan needing $12k a year, cutoffs 1 / 2, all expected returns 0,
 * $36k in a taxable account (no gains) → targets 12k / 12k / 12k.
 */
function threeYears() {
  const s = flat({ spendMonthly: 1000, accounts: [newAccount({ name: "b", type: "taxable", balance: 36_000 })] });
  s.buckets = { ...s.buckets, preservationReturnPct: 0, incomeReturnPct: 0, equitiesReturnPct: 0, preservationYears: 1, incomeThroughYear: 2 };
  return s;
}
/** A hand-made return path. */
function path(eq, inc = eq.map(() => 0), pres = eq.map(() => 0)) {
  return { preservation: Float64Array.from(pres), income: Float64Array.from(inc), equities: Float64Array.from(eq), own: [] };
}

test("after a DOWN year for equities, nothing is sold to refill: spending comes from capital preservation, then high income", () => {
  const P = prepare(threeYears());
  // Year 0: equities −50% → buckets 12 / 12 / 6; the $12k withdrawal empties capital preservation → 0 / 12 / 6, no refill.
  // Year 1: equities flat (an up year) → the $12k comes from high income → 0 / 0 / 6, then refill for year 2 → 6 / 0 / 0.
  const res = runPlan(P, { path: path([-0.5, 0, 0]) });
  near(res.rows[0].mix.preservation, 1 / 3, "year 0 starts in the target split", 1e-9);
  near(res.rows[1].mix.preservation, 0, "no refill after the down year", 1e-9);
  near(res.rows[1].mix.income, 12 / 18, "", 1e-9);
  near(res.rows[1].mix.equities, 6 / 18, "equities are left alone to recover", 1e-9);
  near(res.rows[2].mix.preservation, 1, "refilled after the up year", 1e-9);
});

test("with many years left, an UP year for equities refills the buckets to their targets", () => {
  // Cutoffs 1 / 1 so year 1's vantage point (2 years left) is still "long".
  const s = threeYears();
  s.buckets.incomeThroughYear = 1;
  const P = prepare(s);
  // Targets today: 12k preservation (year 1), 24k equities (years 2–3).
  // Year 0: equities +10% → 12 / 0 / 26.4; withdraw 12 from preservation → 0 / 0 / 26.4,
  // refill for year 1 (targets 12 / 0 / 12, extra → equities) → 12 / 0 / 14.4.
  const res = runPlan(P, { path: path([0.1, 0, 0]) });
  near(res.rows[0].mix.equities, 24 / 36, "", 1e-9);
  near(res.rows[1].mix.preservation, 12 / 26.4, "", 1e-9);
  near(res.rows[1].mix.equities, 14.4 / 26.4, "", 1e-9);
});

test("with fewer years left than the high income cutoff, equity gains move to capital preservation; nothing is sold", () => {
  const P = prepare(threeYears()); // cutoffs 1 / 2: at year 1 there are 2 years left
  // Year 0: equities +10% → 12 / 12 / 13.2 (gain 1.2); withdraw 12 from preservation → 0 / 12 / 13.2.
  // Sweep the 1.2 gain → 1.2 / 12 / 12; preservation is short of its 12 target, so after this
  // up year it's topped up from equities → 12 / 12 / 1.2.
  const res = runPlan(P, { path: path([0.1, 0, 0]) });
  near(res.rows[1].mix.preservation, 12 / 25.2, "", 1e-9);
  near(res.rows[1].mix.income, 12 / 25.2, "high income isn't raided", 1e-9);
  near(res.rows[1].mix.equities, 1.2 / 25.2, "", 1e-9);
});

test("once capital preservation is full late in the plan, only GAINS move; principal stays put", () => {
  // 3-year plan, cutoffs 1 / 2, plenty of money: $100k beyond the need sits in equities.
  const s = threeYears();
  s.accounts[0].balance = 136_000;
  const P = prepare(s);
  // Year 0: preservation 12, income 12, equities 112 (12 needed + 100 extra); equities +10% (gain 11.2).
  // Withdraw 12 from preservation → 0 / 12 / 123.2. Sweep 11.2 → 11.2 / 12 / 112. Top preservation
  // up to its 12 target from equities → 12 / 12 / 111.2.
  const res = runPlan(P, { path: path([0.1, 0, 0]) });
  const total = 135.2;
  near(res.rows[1].mix.preservation, 12 / total, "", 1e-9);
  near(res.rows[1].mix.income, 12 / total, "", 1e-9);
  near(res.rows[1].mix.equities, 111.2 / total, "equities keep their principal", 1e-9);
});

test("in the final capital-preservation years, high income's gains move to capital preservation too", () => {
  const s = threeYears();
  s.accounts[0].balance = 136_000;
  const P = prepare(s);
  // Year 1 (1 year left after it, the final phase): high income +5% → its gain moves to preservation.
  const res = runPlan(P, { path: path([0.1, 0, 0], [0, 0.05, 0]) });
  // Start of year 1: 12 / 12 / 111.2. Growth: income 12.6 (gain 0.6), equities flat.
  // Withdraw 12 from preservation → 0 / 12.6 / 111.2. Sweep income gain 0.6 → 0.6 / 12 / 111.2.
  // Top preservation up to next year's 12 target from equities → 12 / 12 / 99.8.
  const total = 123.8;
  near(res.rows[2].mix.preservation, 12 / total, "", 1e-9);
  near(res.rows[2].mix.income, 12 / total, "", 1e-9);
  near(res.rows[2].mix.equities, 99.8 / total, "", 1e-9);
});

test("with expected returns every year is an up year, so the plan rebalances yearly", () => {
  const s = threeYears();
  s.buckets.equitiesReturnPct = 5;
  const expected = simulate(s);
  const viaPath = runPlan(prepare(s), { path: path([0.05, 0.05, 0.05]) });
  for (let i = 0; i < 3; i++) near(viaPath.rows[i].bal, expected.rows[i].bal, `year ${i}`, 1e-6);
});

// ---------------------------------------------------------------------------
// Monte Carlo
// ---------------------------------------------------------------------------

test("drawReturn: the entered rate is the median; the swing spreads years evenly in log terms", () => {
  near(drawReturn(0.095, 0.17, 0), 0.095, "z = 0 gives exactly the rate", 1e-12);
  assert.equal(drawReturn(0.05, 0, 2.5), 0.05, "no swing, no randomness");
  const up = drawReturn(0.095, 0.17, 1);
  const down = drawReturn(0.095, 0.17, -1);
  near((1 + up) * (1 + down), 1.095 ** 2, "a good year and an equally bad year compound back to the median", 1e-9);
  assert.ok(down < 0 && up > 0.25);
});

test("simulated futures are repeatable: the same inputs give the same answer", () => {
  const s = state();
  const a = monteCarlo(s, {}, { runs: 200 });
  const b = monteCarlo(s, {}, { runs: 200 });
  assert.equal(a.successRate, b.successRate);
  assert.deepEqual(a.end, b.end);
  assert.deepEqual(a.gap, b.gap);
});

test("with no swings, every simulated future is the expected-return plan", () => {
  const s = state();
  s.buckets = { ...s.buckets, preservationVolPct: 0, incomeVolPct: 0, equitiesVolPct: 0 };
  s.accounts = s.accounts.map((a) => ({ ...a, ownVolPct: 0 }));
  const expected = simulate(s);
  const mc = monteCarlo(s, {}, { runs: 20 });
  assert.equal(mc.successRate, goalMet(s, expected) ? 1 : 0);
  mc.bands.forEach((b, i) => {
    near(b.p50, expected.path[i].bal, `year ${i} median`, 1e-6);
    near(b.p90, expected.path[i].bal, `year ${i} 90% line`, 1e-6);
  });
});

test("outcome lines are ordered: 90% ≤ 80% ≤ 50%, and swings spread them apart", () => {
  const mc = monteCarlo(state(), {}, { runs: 300 });
  for (const b of mc.bands) assert.ok(b.p90 <= b.p80 + 1e-9 && b.p80 <= b.p50 + 1e-9, `year ${b.year}`);
  const last = mc.bands.at(-1);
  assert.ok(/** @type {any} */ (last).p50 - /** @type {any} */ (last).p90 > 10_000, "real spread between the typical and the cautious outcome");
});

test("the Monte Carlo gap reaches the target on the same futures, and a bit less does not", () => {
  const s = state();
  const P = prepare(s);
  const paths = makePaths(P, { runs: 300 });
  const gap = gapToTarget(P, paths, 90);
  assert.equal(gap.kind, "value");
  if (gap.kind !== "value") return;
  assert.equal(gap.amount % 1000, 0);
  assert.ok(runFutures(P, paths, gap.amount, { bands: false }).successRate >= 0.9);
  // The search stops within 0.2% (or $500) and rounds up to $1,000, so this much less must fall short.
  assert.ok(runFutures(P, paths, gap.amount - 1000 - gap.amount * 0.002, { bands: false }).successRate < 0.9);
});

test("more money today never lowers the chance of success", () => {
  const s = state();
  const P = prepare(s);
  const paths = makePaths(P, { runs: 200 });
  let prev = -1;
  for (let x = 0; x <= 2_000_000; x += 100_000) {
    const rate = runFutures(P, paths, x, { bands: false }).successRate;
    assert.ok(rate >= prev, `success fell at +$${x}`);
    prev = rate;
  }
});

test("a plan with a big cushion succeeds in (nearly) every future; +20% spending never helps", () => {
  const rich = state();
  rich.accounts[0].balance = 8_000_000;
  assert.ok(monteCarlo(rich, {}, { runs: 200 }).successRate > 0.97);
  const s = state();
  const base = monteCarlo(s, {}, { runs: 200 });
  const spend = monteCarlo(s, { spendMore: true }, { runs: 200 });
  assert.ok(spend.successRate <= base.successRate);
});

test("equities and high income move together; capital preservation doesn't", () => {
  const P = prepare(state());
  const paths = makePaths(P, { runs: 400 });
  const xs = [], ys = [], zs = [];
  for (const p of paths) for (let i = 0; i < 10; i++) { xs.push(Math.log(1 + p.equities[i])); ys.push(Math.log(1 + p.income[i])); zs.push(Math.log(1 + p.preservation[i])); }
  const corr = (a, b) => {
    const ma = a.reduce((x, y) => x + y) / a.length, mb = b.reduce((x, y) => x + y) / b.length;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    return sab / Math.sqrt(saa * sbb);
  };
  near(corr(xs, ys), 0.5, "equities vs high income", 0.06);
  near(corr(xs, zs), 0, "equities vs capital preservation", 0.06);
});

test("the spend more scenario raises only variable lines, by the percent you set", () => {
  const s = flat({ years: 3 });
  s.spending = [
    { name: "housing", monthly: 3000, fromYear: null, toYear: null, growthPct: null, variable: false },
    { name: "travel", monthly: 1000, fromYear: null, toYear: null, growthPct: null, variable: true },
  ];
  s.health = { preMedicareAnnual: 10_000, postMedicareAnnual: 10_000, employerCoverageUntilAge: 0 };
  s.simulation.spendMorePct = 25;
  const base = simulate(s);
  const more = simulate(s, { spendMore: true });
  near(base.rows[0].spend, 36_000 + 12_000 + 10_000);
  near(more.rows[0].spend, 36_000 + 12_000 * 1.25 + 10_000, "only travel rises; housing and healthcare don't");
  near(more.rows[2].spend - base.rows[2].spend, 3_000, "a lasting step up, every year");
});
