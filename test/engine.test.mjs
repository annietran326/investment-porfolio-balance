import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { simulate } from "../src/engine/simulate.mjs";
import { propertyCashflowYear, SALE_YEAR_OWNED_MONTHS } from "../src/engine/property.mjs";
import { placeholderState } from "../src/model/placeholder.mjs";

const state = () => placeholderState();

test("simulates from the current year to plan-to age; the current year shows the starting balance", () => {
  const s = state();
  const years = s.profile.endAge - s.profile.currentAge;
  const sim = simulate(s);
  // path: the current-year anchor (no growth) + one point per lived year
  assert.equal(sim.path.length, years + 1);
  assert.equal(sim.path[0].year, s.profile.currentYear);
  assert.equal(sim.path[0].age, s.profile.currentAge);
  assert.equal(sim.path[0].bal, s.portfolio.balance); // starts EXACTLY at what you entered
  assert.equal(sim.path.at(-1)?.year, s.profile.currentYear + years);
  assert.equal(sim.path.at(-1)?.age, s.profile.endAge);
  // rows: one per lived year (currentYear .. endAge-1)
  assert.equal(sim.rows.length, years);
  assert.equal(sim.rows[0].year, s.profile.currentYear);
  assert.equal(sim.rows.at(-1)?.age, s.profile.endAge - 1);
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
  s.incomes = [{ name: "x", annual: 100, fromYear: s.profile.currentYear, toYear: 9999, realGrowthPct: 0 }];
  s.household = { people: [] };
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
  const keep = { ...state().properties[1], rentRealGrowthPct: 0 }; // isolate from growth
  const startYear = 2026;
  const inWindow = propertyCashflowYear(keep, 2026, { startYear, vacancyMonths: 4, vacancyYears: 2 });
  const outWindow = propertyCashflowYear(keep, 2028, { startYear, vacancyMonths: 4, vacancyYears: 2 });
  assert.equal(outWindow.cf - inWindow.cf, keep.rentMonthly * 4);
});

test("healthcare: pre-65 bridge starts when employer coverage ends, Medicare at 65", () => {
  const s = state();
  s.household = { people: [] }; // self only
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
  // 600k at 2026, flat return, 24k/yr spend. Balance by year: 2026=600,
  // 2027=576, 2028=552, 2029=528, 2030=504, 2031=480 (< 500k floor); never
  // below $0 over the horizon.
  const s = state();
  s.profile = { currentAge: 40, endAge: 50, currentYear: 2026 };
  s.portfolio = { balance: 600_000, realReturnPct: 0 };
  s.properties = [];
  s.incomes = [];
  s.spending = [{ name: "living", monthly: 2000, fromYear: null, toYear: null, realGrowthPct: 0 }];
  s.social.monthly = 0;
  s.health = { preMedicareAnnual: 0, postMedicareAnnual: 0, employerCoverageUntilAge: 40 };
  s.household = { people: [] };
  s.endState = { mode: "floor", amounts: { bequest: 0, floor: 500_000 } };
  const sim = simulate(s);
  assert.equal(sim.firstNegYear, null, "never below $0");
  assert.equal(sim.firstBreachYear, 2031, "the floor breach IS the runway end");
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

// ---- v2: growth, spending windows, household ----

test("zero growth + open windows + no spouse reproduces v1 numbers exactly", () => {
  // The migration guarantee: a state with all-default new fields simulates
  // identically to how it would have without them.
  const s = state();
  s.properties.forEach((p) => {
    p.rentRealGrowthPct = 0;
    p.costsRealGrowthPct = 0;
  });
  s.incomes.forEach((inc) => (inc.realGrowthPct = 0));
  s.spending = [
    { name: "housing", monthly: 3500, fromYear: null, toYear: null, realGrowthPct: 0 },
    { name: "living", monthly: 2500, fromYear: null, toYear: null, realGrowthPct: 0 },
  ];
  s.household = { people: [] };
  const withDefaults = simulate(s);
  // Hand-derived year-0 spend = (3500+2500)*12 + self healthcare(age40, employer until 40 → 16000)
  assert.equal(withDefaults.rows[0].spend, 6000 * 12 + 16000);
});

test("real growth compounds from the current year on income, rent, and spending", () => {
  const s = state();
  s.properties = [];
  s.incomes = [{ name: "grows", annual: 100000, fromYear: 2026, toYear: 9999, realGrowthPct: 2 }];
  s.spending = [{ name: "grows", monthly: 1000, fromYear: null, toYear: null, realGrowthPct: 3 }];
  s.social.monthly = 0;
  s.health = { preMedicareAnnual: 0, postMedicareAnnual: 0, employerCoverageUntilAge: 0 };
  s.household = { people: [] };
  const sim = simulate(s);
  // year offset 0 = base; offset 5 = base*(1+g)^5
  assert.equal(sim.rows[0].income, 100000);
  assert.ok(Math.abs(sim.rows[5].income - 100000 * 1.02 ** 5) < 1e-6);
  assert.equal(sim.rows[0].spend, 12000);
  assert.ok(Math.abs(sim.rows[5].spend - 12000 * 1.03 ** 5) < 1e-6);
});

test("property rent grows but mortgage stays fixed (nominal) — cash flow rises over time", () => {
  const p = { name: "g", rentMonthly: 2000, costsMonthly: 0, mortgageMonthly: 1000, payoffYear: null, saleYear: null, saleNetProceeds: null, rentRealGrowthPct: 2, costsRealGrowthPct: 0 };
  const y0 = propertyCashflowYear(p, 2026, { startYear: 2026 });
  const y10 = propertyCashflowYear(p, 2036, { startYear: 2026 });
  assert.equal(y0.cf, (2000 - 1000) * 12);
  // rent grew 2%^10, mortgage flat → cash flow strictly higher
  const expected = (2000 * 1.02 ** 10 - 1000) * 12;
  assert.ok(Math.abs(y10.cf - expected) < 1e-6);
  assert.ok(y10.cf > y0.cf);
});

test("spending window: a time-boxed cost applies only within [fromYear, toYear]", () => {
  const s = state();
  s.properties = [];
  s.incomes = [];
  s.social.monthly = 0;
  s.health = { preMedicareAnnual: 0, postMedicareAnnual: 0, employerCoverageUntilAge: 0 };
  s.household = { people: [] };
  s.spending = [
    { name: "perpetual", monthly: 1000, fromYear: null, toYear: null, realGrowthPct: 0 },
    { name: "dependent", monthly: 500, fromYear: null, toYear: 2030, realGrowthPct: 0 },
  ];
  const sim = simulate(s);
  const spendIn = (yr) => sim.rows.find((r) => r.year === yr)?.spend;
  assert.equal(spendIn(2030), (1000 + 500) * 12); // dependent still active
  assert.equal(spendIn(2031), 1000 * 12); // dependent ended
});

test("spouse contributes their own Social Security on their own age trajectory", () => {
  const s = state();
  s.properties = [];
  s.incomes = [];
  s.spending = [];
  s.social = { startAge: 67, monthly: 0, haircutPct: 0 }; // self: no SS
  s.health = { preMedicareAnnual: 0, postMedicareAnnual: 0, employerCoverageUntilAge: 0 };
  s.household = {
    people: [{ name: "Spouse", role: "spouse", currentAge: 62, social: { startAge: 67, monthly: 2000, haircutPct: 25 }, health: { preMedicareAnnual: 0, postMedicareAnnual: 0, employerCoverageUntilAge: 0 } }],
  };
  const sim = simulate(s);
  // spouse is 62 now; hits 67 in 5 years (2031). SS = 2000*12*0.75 = 18000
  assert.equal(sim.rows.find((r) => r.year === 2030)?.ss, 0);
  assert.equal(sim.rows.find((r) => r.year === 2031)?.ss, 18000);
});

test("spouse healthcare adds a second pre-65 bridge and a second Medicare load", () => {
  const s = state();
  s.properties = [];
  s.incomes = [];
  s.spending = [];
  s.social.monthly = 0;
  s.health = { preMedicareAnnual: 16000, postMedicareAnnual: 7500, employerCoverageUntilAge: 40 };
  s.profile = { currentAge: 60, endAge: 95, currentYear: 2026 };
  s.household = {
    people: [{ name: "Spouse", role: "spouse", currentAge: 60, social: { startAge: 67, monthly: 0, haircutPct: 25 }, health: { preMedicareAnnual: 16000, postMedicareAnnual: 7500, employerCoverageUntilAge: 40 } }],
  };
  const sim = simulate(s);
  const at = (age) => sim.rows.find((r) => r.age === age)?.health;
  assert.equal(at(60), 16000 + 16000); // both on the pre-65 bridge
  assert.equal(at(65), 7500 + 7500); // both on Medicare
});

test("spouse older than self is already past SS/Medicare at year 0", () => {
  const s = state();
  s.properties = [];
  s.incomes = [];
  s.spending = [];
  s.social = { startAge: 67, monthly: 0, haircutPct: 0 };
  s.health = { preMedicareAnnual: 0, postMedicareAnnual: 0, employerCoverageUntilAge: 0 };
  s.profile = { currentAge: 40, endAge: 95, currentYear: 2026 };
  s.household = {
    people: [{ name: "Older spouse", role: "spouse", currentAge: 68, social: { startAge: 67, monthly: 2000, haircutPct: 25 }, health: { preMedicareAnnual: 16000, postMedicareAnnual: 7500, employerCoverageUntilAge: 40 } }],
  };
  const sim = simulate(s);
  // spouse is 68 at year 0 → already collecting SS (18000) and on Medicare (7500) immediately
  assert.equal(sim.rows[0].ss, 18000);
  assert.equal(sim.rows[0].health, 7500);
});

test("a future-starting spending line with growth compounds from the current year (consistent with income)", () => {
  const s = state();
  s.properties = [];
  s.incomes = [];
  s.social.monthly = 0;
  s.health = { preMedicareAnnual: 0, postMedicareAnnual: 0, employerCoverageUntilAge: 0 };
  s.household = { people: [] };
  s.spending = [{ name: "tuition (starts 2031)", monthly: 1000, fromYear: 2031, toYear: null, realGrowthPct: 3 }];
  const sim = simulate(s);
  assert.equal(sim.rows.find((r) => r.year === 2030)?.spend, 0); // inactive before its window
  // active from 2031 (offset i=5); grows from currentYear 2026, not from 2031
  const y2031 = sim.rows.find((r) => r.year === 2031)?.spend;
  assert.ok(Math.abs(/** @type {number} */ (y2031) - 12000 * 1.03 ** 5) < 1e-6);
});

test("a dependent with no support cost has no direct engine effect", () => {
  const a = state();
  a.household = { people: [] };
  const b = structuredClone(a);
  b.household = { people: [{ name: "Kid", role: "dependent", currentAge: null, annualCost: 0, fromYear: null, toYear: null }] };
  assert.deepEqual(simulate(a).rows, simulate(b).rows);
});

test("a dependent's annual support cost applies every year within its window", () => {
  const s = state();
  s.properties = [];
  s.incomes = [];
  s.spending = [];
  s.social.monthly = 0;
  s.health = { preMedicareAnnual: 0, postMedicareAnnual: 0, employerCoverageUntilAge: 0 };
  s.household = { people: [{ name: "Kid", role: "dependent", currentAge: null, annualCost: 18_000, fromYear: null, toYear: 2044 }] };
  const sim = simulate(s);
  assert.equal(sim.rows.find((r) => r.year === 2026)?.spend, 18_000); // from the start (null fromYear)
  assert.equal(sim.rows.find((r) => r.year === 2044)?.spend, 18_000); // last year of the window
  assert.equal(sim.rows.find((r) => r.year === 2045)?.spend, 0); // window ended
  // it IS a living expense, so the +20% spending shock scales it
  assert.equal(simulate(s, { spendMult: 1.2 }).rows.find((r) => r.year === 2030)?.spend, 21_600);
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

// ---- v5: effective-rate withdrawal tax --------------------------------------

// A minimal one-year drawdown fixture: no growth, no income/SS/property, a fixed
// spending shortfall, so the tax is hand-computable.
function drawdownFixture({ balance = 1_000_000, monthly = 7500, years = 1, tax } = {}) {
  const s = state();
  s.profile = { currentAge: 40, endAge: 40 + years, currentYear: 2026 };
  s.portfolio = { balance, realReturnPct: 0 };
  s.properties = [];
  s.incomes = [];
  s.spending = [{ name: "living", monthly, fromYear: null, toYear: null, realGrowthPct: 0 }];
  s.social = { startAge: 67, monthly: 0, haircutPct: 25 };
  s.health = { preMedicareAnnual: 0, postMedicareAnnual: 0, employerCoverageUntilAge: 40 };
  s.household = { people: [] };
  s.tax = tax ?? { enabled: false, effectiveGainsRatePct: 18, embeddedGainPct: 50 };
  return s;
}

test("tax disabled: every row carries tax 0 and the balance math is unchanged", () => {
  const s = drawdownFixture({ monthly: 7500 }); // 90k/yr shortfall
  const sim = simulate(s);
  assert.equal(sim.rows[0].tax, 0);
  // balGrown(=1,000,000) + net(-90,000) - tax(0)
  assert.equal(sim.endBal, 910_000);
});

test("tax disabled === enabled-with-zero-rate === enabled-with-zero-gain (branch is a true no-op)", () => {
  const off = simulate(drawdownFixture({ years: 10 }));
  const zeroRate = simulate(drawdownFixture({ years: 10, tax: { enabled: true, effectiveGainsRatePct: 0, embeddedGainPct: 50 } }));
  const zeroGain = simulate(drawdownFixture({ years: 10, tax: { enabled: true, effectiveGainsRatePct: 20, embeddedGainPct: 0 } }));
  assert.equal(zeroRate.endBal, off.endBal);
  assert.equal(zeroGain.endBal, off.endBal);
  assert.ok(off.rows.every((r) => r.tax === 0));
  assert.ok(zeroRate.rows.every((r) => r.tax === 0));
});

test("tax enabled, drawdown year: grossed-up tax on the gain portion (hand-computed)", () => {
  // shortfall 90,000; embeddedGain 50% × rate 20% = gainRate 0.10
  // W = 90,000 / (1 − 0.10) = 100,000 ; tax = W − shortfall = 10,000
  // bal = 1,000,000 − 90,000 − 10,000 = 900,000
  const s = drawdownFixture({ monthly: 7500, tax: { enabled: true, effectiveGainsRatePct: 20, embeddedGainPct: 50 } });
  const sim = simulate(s);
  assert.equal(sim.rows[0].tax, 10_000);
  assert.equal(sim.endBal, 900_000);
});

test("tax enabled: no tax in surplus years (net ≥ 0)", () => {
  const s = drawdownFixture({ tax: { enabled: true, effectiveGainsRatePct: 20, embeddedGainPct: 50 } });
  s.incomes = [{ name: "plenty", annual: 200_000, fromYear: 2026, toYear: 9999, realGrowthPct: 0 }]; // net positive
  const sim = simulate(s);
  assert.ok(sim.rows.every((r) => r.tax === 0), "surplus years realize no gains → no tax");
});

test("tax enabled strictly shortens runway vs disabled when drawdowns occur", () => {
  const off = simulate(drawdownFixture({ years: 8 }));
  const on = simulate(drawdownFixture({ years: 8, tax: { enabled: true, effectiveGainsRatePct: 20, embeddedGainPct: 50 } }));
  assert.ok(on.endBal < off.endBal, "tax draws the balance down faster");
});

test("partial-funding edge: tax is capped at what the balance can actually sell", () => {
  // balance 50k, 90k/yr shortfall. Year 0 can only sell its 50k (not the full
  // grossed-up 100k), so it's taxed on 50k of gains — not the whole shortfall.
  // Year 1 starts underwater → no gains to realize → tax 0.
  const s = drawdownFixture({ balance: 50_000, monthly: 7500, years: 2, tax: { enabled: true, effectiveGainsRatePct: 20, embeddedGainPct: 50 } });
  const sim = simulate(s);
  assert.equal(sim.rows[0].tax, 5_000); // 50,000 sold × 50% gain × 20% rate
  assert.equal(sim.rows[0].bal, -45_000); // 50,000 − 90,000 − 5,000
  assert.equal(sim.rows[1].tax, 0, "no gains to realize once underwater");
});
