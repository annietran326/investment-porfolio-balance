import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { simulate } from "../src/engine/simulate.mjs";
import { propertyCashflowYear, SALE_YEAR_OWNED_MONTHS } from "../src/engine/property.mjs";
import { placeholderState } from "../src/model/placeholder.mjs";

const state = () => placeholderState();

test("simulates the full horizon", () => {
  const s = state();
  const years = s.profile.endAge - s.profile.currentAge;
  const sim = simulate(s);
  assert.equal(sim.path.length, years + 2); // starting point + one per simulated year
  assert.equal(sim.rows.length, years + 1);
  assert.equal(sim.rows.at(-1)?.age, s.profile.endAge);
});

test("balance-update ordering: growth on prior balance, then net cash lands", () => {
  // Hand-computed 2-year fixture: bal 1000, r 10%, net +100/yr
  // year 1: 1000*1.1 + 100 = 1200 ; year 2: 1200*1.1 + 100 = 1420
  const s = state();
  s.portfolio = { balance: 1000, realReturnPct: 10 };
  s.properties = [];
  s.spending = [];
  s.social.monthly = 0;
  s.health = { preMedicareAnnual: 0, postMedicareAnnual: 0, employerCoverageUntilAge: 0 };
  s.incomes = [{ name: "x", annual: 100, fromYear: s.profile.currentYear, toYear: 9999 }];
  const sim = simulate(s);
  assert.equal(Math.round(sim.rows[0].bal), 1200);
  assert.equal(Math.round(sim.rows[1].bal), 1420);
});

test("sale year books part-year ownership plus proceeds exactly once", () => {
  const p = state().properties[0]; // sells 2027, proceeds 250k
  const saleYear = /** @type {number} */ (p.saleYear);
  const inSale = propertyCashflowYear(p, saleYear);
  assert.equal(inSale.proceeds, p.saleNetProceeds);
  const expectedCf = (p.rentMonthly - p.costsMonthly - p.mortgageMonthly) * SALE_YEAR_OWNED_MONTHS;
  assert.equal(inSale.cf, expectedCf);
  const after = propertyCashflowYear(p, saleYear + 1);
  assert.deepEqual(after, { cf: 0, proceeds: 0 });
  const before = propertyCashflowYear(p, saleYear - 1);
  assert.equal(before.proceeds, 0);
  assert.equal(before.cf, (p.rentMonthly - p.costsMonthly - p.mortgageMonthly) * 12);
});

test("a sale predating the simulation window stays sold under saleDelayYears — zero cf, zero proceeds", () => {
  // saleYear 2025 is one year before the window; a 2-year delay would land it
  // at 2027 (INSIDE the window) if the overlay were allowed to resurrect it.
  const p = { ...state().properties[0], saleYear: 2025, saleNetProceeds: 250_000 };
  const overlay = { startYear: 2026, saleDelayYears: 2 };
  for (let year = 2026; year <= 2032; year++) {
    assert.deepEqual(propertyCashflowYear(p, year, overlay), { cf: 0, proceeds: 0 }, `year ${year}`);
  }
});

test("delayed sale shifts proceeds; keep-forever property cashflows forever", () => {
  const p = state().properties[0];
  const saleYear = /** @type {number} */ (p.saleYear);
  assert.equal(propertyCashflowYear(p, saleYear, { saleDelayYears: 2 }).proceeds, 0);
  assert.equal(propertyCashflowYear(p, saleYear + 2, { saleDelayYears: 2 }).proceeds, p.saleNetProceeds);

  const keep = state().properties[1]; // saleYear null
  assert.notEqual(propertyCashflowYear(keep, 2080).cf, 0);
  assert.equal(propertyCashflowYear(keep, 2080).proceeds, 0);
});

test("mortgage is paid through the payoff year and stops after it", () => {
  const keep = state().properties[1];
  const payoff = /** @type {number} */ (keep.payoffYear);
  const during = propertyCashflowYear(keep, payoff);
  const after = propertyCashflowYear(keep, payoff + 1);
  assert.equal(after.cf, during.cf + keep.mortgageMonthly * 12);
});

test("vacancy overlay knocks months off rent only inside the window", () => {
  const keep = state().properties[1];
  const startYear = 2026;
  const inWindow = propertyCashflowYear(keep, 2026, { startYear, vacancyMonths: 4, vacancyYears: 2 });
  const outWindow = propertyCashflowYear(keep, 2028, { startYear, vacancyMonths: 4, vacancyYears: 2 });
  assert.equal(outWindow.cf - inWindow.cf, keep.rentMonthly * 4);
});

test("healthcare: pre-65 bridge starts when employer coverage ends, Medicare at 65", () => {
  const s = state();
  s.health = { preMedicareAnnual: 18000, postMedicareAnnual: 7000, employerCoverageUntilAge: 45 };
  const sim = simulate(s);
  const at = (age) => sim.rows.find((r) => r.age === age);
  assert.equal(at(44)?.health, 0); // employer still covers
  assert.equal(at(45)?.health, 18000); // bridge begins
  assert.equal(at(64)?.health, 18000);
  assert.equal(at(65)?.health, 7000); // Medicare
});

test("social security starts at start age with the haircut applied", () => {
  const s = state();
  const sim = simulate(s);
  const expected = s.social.monthly * 12 * (1 - s.social.haircutPct / 100);
  const before = sim.rows.find((r) => r.age === s.social.startAge - 1);
  const atStart = sim.rows.find((r) => r.age === s.social.startAge);
  assert.equal(before?.ss, 0);
  assert.equal(atStart?.ss, expected);
});

test("scenario knobs: drawdown haircuts the starting balance; one-time cost lands in its year", () => {
  const s = state();
  const base = simulate(s);
  const draw = simulate(s, { drawdownPct: 30 });
  assert.equal(Math.round(draw.path[0].bal), Math.round(base.path[0].bal * 0.7));

  const shock = simulate(s, { oneTimeCost: 50000, oneTimeCostYearIdx: 3 });
  assert.equal(shock.rows[3].spend - base.rows[3].spend, 50000);
  assert.equal(shock.rows[2].spend, base.rows[2].spend);
});

test("floor mode: firstBreachYear marks the first dip below the floor while firstNegYear stays null", () => {
  // 600k, flat return, 24k/yr spend: 576, 552, 528, 504, 480 (< 500k floor in
  // 2030), … never below $0 over the 11-year horizon.
  const s = state();
  s.profile = { currentAge: 40, endAge: 50, currentYear: 2026 };
  s.portfolio = { balance: 600_000, realReturnPct: 0 };
  s.properties = [];
  s.incomes = [];
  s.spending = [{ name: "living", monthly: 2000 }];
  s.social.monthly = 0;
  s.health = { preMedicareAnnual: 0, postMedicareAnnual: 0, employerCoverageUntilAge: 40 };
  s.endState = { mode: "floor", amounts: { bequest: 0, floor: 500_000 } };
  const sim = simulate(s);
  assert.equal(sim.firstNegYear, null, "never below $0");
  assert.equal(sim.firstBreachYear, 2030, "the floor breach IS the runway end");
  assert.ok(sim.minBal >= 0);

  // zero/bequest modes: the breach threshold is $0 — firstBreachYear tracks firstNegYear.
  s.endState = { mode: "zero", amounts: { bequest: 0, floor: 500_000 } };
  const zeroSim = simulate(s);
  assert.equal(zeroSim.firstBreachYear, null);
  assert.equal(zeroSim.firstBreachYear, zeroSim.firstNegYear);
});

test("zero assets and no income runs out immediately", () => {
  const s = state();
  s.portfolio.balance = 0;
  s.incomes = [];
  s.properties = [];
  const sim = simulate(s);
  assert.notEqual(sim.firstNegYear, null);
});

test("engine purity: no node imports, no Date, no clock anywhere in src/engine", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "engine");
  for (const f of readdirSync(dir)) {
    const text = readFileSync(join(dir, f), "utf8");
    assert.ok(!/from\s+["']node:/.test(text), `${f} imports a node builtin`);
    assert.ok(!/\bDate\b/.test(text), `${f} reads the clock`);
    assert.ok(!/\bprocess\b/.test(text), `${f} touches process`);
  }
});
