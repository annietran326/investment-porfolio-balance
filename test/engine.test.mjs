import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { simulate, prepare, runPlan, EARLY_WITHDRAWAL_START_AGE, rmdStartAge, rmdDivisor } from "../src/engine/simulate.mjs";
import { monteCarlo, makePaths, runFutures, gapToTarget, drawReturn } from "../src/engine/montecarlo.mjs";
import { goalMet } from "../src/engine/solver.mjs";
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
  // One set of rates for the whole plan (retirement rates from age 0) and no
  // dividends, so withdrawal-tax tests can set a single rate. Tests of the
  // yearly tax on taxable-account income set these explicitly.
  s.taxes = { ...newTaxes(), workingOrdinaryIncomePct: 0, workingCapitalGainsPct: 0, ordinaryIncomePct: 0, capitalGainsPct: 0, retireYear: 0, dividendYieldPct: 0 };
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
  s.taxes = { ...s.taxes, ordinaryIncomePct: 30, capitalGainsPct: 30 };
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

test("a dedicated account earns its bucket's return; the total and bucket plan splits are reported separately", () => {
  // High income earns 6%, everything else 0%. No spending, so the bucket plan is all equities.
  const s = flat({
    accounts: [
      newAccount({ name: "Brokerage", type: "taxable", balance: 100_000 }),
      newAccount({ name: "IRA", type: "traditional_ira", balance: 50_000, invest: "income" }),
    ],
  });
  s.buckets.incomeReturnPct = 6;
  const sim = simulate(s);
  assert.deepEqual(sim.startDedicated, { preservation: 0, income: 50_000, equities: 0 });
  assert.deepEqual(sim.startMix, { preservation: 0, income: 0, equities: 100_000 }, "the bucket plan allocation covers only bucket-plan money");
  near(sim.rows[0].mix.income, 50_000 / 150_000, "the row split is of ALL the money", 1e-12);
  near(sim.rows[0].bal, 100_000 + 50_000 * 1.06);
  near(sim.rows[0].returnPct, (3_000 / 150_000) * 100, "row return is for everything combined", 1e-9);
});

test("dedicated money counts toward its bucket's target; the bucket plan fills what's left", () => {
  // Cutoffs 1 / 2, all returns 0, $12k/yr for 3 years → targets 12k / 12k / 12k.
  const s = flat({ spendMonthly: 1000, accounts: [newAccount({ name: "b", type: "taxable", balance: 36_000 })] });
  s.buckets = { ...s.buckets, preservationReturnPct: 0, incomeReturnPct: 0, equitiesReturnPct: 0, preservationYears: 1, incomeThroughYear: 2 };
  assert.deepEqual(simulate(s).startMix, { preservation: 12_000, income: 12_000, equities: 12_000 });
  // An IRA dedicated to high income with $8k: the bucket plan needs only $4k more there.
  s.accounts.push(newAccount({ name: "IRA", type: "traditional_ira", balance: 8_000, invest: "income" }));
  assert.deepEqual(simulate(s).startMix, { preservation: 12_000, income: 4_000, equities: 20_000 });
  // $20k dedicated: more than high income needs, so the plan puts nothing there.
  s.accounts[1].balance = 20_000;
  assert.deepEqual(simulate(s).startMix, { preservation: 12_000, income: 0, equities: 24_000 });
  // A dedicated equities account covers the equities need first.
  s.accounts[1] = newAccount({ name: "401k", type: "401k", balance: 12_000, invest: "equities" });
  s.accounts[0].balance = 24_000;
  assert.deepEqual(simulate(s).startMix, { preservation: 12_000, income: 12_000, equities: 0 });
});

test("within a tax type, spending comes from dedicated capital preservation, then the bucket plan, then dedicated high income, then dedicated equities", () => {
  const s = flat({
    accounts: [
      newAccount({ name: "EQ 401k", type: "401k", balance: 1, invest: "equities" }),
      newAccount({ name: "HI IRA", type: "traditional_ira", balance: 1, invest: "income" }),
      newAccount({ name: "IRA", type: "traditional_ira", balance: 1, invest: "buckets" }),
      newAccount({ name: "CP IRA", type: "traditional_ira", balance: 1, invest: "preservation" }),
      newAccount({ name: "Brokerage", type: "taxable", balance: 1, invest: "equities" }),
    ],
  });
  const P = prepare(s);
  const order = P.withdrawOrder.map((k) => `${P.holdings[k].pool}:${P.holdings[k].bucket ?? "plan"}`);
  assert.deepEqual(order, ["taxable:plan", "taxable:equities", "deferred:preservation", "deferred:plan", "deferred:plan", "deferred:income", "deferred:equities", "roth:plan"]);

  // In dollars: $12k/yr from $5k dedicated capital preservation, $10k bucket plan, $100k dedicated equities.
  const t = flat({ spendMonthly: 1000, accounts: [
    newAccount({ name: "EQ", type: "traditional_ira", balance: 100_000, invest: "equities" }),
    newAccount({ name: "plan", type: "traditional_ira", balance: 10_000, invest: "buckets" }),
    newAccount({ name: "CP", type: "traditional_ira", balance: 5_000, invest: "preservation" }),
  ] });
  const sim = simulate(t);
  // Year 0: $5k dedicated capital preservation, then $7k of the plan → plan $3k left.
  near(sim.path[1].bal, 103_000);
  // The plan alone can't hold the next 2 years ($24k) in capital preservation,
  // so after that (flat, not down) year $21k moves over from dedicated equities.
  near(sim.rows[1].mix.preservation, 24_000 / 103_000, "", 1e-12);
  near(sim.rows[1].mix.equities, 79_000 / 103_000, "", 1e-12);
  // Year 1 spends $12k of it; dedicated equities are untouched.
  near(sim.path[2].bal, 91_000);
  near(sim.rows[2].mix.equities, 79_000 / 91_000, "", 1e-12);
});

test("when the bucket plan can't fill the safe buckets, money moves over from dedicated accounts after an up year (not after a down year)", () => {
  // Cutoffs 1 / 2, all returns 0, $12k/yr for 3 years → targets 12k / 12k / 12k.
  const s = flat({ spendMonthly: 1000, accounts: [
    newAccount({ name: "IRA", type: "traditional_ira", balance: 12_000, invest: "buckets" }),
    newAccount({ name: "401k", type: "401k", balance: 100_000, invest: "equities" }),
  ] });
  s.buckets = { ...s.buckets, preservationReturnPct: 0, incomeReturnPct: 0, equitiesReturnPct: 0, preservationYears: 1, incomeThroughYear: 2 };
  const P = prepare(s);
  const up = runPlan(P, { path: path([0, 0, 0]) });
  assert.deepEqual(up.startSafeShort, { preservation: 0, income: 12_000 }, "today the plan's $12k covers only capital preservation");
  // Year 0 spends the plan's $12k. After the (flat) year, $12k each moves from the
  // 401(k)'s dedicated equities into capital preservation and high income.
  near(up.rows[1].mix.preservation, 12 / 100, "", 1e-12);
  near(up.rows[1].mix.income, 12 / 100, "", 1e-12);
  near(up.rows[1].mix.equities, 76 / 100, "", 1e-12);
  // After a down year for equities nothing is sold.
  const down = runPlan(P, { path: path([-0.1, 0, 0]) });
  near(down.rows[1].mix.preservation, 0, "", 1e-12);
  near(down.rows[1].mix.equities, 1, "", 1e-12);
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

test("allocate: safe buckets hold exactly their targets; extra money goes to equities", () => {
  // Cutoffs 2 / 4, all returns 0 → each bucket's target is just the sum of its needs.
  const b = { ...newBuckets(), preservationYears: 2, incomeThroughYear: 4 };
  const needs = [10, 10, 10, 10, 10, 10].map((x) => x * 1000);
  const factors = [0, 1, 1, 1, 1, 1, 1];
  const targets = bucketTargets(needs, 0, factors, b);
  assert.deepEqual(targets, { preservation: 20_000, income: 20_000, equities: 20_000 });
  assert.deepEqual(allocate(90_000, targets), { preservation: 20_000, income: 20_000, equities: 50_000 }, "extra money goes to equities");
  assert.deepEqual(allocate(0, targets), { preservation: 0, income: 0, equities: 0 });
  assert.deepEqual(allocate(5_000, { preservation: 0, income: 0, equities: 0 }), { preservation: 0, income: 0, equities: 5_000 }, "no withdrawals ahead → all equities");
  // Standing at year 3, only years 3..5 remain: 20k preservation, 10k income.
  assert.deepEqual(bucketTargets(needs, 3, factors, b), { preservation: 20_000, income: 10_000, equities: 0 });
});

test("allocate fills in order: capital preservation, then high income, then equities", () => {
  const targets = { preservation: 20_000, income: 20_000, equities: 20_000 };
  assert.deepEqual(allocate(30_000, targets), { preservation: 20_000, income: 10_000, equities: 0 }, "short: later buckets are short first");
  assert.deepEqual(allocate(15_000, targets), { preservation: 15_000, income: 0, equities: 0 });
});

test("a well-funded plan keeps capital preservation at its fixed cushion, all the way to the end", () => {
  // Retired at 60 with far more than needed: capital preservation holds the
  // next 8 years of withdrawals only (a modest share), equities hold the rest,
  // and that doesn't change late in the plan.
  const s = flat({ age: 60, years: 35, returnPct: 5, spendMonthly: 4000, accounts: [newAccount({ name: "b", type: "taxable", balance: 5_000_000 })] });
  const sim = simulate(s);
  const first = sim.rows[0].mix;
  near(sim.startMix.preservation, 48_000 * (1 / 1.05 + 1 / 1.05 ** 2 + 1 / 1.05 ** 3 + 1 / 1.05 ** 4 + 1 / 1.05 ** 5 + 1 / 1.05 ** 6 + 1 / 1.05 ** 7 + 1 / 1.05 ** 8), "exactly 8 years of withdrawals", 1e-6);
  assert.ok(first.preservation < 0.1 && first.equities > 0.8, "a small cushion; the rest is long-term money");
  for (const r of sim.rows) assert.ok(r.mix.equities > 0.8, `still mostly equities at age ${r.age}`);
  const last = sim.rows.at(-1);
  near(last.mix.preservation * (last.bal + 48_000) / 1.05, 48_000 / 1.05, "the final year: just that year's withdrawal is in capital preservation", 1);
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
  return { preservation: Float64Array.from(pres), income: Float64Array.from(inc), equities: Float64Array.from(eq) };
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

test("after an UP year for equities, the buckets are refilled to their targets, late in the plan too; extra money stays in equities", () => {
  // 3-year plan, cutoffs 1 / 2, $100k beyond the need.
  const s = threeYears();
  s.accounts[0].balance = 136_000;
  const P = prepare(s);
  // Year 0: 12 / 12 / 112, equities +10% → 12 / 12 / 123.2; withdraw 12 → 0 / 12 / 123.2;
  // refill for year 1 (targets 12 / 12, rest equities) → 12 / 12 / 111.2.
  // Year 1: high income +5% → 12 / 12.6 / 111.2; withdraw 12 → 0 / 12.6 / 111.2;
  // refill for year 2 (target 12 preservation, rest equities) → 12 / 0 / 111.8.
  const res = runPlan(P, { path: path([0.1, 0, 0], [0, 0.05, 0]) });
  near(res.rows[1].mix.preservation, 12 / 135.2, "", 1e-9);
  near(res.rows[1].mix.income, 12 / 135.2, "", 1e-9);
  near(res.rows[1].mix.equities, 111.2 / 135.2, "", 1e-9);
  near(res.rows[2].mix.preservation, 12 / 123.8, "", 1e-9);
  near(res.rows[2].mix.income, 0, "", 1e-9);
  near(res.rows[2].mix.equities, 111.8 / 123.8, "the extra stays in equities to the end", 1e-9);
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

// ---------------------------------------------------------------------------
// required minimum distributions
// ---------------------------------------------------------------------------

/** @param {number} age */
const spouseAged = (age) => ({
  name: "Spouse", role: "spouse", currentAge: age, annualCost: 0, fromYear: null, toYear: null,
  social: { startAge: 67, monthly: 0, haircutPct: 0 }, health: { preMedicareAnnual: 0, postMedicareAnnual: 0, employerCoverageUntilAge: 200 },
});

test("RMD start age follows birth year (SECURE 2.0), and divisors follow the Uniform Lifetime Table", () => {
  assert.equal(rmdStartAge(1950), 72);
  assert.equal(rmdStartAge(1951), 73);
  assert.equal(rmdStartAge(1959), 73);
  assert.equal(rmdStartAge(1960), 75);
  assert.equal(rmdStartAge(1990), 75);
  assert.equal(rmdDivisor(74, 75), 0, "none before the start age");
  assert.equal(rmdDivisor(75, 75), 24.6);
  assert.equal(rmdDivisor(80, 73), 20.2);
  assert.equal(rmdDivisor(90, 73), 12.2);
  assert.equal(rmdDivisor(125, 73), 2.0, "past the table: its last entry");
});

test("an RMD comes out even when nothing is needed, and is reinvested in the taxable account", () => {
  // Born 1951 (75 in 2026): RMDs from 73. $246,000 / 24.6 = $10,000; no tax, no spending, 0% returns.
  const s = flat({ age: 75, years: 2, accounts: [newAccount({ name: "IRA", type: "traditional_ira", balance: 246_000 })] });
  const sim = simulate(s);
  near(sim.rows[0].rmd, 10_000);
  near(sim.rows[0].withdrawn, 10_000);
  near(sim.rows[0].bal, 246_000, "money moves between accounts; the total is unchanged");
  near(sim.rows[1].rmd, 236_000 / 23.7, "next year: last year-end's IRA balance / the age-76 divisor");
});

test("an RMD is taxed as ordinary income and pays for the year's spending first", () => {
  // $10,000 RMD at 20% = $2,000 tax; $8,000 covers the $5,000 spend; $3,000 is reinvested.
  const s = flat({ age: 75, years: 1, spendMonthly: 5000 / 12, accounts: [newAccount({ name: "IRA", type: "traditional_ira", balance: 246_000 })] });
  s.taxes = { ...s.taxes, ordinaryIncomePct: 20, capitalGainsPct: 0 };
  const sim = simulate(s);
  near(sim.rows[0].rmd, 10_000);
  near(sim.rows[0].withdrawn, 10_000, "nothing beyond the RMD was needed");
  near(sim.rows[0].tax, 2_000);
  near(sim.rows[0].bal, 246_000 - 2_000 - 5_000);
});

test("RMDs start at 75 for someone born in 1960 or later; Roth IRAs never have them", () => {
  const s = flat({ age: 64, years: 14, accounts: [
    newAccount({ name: "IRA", type: "traditional_ira", balance: 100_000 }),
    newAccount({ name: "Roth", type: "roth_ira", balance: 100_000 }),
  ] });
  const sim = simulate(s);
  for (const r of sim.rows) {
    if (r.age < 75) assert.equal(r.rmd, 0, `no RMD at ${r.age}`);
    else if (r.age === 75) near(r.rmd, 100_000 / 24.6, "the IRA's RMD at 75; the Roth adds nothing");
    else assert.ok(r.rmd > 0 && r.rmd < 100_000 / 20, `RMDs continue at ${r.age}`);
  }
});

test("a spouse's account follows the spouse's age, then the survivor's after a death", () => {
  // You are 70 (born 1956, RMDs from 73); your spouse is 80 and reaches the plan-to age of 82 after two years.
  const s = flat({ age: 70, years: 12, accounts: [newAccount({ name: "Spouse IRA", type: "traditional_ira", balance: 202_000, owner: "spouse" })] });
  s.household.people = [spouseAged(80)];
  const sim = simulate(s);
  near(sim.rows[0].rmd, 202_000 / 20.2, "the spouse is 80: divisor 20.2");
  near(sim.rows[1].rmd, 192_000 / 19.4, "81: divisor 19.4");
  assert.equal(sim.rows[2].rmd, 0, "the spouse has died; you (72) inherit it as your own and aren't at your RMD age yet");
  assert.ok(sim.rows[3].rmd > 0, "you turn 73");
  near(sim.rows[3].rmd, (192_000 - 192_000 / 19.4) / 26.5);

  // The same account as yours: nothing until you're 73.
  s.accounts[0].owner = "self";
  const mine = simulate(s);
  assert.deepEqual(mine.rows.slice(0, 3).map((r) => r.rmd), [0, 0, 0]);
});

test("RMD money from a dedicated 401(k) lands in the bucket plan", () => {
  const s = flat({ age: 75, years: 1, accounts: [newAccount({ name: "401k", type: "401k", balance: 246_000, invest: "equities" })] });
  const sim = simulate(s);
  near(sim.rows[0].rmd, 10_000);
  near(sim.path[1].bal, 246_000);
  const P = prepare(s);
  const res = runPlan(P);
  near(res.balances[1], 246_000);
});

// ---------------------------------------------------------------------------
// retirement money before 59 1/2
// ---------------------------------------------------------------------------

test("while under 59½, retirement money doesn't count toward the liquid years; it counts for later years", () => {
  // Age 50, cutoffs 8 / 15, $12k/yr from now on, 0% returns. Capital preservation
  // covers ages 50–57 ($96k), high income ages 58–64 ($84k). An IRA dedicated to
  // high income with $84k can only count for ages 59–64 ($72k).
  const s = flat({ age: 50, years: 25, spendMonthly: 1000, accounts: [
    newAccount({ name: "Brokerage", type: "taxable", balance: 500_000 }),
    newAccount({ name: "IRA", type: "traditional_ira", balance: 84_000 }),
  ] });
  assert.equal(s.accounts[1].invest, "income", "a traditional IRA defaults to high income");
  const sim = simulate(s);
  near(sim.startMix.preservation, 96_000, "all of capital preservation is before 59½");
  near(sim.startMix.income, 12_000, "the age-58 year of high income still has to be in the brokerage");
  assert.deepEqual(sim.startBeforeAccess, { preservation: 96_000, income: 12_000 });
  near(sim.startPlanTaxable, 500_000);
  near(sim.startPlanRetirement, 0);

  // At 43 with 10 liquid years (the default): the brokerage holds years 1–10
  // (capital preservation, plus high income years 9–10); the IRA counts for years 11–15.
  const young = flat({ age: 43, years: 40, spendMonthly: 1000, accounts: [
    newAccount({ name: "Brokerage", type: "taxable", balance: 900_000 }),
    newAccount({ name: "IRA", type: "traditional_ira", balance: 84_000 }),
  ] });
  assert.equal(young.buckets.liquidYears, 10);
  const y = simulate(young);
  near(y.startMix.preservation, 96_000);
  near(y.startMix.income, 24_000, "high income years 9–10 stay liquid in the brokerage");
  assert.equal(y.liquidThroughAge, null, "the brokerage covers every year");
  young.buckets.liquidYears = 8;
  near(simulate(young).startMix.income, 0, "8 liquid years: the IRA covers all of high income");
  young.buckets.liquidYears = 15;
  near(simulate(young).startMix.income, 84_000, "15 liquid years: the brokerage holds all of high income");
  young.accounts[0].balance = 30_000;
  assert.equal(simulate(young).liquidThroughAge, 43 + 1, "$30k of brokerage covers the $12k years at 43 and 44");

  // At 60 everything is reachable: the IRA covers high income in full.
  const older = flat({ age: 60, years: 25, spendMonthly: 1000, accounts: [
    newAccount({ name: "Brokerage", type: "taxable", balance: 500_000 }),
    newAccount({ name: "IRA", type: "traditional_ira", balance: 84_000 }),
  ] });
  near(simulate(older).startMix.income, 0);
});

test("a taxable account dedicated to a bucket counts toward every year", () => {
  const s = flat({ age: 43, years: 40, spendMonthly: 1000, accounts: [
    newAccount({ name: "Brokerage", type: "taxable", balance: 900_000 }),
    newAccount({ name: "Brokerage HI", type: "taxable", balance: 84_000, invest: "income" }),
  ] });
  near(simulate(s).startMix.income, 0);
});

test("the early-withdrawal penalty follows the account owner's age", () => {
  // You're 50; the only money is an IRA. Owned by your 60-year-old spouse: no penalty.
  const s = flat({ age: 50, years: 1, spendMonthly: 1000, accounts: [newAccount({ name: "IRA", type: "traditional_ira", balance: 100_000, owner: "spouse" })] });
  s.household.people = [spouseAged(60)];
  const theirs = simulate(s);
  near(theirs.rows[0].withdrawn, 12_000);
  assert.deepEqual(theirs.earlyDeferredYears, []);
  s.accounts[0].owner = "self";
  const mine = simulate(s);
  near(mine.rows[0].withdrawn, 12_000 / 0.9, "yours: 10% penalty");
  assert.deepEqual(mine.earlyDeferredYears, [2026]);
});

test("topping up capital preservation from a dedicated IRA only covers years from 59½", () => {
  // Age 55, cutoffs 8 / 15 → capital preservation covers ages 55–62: 4 years before 59½, 4 after.
  // The bucket plan (a small brokerage) is empty after year 0; the IRA holds equities.
  const s = flat({ age: 55, years: 20, spendMonthly: 1000, accounts: [
    newAccount({ name: "Brokerage", type: "taxable", balance: 12_000 }),
    newAccount({ name: "IRA", type: "traditional_ira", balance: 500_000, invest: "equities" }),
  ] });
  const res = runPlan(prepare(s), { path: path(Array(20).fill(0)) });
  // Start of year 1 (age 56): capital preservation covers ages 56–63; ages 59–63 (5 years, $60k)
  // can come from the IRA, ages 56–58 can't. So capital preservation holds $60k.
  const total = res.path[1].bal;
  near(res.rows[1].mix.preservation * total, 60_000, "", 1e-6);
});

test("capital preservation is shown in three layers by year: cash, short-term bonds, medium-term", () => {
  // Age 60, $12k/yr, 0% returns, cutoffs: cash year 1, short-term through 4, capital preservation through 8.
  const s = flat({ age: 60, years: 25, spendMonthly: 1000, accounts: [newAccount({ name: "Brokerage", type: "taxable", balance: 1_000_000 })] });
  const sim = simulate(s);
  assert.deepEqual(sim.startPresLayers.plan, { cash: 12_000, short: 36_000, medium: 48_000 });
  assert.deepEqual(sim.startPresLayers.total, sim.startPresLayers.plan);
  // Short of money: the soonest layers fill first.
  s.accounts[0].balance = 30_000;
  assert.deepEqual(simulate(s).startPresLayers.plan, { cash: 12_000, short: 18_000, medium: 0 });
  // A dedicated capital preservation IRA (59½+, so it counts) adds to the total; the plan's layers fill soonest first.
  s.accounts = [newAccount({ name: "Brokerage", type: "taxable", balance: 1_000_000 }), newAccount({ name: "IRA", type: "traditional_ira", balance: 60_000, invest: "preservation" })];
  const d = simulate(s);
  assert.deepEqual(d.startPresLayers.total, { cash: 12_000, short: 36_000, medium: 48_000 });
  assert.deepEqual(d.startPresLayers.plan, { cash: 12_000, short: 24_000, medium: 0 });
});

// ---------------------------------------------------------------------------
// yearly tax on income earned in taxable accounts; working vs retirement rates
// ---------------------------------------------------------------------------

/** A one-account plan for the yearly-income-tax tests: returns 6 / 6 / 8%, no inflation. */
function incomeTaxPlan(/** @type {any} */ invest, /** @type {any} */ type = "taxable", years = 2) {
  const s = flat({ years, accounts: [newAccount({ name: "acct", type, balance: 100_000, invest })] });
  s.buckets = { ...s.buckets, preservationReturnPct: 3, incomeReturnPct: 6, equitiesReturnPct: 8 };
  s.taxes = { ...s.taxes, ordinaryIncomePct: 40, capitalGainsPct: 25, dividendYieldPct: 2 };
  return s;
}

test("high income in a taxable account: its whole expected return is taxed yearly as interest", () => {
  // $100k at 6% = $6,000 interest; 40% ordinary = $2,400 tax, paid out of the account.
  const sim = simulate(incomeTaxPlan("income"));
  near(sim.rows[0].incomeTax, 2_400);
  near(sim.rows[0].tax, 2_400, "the year's tax column includes it");
  near(sim.rows[0].bal, 106_000 - 2_400);
  near(sim.rows[1].incomeTax, (106_000 - 2_400) * 0.06 * 0.4, "next year's interest is on the after-tax balance");
});

test("after-tax interest is added to cost basis, so selling it later owes no second tax", () => {
  // Year 0 earns and is taxed; year 1 sells. Basis = 100k + 6k − 2.4k = value,
  // so the gain share is zero and the sale itself is untaxed.
  const s = incomeTaxPlan("income");
  // Capital preservation earns 0% here: the plan moves money there ahead of the
  // spending, and its growth is (deliberately) not taxed yearly, so it would carry a gain.
  s.buckets.preservationReturnPct = 0;
  s.spending = [{ name: "later", monthly: 1000, fromYear: 2027, toYear: null, growthPct: 0, variable: false }];
  const sim = simulate(s);
  near(sim.rows[1].withdrawn, 12_000, "no gross-up: nothing to tax on the sale");
  near(sim.rows[1].tax, sim.rows[1].incomeTax, "only the yearly interest tax");
});

test("equities in a taxable account: only the dividend yield is taxed yearly, at the gains rate", () => {
  // $100k, 2% dividends = $2,000; 25% = $500. The other 6% is unrealized growth.
  const sim = simulate(incomeTaxPlan("equities"));
  near(sim.rows[0].incomeTax, 500);
  near(sim.rows[0].bal, 108_000 - 500);
});

test("capital preservation isn't taxed yearly (munis), and neither are IRAs or Roths", () => {
  assert.equal(simulate(incomeTaxPlan("preservation")).rows[0].incomeTax, 0);
  assert.equal(simulate(incomeTaxPlan("income", "traditional_ira")).rows[0].incomeTax, 0);
  assert.equal(simulate(incomeTaxPlan("equities", "roth_ira")).rows[0].incomeTax, 0);
});

test("bucket-plan money in a taxable account is taxed on its high income and equities shares", () => {
  const s = incomeTaxPlan("buckets", "taxable", 30);
  s.spending = [{ name: "living", monthly: 300, fromYear: null, toYear: null, growthPct: 0, variable: false }];
  const P = prepare(s);
  const sim = runPlan(P);
  const m = sim.startMix;
  near(sim.rows[0].incomeTax, m.income * 0.06 * 0.4 + m.equities * 0.02 * 0.25, "income share at 40%, dividends at 25%", 0.5);
  assert.ok(m.income > 0 && m.equities > 0, "the split holds both");
});

test("working rates apply before the retirement-rates year, retirement rates from it", () => {
  // Retirement rates from 2027: 2026 at 45%, 2027 at 30%.
  const s = incomeTaxPlan("income");
  s.taxes = { ...s.taxes, workingOrdinaryIncomePct: 45, ordinaryIncomePct: 30, retireYear: 2027 };
  const sim = simulate(s);
  near(sim.rows[0].incomeTax, 6_000 * 0.45);
  near(sim.rows[1].incomeTax, (106_000 - 2_700) * 0.06 * 0.3);
});

test("working rates also apply to withdrawals before the retirement-rates year", () => {
  const s = flat({ age: 62, spendMonthly: 7500 / 12, accounts: [newAccount({ name: "ira", type: "traditional_ira", balance: 100_000 })] });
  s.taxes = { ...s.taxes, workingOrdinaryIncomePct: 25, ordinaryIncomePct: 0, retireYear: 2027 };
  const sim = simulate(s);
  near(sim.rows[0].tax, 2_500, "7,500 net at 25% = 10,000 gross");
  near(sim.rows[1].tax, 0, "retired: 0%");
});

test("in a simulated future, interest is taxed on the expected return, not the year's actual return", () => {
  // High income falls 10% this year: the fund still paid its 6% interest (the
  // price fell more), so the tax is unchanged.
  const s = incomeTaxPlan("income", "taxable", 1);
  const P = prepare(s);
  const path = { preservation: new Float64Array([0.03]), income: new Float64Array([-0.10]), equities: new Float64Array([0.08]) };
  const sim = runPlan(P, { path });
  near(sim.rows[0].incomeTax, 2_400);
  near(sim.rows[0].bal, 90_000 - 2_400);
});
