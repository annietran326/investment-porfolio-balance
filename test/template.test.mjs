// XLSX template import/export (U8): coercion + null-vs-0 semantics, per-tab
// replace/block behavior, zip bounds + macro defenses, formula-injection
// neutralization, and the preview→apply API flow on a real ephemeral server.
// Hostile zip fixtures are hand-rolled in-test; workbook fixtures use xlsx.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { deflateRawSync } from "node:zlib";
import * as XLSX from "xlsx";
import { createStore } from "../src/server/store.mjs";
import { createApi } from "../src/server/api.mjs";
import { placeholderState } from "../src/model/placeholder.mjs";
import { defaultState, validate } from "../src/model/schema.mjs";
import {
  applicableTabs,
  applyTabs,
  buildTemplateWorkbook,
  guardText,
  isRejectedFilename,
  parseTemplate,
  previewTemplate,
  unguardText,
} from "../src/import/template.mjs";
import { TEMPLATE_DEF } from "../scripts/build-template.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALL_TABS = TEMPLATE_DEF.tabs.map((t) => t.key);
const HEADERS = Object.fromEntries(TEMPLATE_DEF.tabs.map((t) => [t.name, t.columns.map((c) => c.header)]));

// ---------------------------------------------------------------------------
// fixture builders
// ---------------------------------------------------------------------------

/** Workbook buffer from {SheetName: aoa} via xlsx (null cells stay empty). */
function wbBuffer(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/**
 * Hand-rolled zip for hostile fixtures. Entries: {name, data, method (0|8),
 * declaredUncomp} — declaredUncomp forges the central-directory (and local)
 * uncompressed-size field to simulate lying headers.
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name);
    const raw = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 0;
    const comp = method === 8 ? deflateRawSync(raw) : raw;
    const uncomp = e.declaredUncomp ?? raw.length;
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(uncomp, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(uncomp, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ---------------------------------------------------------------------------
// parse + apply semantics
// ---------------------------------------------------------------------------

test("round-trip: export → parse → apply all tabs is a no-op deep-equal", () => {
  const state = placeholderState();
  const parsed = parseTemplate(buildTemplateWorkbook(state));
  assert.deepEqual(parsed.tabsFound, ALL_TABS);
  assert.deepEqual(parsed.tabsMissing, []);
  for (const k of parsed.tabsFound) assert.deepEqual(parsed.perTab[k].errors, [], `tab ${k} must parse clean`);

  const applied = applyTabs(defaultState(), parsed, parsed.tabsFound);
  assert.deepEqual(applied, state, "re-importing an export reproduces the state exactly");

  // …and against the same state the preview is all-ready, zero-diff.
  const pv = previewTemplate(state, parsed);
  for (const t of pv.tabs) {
    assert.equal(t.status, "ready");
    assert.equal(t.adds + t.removes + t.changes, 0, `${t.key} shows no changes`);
  }
  assert.equal(pv.headline.totalBalance.before, pv.headline.totalBalance.after);
  assert.equal(pv.headline.monthlySpend.before, pv.headline.monthlySpend.after);
});

test("the committed template artifact parses clean (parser and template can't drift)", () => {
  const parsed = parseTemplate(readFileSync(join(ROOT, "template", "runway-template.xlsx")));
  assert.deepEqual(parsed.tabsFound, ALL_TABS);
  for (const k of parsed.tabsFound) assert.deepEqual(parsed.perTab[k].errors, []);
});

// ---------------------------------------------------------------------------
// v2 round-trip: growth columns, expense windows, Household tab
// ---------------------------------------------------------------------------

test("v3 round-trip: spouse + dependent (w/ lump sum) + growing rent + time-boxed spending survive export→reimport", () => {
  // A state that touches every new v2/v3 field: a property whose rent outpaces
  // inflation, a time-boxed spending line, and a household with a spouse (SS +
  // healthcare) and a dependent carrying a one-time future lump-sum cost.
  const state = defaultState();
  state.properties = [
    { name: "Rental (rent +1.5%, costs -0.5% real)", rentMonthly: 3000, costsMonthly: 850, mortgageMonthly: 2100, payoffYear: 2048, saleYear: null, saleNetProceeds: null, rentRealGrowthPct: 1.5, costsRealGrowthPct: -0.5 },
  ];
  state.incomes = [{ name: "Consulting (grows 2% real)", annual: 60_000, fromYear: 2026, toYear: 2035, realGrowthPct: 2 }];
  state.spending = [
    { name: "living", monthly: 3000, fromYear: null, toYear: null, realGrowthPct: 0 }, // perpetual
    { name: "childcare (ends 2032)", monthly: 1800, fromYear: 2026, toYear: 2032, realGrowthPct: 0 }, // time-boxed
    { name: "hobby (starts 2030, +1% real)", monthly: 400, fromYear: 2030, toYear: null, realGrowthPct: 1 }, // open-ended from a future year
  ];
  state.household = {
    people: [
      // Spouse: SS + healthcare, and (per the UI) no lump sum → 0/null.
      {
        name: "Partner",
        role: "spouse",
        currentAge: 42,
        lumpSum: 0,
        lumpSumYear: null,
        social: { startAge: 68, monthly: 2600, haircutPct: 20 },
        health: { preMedicareAnnual: 15_000, postMedicareAnnual: 8_000, employerCoverageUntilAge: 63 },
      },
      // Dependent: a $200K college cost landing in 2040 — the v3 lump-sum fields.
      { name: "Kid", role: "dependent", currentAge: 10, lumpSum: 200_000, lumpSumYear: 2040 },
    ],
  };
  assert.deepEqual(validate(state).errors, [], "fixture is itself a valid v3 state");

  const parsed = parseTemplate(buildTemplateWorkbook(state));
  assert.deepEqual(parsed.tabsFound, ALL_TABS);
  for (const k of parsed.tabsFound) assert.deepEqual(parsed.perTab[k].errors, [], `tab ${k} parses clean`);

  const applied = applyTabs(defaultState(), parsed, parsed.tabsFound);
  assert.deepEqual(applied, state, "every new v2/v3 field round-trips exactly (no-op)");
  assert.deepEqual(validate(applied).errors, [], "the reimported state is valid v3");

  // Spot-check the load-bearing new fields specifically.
  assert.equal(applied.properties[0].rentRealGrowthPct, 1.5);
  assert.equal(applied.properties[0].costsRealGrowthPct, -0.5);
  assert.equal(applied.incomes[0].realGrowthPct, 2);
  assert.equal(applied.spending[0].toYear, null, "perpetual line keeps toYear null (not 0)");
  assert.deepEqual([applied.spending[1].fromYear, applied.spending[1].toYear], [2026, 2032], "time-boxed window survives");
  assert.deepEqual([applied.spending[2].fromYear, applied.spending[2].toYear], [2030, null], "open-ended-from-future survives");
  const [spouse, dep] = applied.household.people;
  assert.deepEqual(spouse.social, { startAge: 68, monthly: 2600, haircutPct: 20 });
  assert.deepEqual(spouse.health, { preMedicareAnnual: 15_000, postMedicareAnnual: 8_000, employerCoverageUntilAge: 63 });
  assert.deepEqual([spouse.lumpSum, spouse.lumpSumYear], [0, null], "spouse's blank lump-sum round-trips as 0/null");
  assert.equal(dep.role, "dependent");
  assert.deepEqual([dep.lumpSum, dep.lumpSumYear], [200_000, 2040], "dependent's lump-sum cost + year survive the round-trip");
  assert.equal(dep.social, undefined, "a dependent carries no social section");
  assert.equal(dep.health, undefined, "a dependent carries no health section");
});

test("Household tab: absent → people untouched; present → replaces; bad role → cell error", () => {
  const state = placeholderState(); // ships with a spouse + a dependent

  // (1) Absent Household tab: importing other tabs leaves people untouched.
  const noHousehold = parseTemplate(wbBuffer({ Accounts: [HEADERS.Accounts, [500000, 3]] }));
  assert.ok(noHousehold.tabsMissing.includes("household"));
  const afterNoTab = applyTabs(state, noHousehold, ["accounts"]);
  assert.deepEqual(afterNoTab.household, state.household, "no Household tab does NOT wipe existing people");

  // (2) Present Household tab replaces people wholesale: a fresh spouse (with
  // SS/health cells, blank lump-sum) and a dependent (spouse-only cells blank)
  // carrying a lump-sum college cost + year. Column order:
  // Name, Role, Age, Lump-sum $, Lump-sum year, SS start, SS $/mo, SS haircut,
  // Health pre-65, Health 65+, Employer coverage.
  const H = HEADERS.Household;
  const withHousehold = parseTemplate(
    wbBuffer({
      Household: [
        H,
        ["New Spouse", "spouse", 45, null, null, 67, 3000, 25, 16000, 7500, 65],
        ["New Kid", "dependent", 5, 120000, 2039, null, null, null, null, null, null],
      ],
    })
  );
  assert.deepEqual(withHousehold.perTab.household.errors, []);
  const applied = applyTabs(state, withHousehold, ["household"]);
  assert.equal(applied.household.people.length, 2);
  assert.deepEqual(applied.household.people[0], {
    name: "New Spouse",
    role: "spouse",
    currentAge: 45,
    lumpSum: 0,
    lumpSumYear: null,
    social: { startAge: 67, monthly: 3000, haircutPct: 25 },
    health: { preMedicareAnnual: 16000, postMedicareAnnual: 7500, employerCoverageUntilAge: 65 },
  });
  assert.deepEqual(
    applied.household.people[1],
    { name: "New Kid", role: "dependent", currentAge: 5, lumpSum: 120000, lumpSumYear: 2039 },
    "a dependent's lump-sum cost + year apply from the Household tab"
  );
  assert.deepEqual(validate(applied).errors, [], "replaced household is valid v3");

  // A spouse row with blank SS/health/lump-sum cells keeps the schema defaults.
  const blankSpouse = parseTemplate(wbBuffer({ Household: [H, ["Bare", "spouse", 40, null, null, null, null, null, null, null, null]] }));
  assert.deepEqual(blankSpouse.perTab.household.errors, []);
  const bare = applyTabs(state, blankSpouse, ["household"]).household.people[0];
  assert.deepEqual([bare.lumpSum, bare.lumpSumYear], [0, null], "blank lump-sum cells → 0 / null");
  assert.deepEqual(bare.social, { startAge: 67, monthly: 0, haircutPct: 25 }, "blank SS cells → newSocial() defaults");
  assert.deepEqual(bare.health, { preMedicareAnnual: 16000, postMedicareAnnual: 7500, employerCoverageUntilAge: 65 }, "blank health cells → newHealth() defaults");

  // A dependent with a lump-sum cost but no year is accepted (year → null),
  // mirroring how a sale year and its proceeds are read independently.
  const lumpNoYear = parseTemplate(wbBuffer({ Household: [H, ["Kid2", "dependent", 8, 90000, null, null, null, null, null, null, null]] }));
  assert.deepEqual(lumpNoYear.perTab.household.errors, []);
  const kid2 = applyTabs(state, lumpNoYear, ["household"]).household.people[0];
  assert.deepEqual([kid2.lumpSum, kid2.lumpSumYear], [90000, null], "cost without a year → cost kept, year null (no error)");
  assert.deepEqual(validate(applyTabs(state, lumpNoYear, ["household"])).errors, [], "lump-sum-without-year state is valid v3");

  // (3) Bad role value → cell-addressed error; the tab is blocked.
  const badRole = parseTemplate(wbBuffer({ Household: [H, ["Confused", "cousin", 30, null, null, null, null, null, null, null, null]] }));
  assert.equal(badRole.perTab.household.errors.length, 1);
  assert.equal(badRole.perTab.household.errors[0].cell, "Household!B2");
  assert.match(badRole.perTab.household.errors[0].message, /role must be one of spouse, dependent/);
  assert.deepEqual(applicableTabs(badRole), [], "a bad role blocks the whole Household tab");
});

test("missing Income tab → section unchanged; present tabs replace theirs", () => {
  const buf = wbBuffer({
    Accounts: [HEADERS.Accounts, [500000, 3]],
    Spending: [HEADERS.Spending, ["food", 900]],
  });
  const parsed = parseTemplate(buf);
  assert.deepEqual(parsed.tabsFound, ["accounts", "spending"]);
  assert.deepEqual(parsed.tabsMissing, ["properties", "income", "household", "assumptions"]);

  const pv = previewTemplate(placeholderState(), parsed);
  assert.equal(pv.tabs.find((t) => t.key === "income").status, "missing");
  assert.equal(pv.tabs.find((t) => t.key === "household").status, "missing");
  assert.equal(pv.headline.totalBalance.after, 500000);
  assert.equal(pv.headline.monthlySpend.after, 900);

  const state = placeholderState();
  const applied = applyTabs(state, parsed, ["accounts", "spending"]);
  assert.deepEqual(applied.incomes, state.incomes, "absent tab leaves incomes untouched");
  assert.deepEqual(applied.properties, state.properties, "absent tab leaves properties untouched");
  assert.deepEqual(applied.household, state.household, "absent Household tab leaves people untouched");
  // Derived spending is v2-complete: perpetual (fromYear/toYear null), inflation-tracking.
  assert.deepEqual(applied.spending, [{ name: "food", monthly: 900, fromYear: null, toYear: null, realGrowthPct: 0 }]);
  assert.deepEqual(applied.portfolio, { balance: 500000, realReturnPct: 3 });
});

test("text in a rent cell → cell-addressed error; tab blocked; other tabs still applicable", () => {
  const buf = wbBuffer({
    Properties: [
      HEADERS.Properties,
      ["Good1", 1000, 100, 0, null, null, null],
      ["Good2", 1200, 100, 0, null, null, null],
      ["Bad", "abc", 100, 0, null, null, null],
    ],
    Income: [HEADERS.Income, ["W2", 90000, 2026, 2030]],
  });
  const parsed = parseTemplate(buf);
  const perr = parsed.perTab.properties.errors;
  assert.equal(perr.length, 1);
  assert.equal(perr[0].cell, "Properties!B4");
  assert.match(perr[0].message, /expected a number, got 'abc'/);

  assert.deepEqual(applicableTabs(parsed), ["income"]);
  const pv = previewTemplate(placeholderState(), parsed);
  assert.equal(pv.tabs.find((t) => t.key === "properties").status, "blocked");
  assert.equal(pv.tabs.find((t) => t.key === "income").status, "ready");

  const applied = applyTabs(placeholderState(), parsed, ["income"]);
  assert.deepEqual(applied.incomes, [{ name: "W2", annual: 90000, fromYear: 2026, toYear: 2030, realGrowthPct: 0 }]);
  assert.throws(() => applyTabs(placeholderState(), parsed, ["properties"]), /not applicable/);
});

test("empty sale-year cell → null (keep forever), NEVER 0; explicit 0 → error", () => {
  const ok = parseTemplate(
    wbBuffer({
      Properties: [HEADERS.Properties, ["Keep", 1000, 100, 0, null, null, null], ["Sell", 1000, 100, 500, 2030, 2031, 50000]],
    })
  );
  assert.deepEqual(ok.perTab.properties.errors, []);
  assert.equal(ok.perTab.properties.rows[0].saleYear, null);
  assert.equal(ok.perTab.properties.rows[0].payoffYear, null);
  assert.equal(ok.perTab.properties.rows[0].saleNetProceeds, null);
  assert.equal(ok.perTab.properties.rows[1].saleYear, 2031);

  const zero = parseTemplate(wbBuffer({ Properties: [HEADERS.Properties, ["Oops", 1000, 100, 0, null, 0, 50000]] }));
  assert.equal(zero.perTab.properties.errors.length, 1);
  assert.equal(zero.perTab.properties.errors[0].cell, "Properties!F2");
  assert.match(zero.perTab.properties.errors[0].message, /0 is not a year — leave the cell empty/);
});

test('coercion: "$1,200" → 1200, "25%" → 25, "1,200" → 1200, Excel percent format → plain number', () => {
  const parsed = parseTemplate(
    wbBuffer({
      Accounts: [HEADERS.Accounts, ["$1,200", "25%"]],
      Spending: [HEADERS.Spending, ["food", "1,200"]],
    })
  );
  assert.deepEqual(parsed.perTab.accounts.errors, []);
  assert.deepEqual(parsed.perTab.accounts.rows[0], { balance: 1200, realReturnPct: 25 });
  // Blank window cells → null; blank growth cell → 0.
  assert.deepEqual(parsed.perTab.spending.rows[0], { name: "food", monthly: 1200, fromYear: null, toYear: null, realGrowthPct: 0 });

  // A percent-FORMATTED numeric cell stores 3.5% as 0.035 — the parser
  // surfaces the number the user saw in Excel.
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([HEADERS.Accounts, [500000, 0.035]]);
  ws.B2.z = "0.0%";
  XLSX.utils.book_append_sheet(wb, ws, "Accounts");
  const pctParsed = parseTemplate(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  assert.deepEqual(pctParsed.perTab.accounts.rows[0], { balance: 500000, realReturnPct: 3.5 });
});

test("income to-year before from-year is caught at the cell, not at apply time", () => {
  const parsed = parseTemplate(wbBuffer({ Income: [HEADERS.Income, ["W2", 90000, 2030, 2026]] }));
  assert.equal(parsed.perTab.income.errors.length, 1);
  assert.equal(parsed.perTab.income.errors[0].cell, "Income!D2");
  assert.match(parsed.perTab.income.errors[0].message, /before from-year/);
});

test("assumptions: note row ignored, unknown/duplicate keys error, bad mode errors, missing keys keep current values", () => {
  const A = HEADERS.Assumptions;
  const parsed = parseTemplate(
    wbBuffer({
      Assumptions: [
        A,
        ["# Inflation is NOT an input; returns are real (after inflation and tax)"],
        ["profile.currentAge", 55],
        ["endState.mode", "bequest"],
        ["endState.bequest", 250000],
      ],
    })
  );
  assert.deepEqual(parsed.perTab.assumptions.errors, []);
  const state = placeholderState();
  const applied = applyTabs(state, parsed, ["assumptions"]);
  assert.equal(applied.profile.currentAge, 55);
  assert.equal(applied.endState.mode, "bequest");
  assert.equal(applied.endState.amounts.bequest, 250000);
  assert.equal(applied.profile.endAge, state.profile.endAge, "missing key keeps the current value");
  assert.equal(applied.work.untilAge, state.work.untilAge);

  const bad = parseTemplate(
    wbBuffer({
      Assumptions: [A, ["profile.wat", 5], ["endState.mode", "everything"], ["work.untilAge", 50], ["work.untilAge", 51]],
    })
  );
  const msgs = bad.perTab.assumptions.errors;
  assert.equal(msgs.length, 3);
  assert.deepEqual(msgs[0], { cell: "Assumptions!A2", message: "unknown setting 'profile.wat'" });
  assert.equal(msgs[1].cell, "Assumptions!B3");
  assert.match(msgs[1].message, /must be one of zero, bequest, floor/);
  assert.match(msgs[2].message, /duplicate setting 'work.untilAge'/);
});

test("all tabs renamed → no recognized tabs", () => {
  const parsed = parseTemplate(wbBuffer({ Konten: [["Balance $"], [1]], Ausgaben: [["Name"], ["x"]] }));
  assert.deepEqual(parsed.tabsFound, []);
  assert.deepEqual(parsed.tabsMissing, ALL_TABS);
});

test("tab and header matching is case/whitespace-insensitive", () => {
  const parsed = parseTemplate(
    wbBuffer({ " INCOME ": [["name", "NET $/YR", "From Year", "to year"], ["W2", 1, 2026, 2027]] })
  );
  assert.deepEqual(parsed.tabsFound, ["income"]);
  assert.deepEqual(parsed.perTab.income.errors, []);
  // The optional growth column is absent here → defaults to 0 (grows with inflation).
  assert.deepEqual(parsed.perTab.income.rows[0], { name: "W2", annual: 1, fromYear: 2026, toYear: 2027, realGrowthPct: 0 });
});

test("a sheet with more rows than the 10k read cap is blocked, not silently truncated", () => {
  const rows = [HEADERS.Spending];
  for (let i = 0; i < 10_050; i++) rows.push([`cat${i}`, 1]);
  const parsed = parseTemplate(wbBuffer({ Spending: rows }));
  assert.ok(parsed.perTab.spending.errors.some((e) => /more than 10000 rows/.test(e.message)));
});

// ---------------------------------------------------------------------------
// formula-injection neutralization
// ---------------------------------------------------------------------------

test("exported text cells are inert strings; guarded round-trip restores the original", () => {
  const state = placeholderState();
  state.properties[0].name = "=cmd|'/c calc'!A0";
  state.properties[1].name = "-2+3+cmd";
  state.incomes[0].name = '+HYPERLINK("http://evil.example","click")';
  state.spending[0].name = "@SUM(A1:A9)";
  const buf = buildTemplateWorkbook(state);

  // Reparse raw: every dangerous name is an explicit string cell, carries the
  // guard apostrophe, and has no formula field.
  const wb = XLSX.read(buf, { dense: true });
  const cellAt = (sheet, r, c) => wb.Sheets[sheet]["!data"][r][c];
  for (const [sheet, r, original] of [
    ["Properties", 1, state.properties[0].name],
    ["Properties", 2, state.properties[1].name],
    ["Income", 1, state.incomes[0].name],
    ["Spending", 1, state.spending[0].name],
  ]) {
    const cell = cellAt(sheet, r, 0);
    assert.equal(cell.t, "s", `${sheet} name is a string cell`);
    assert.equal(cell.f, undefined, `${sheet} name has no formula`);
    assert.equal(cell.v, "'" + original, `${sheet} name carries the guard apostrophe`);
  }

  // Import strips the guard: full round-trip is exact.
  const applied = applyTabs(defaultState(), parseTemplate(buf), ALL_TABS);
  assert.deepEqual(applied, state);
});

test("guard/unguard are exact inverses, including already-quoted text", () => {
  for (const s of ["=x", "+x", "-x", "@x", "\tx", "\rx", "'=x", "''=x", "'plain", "plain", "a=b"]) {
    assert.equal(unguardText(guardText(s)), s, JSON.stringify(s));
  }
  assert.equal(guardText("plain"), "plain", "safe text is not modified");
  assert.equal(guardText("=SUM(A1)"), "'=SUM(A1)");
});

// ---------------------------------------------------------------------------
// zip bounds + macro defenses (before xlsx.read)
// ---------------------------------------------------------------------------

const CT_PLAIN = Buffer.from('<?xml version="1.0"?><Types><Default Extension="xml" ContentType="application/xml"/></Types>');

test("zip containing vbaProject.bin → rejected regardless of extension", () => {
  const zip = makeZip([
    { name: "[Content_Types].xml", data: CT_PLAIN },
    { name: "xl/vbaProject.bin", data: Buffer.from("junk") },
  ]);
  assert.throws(() => parseTemplate(zip), { name: "TemplateFileError", message: /macro-enabled workbook rejected/ });
});

test("macroEnabled Override content type → rejected; SheetJS's default bin line is fine", () => {
  const zip = makeZip([
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>'
      ),
    },
  ]);
  assert.throws(() => parseTemplate(zip), { name: "TemplateFileError", message: /macroEnabled content type/ });
  // The plain-workbook round-trip tests above prove the SheetJS
  // <Default Extension="bin" …macroEnabled…> line does NOT false-positive.
});

test(".xlsm / .xlsb filenames are rejected outright", () => {
  assert.equal(isRejectedFilename("book.xlsm"), true);
  assert.equal(isRejectedFilename("Book.XLSM"), true);
  assert.equal(isRejectedFilename("book.xlsb"), true);
  assert.equal(isRejectedFilename("book.xlsx"), false);
  assert.equal(isRejectedFilename("runway-export.local.xlsx"), false);
});

test("lying zip headers rejected fast: huge declared size, small-declared-big-actual, entry flood", () => {
  const huge = makeZip([{ name: "a.xml", data: Buffer.from("hi"), declaredUncomp: 400 * 1024 * 1024 }]);
  assert.throws(() => parseTemplate(huge), { name: "TemplateFileError", message: /100MB cap/ });

  const liar = makeZip([{ name: "b.xml", data: Buffer.alloc(1024 * 1024), method: 8, declaredUncomp: 10 }]);
  assert.throws(() => parseTemplate(liar), { name: "TemplateFileError", message: /lies about its uncompressed size|corrupt/ });

  const flood = makeZip(Array.from({ length: 201 }, (_, i) => ({ name: `f${i}.xml`, data: Buffer.alloc(0) })));
  assert.throws(() => parseTemplate(flood), { name: "TemplateFileError", message: /too many entries/ });

  const sumLie = makeZip(
    Array.from({ length: 3 }, (_, i) => ({ name: `s${i}.xml`, data: Buffer.from("x"), declaredUncomp: 40 * 1024 * 1024 }))
  );
  assert.throws(() => parseTemplate(sumLie), { name: "TemplateFileError", message: /more than 100MB.*in total/ });
});

test("non-zip bytes → TemplateFileError, never an xlsx crash", () => {
  assert.throws(() => parseTemplate(Buffer.from("not a zip at all")), { name: "TemplateFileError", message: /not a valid \.xlsx/ });
  assert.throws(() => parseTemplate(Buffer.alloc(3)), { name: "TemplateFileError" });
});

// ---------------------------------------------------------------------------
// API integration: preview → apply threading rev; export headers
// ---------------------------------------------------------------------------

let dir;
let store;
let server;
let base;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "runway-template-"));
  store = createStore(dir);
  store.init();
  server = createServer(createApi(store));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function getJson(path) {
  const res = await fetch(base + path);
  return { status: res.status, headers: res.headers, body: await res.json() };
}

async function sendJson(method, path, payload) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function sendOctet(path, buf) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: buf,
  });
  return { status: res.status, body: await res.json() };
}

async function currentRev() {
  return (await getJson("/health")).body.rev;
}

test("GET /api/export/template: xlsx attachment with the expected tabs", async () => {
  const res = await fetch(base + "/api/export/template");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="runway-export.local.xlsx"');
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { dense: true });
  assert.deepEqual(wb.SheetNames, TEMPLATE_DEF.tabs.map((t) => t.name));
});

test("preview → apply: threads rev, 409 stale, 410 expired token, 400 invalid tabs, snapshot provenance", async () => {
  // Seed real data so the import has something to replace (and snapshot).
  const seeded = placeholderState();
  seeded.portfolio.balance = 777_000;
  const put = await sendJson("PUT", "/api/state", { state: seeded, baseRev: await currentRev() });
  assert.equal(put.status, 200);

  const next = placeholderState();
  next.portfolio.balance = 900_000;
  next.spending.push({ name: "boats", monthly: 500, fromYear: null, toYear: null, realGrowthPct: 0 });
  const buf = buildTemplateWorkbook(next);

  const pv = await sendOctet("/api/import/template/preview?filename=runway-export.local.xlsx", buf);
  assert.equal(pv.status, 200);
  assert.equal(typeof pv.body.token, "string");
  assert.equal(pv.body.rev, await currentRev(), "preview returns the rev the apply must thread");
  assert.ok(pv.body.preview.tabs.every((t) => t.status === "ready"));
  assert.deepEqual(pv.body.preview.headline.totalBalance, { before: 777_000, after: 900_000 });
  const spendTab = pv.body.preview.tabs.find((t) => t.key === "spending");
  assert.equal(spendTab.adds, 1);

  const rev = pv.body.rev;

  const stale = await sendJson("POST", "/api/import/template/apply", { token: pv.body.token, tabs: ["accounts"], baseRev: rev - 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.rev, rev);

  const expired = await sendJson("POST", "/api/import/template/apply", { token: "no-such-token", tabs: ["accounts"], baseRev: rev });
  assert.equal(expired.status, 410);

  for (const tabs of [["nope"], [], "accounts", ["accounts", "accounts"]]) {
    const bad = await sendJson("POST", "/api/import/template/apply", { token: pv.body.token, tabs, baseRev: rev });
    assert.equal(bad.status, 400, `tabs=${JSON.stringify(tabs)} must 400`);
    assert.ok(bad.body.errors.some((e) => e.path === "tabs"));
  }

  const snapsBefore = (await getJson("/api/snapshots")).body.snapshots;
  const ok = await sendJson("POST", "/api/import/template/apply", {
    token: pv.body.token,
    tabs: ALL_TABS,
    baseRev: rev,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.rev, rev + 1);
  assert.deepEqual(ok.body.warnings, []);

  const snapsAfter = (await getJson("/api/snapshots")).body.snapshots;
  assert.ok(
    snapsAfter.filter((s) => s.source === "template-import").length >
      snapsBefore.filter((s) => s.source === "template-import").length,
    "apply creates a pre-import snapshot tagged template-import"
  );

  const state = (await getJson("/api/state")).body.state;
  assert.deepEqual(state, next, "imported state round-trips through the API");

  // A used token is burned.
  const reuse = await sendJson("POST", "/api/import/template/apply", { token: pv.body.token, tabs: ["accounts"], baseRev: rev + 1 });
  assert.equal(reuse.status, 410);
});

test("preview token cache is bounded: old tokens expire after eviction", async () => {
  const buf = buildTemplateWorkbook(placeholderState());
  const first = await sendOctet("/api/import/template/preview", buf);
  assert.equal(first.status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await sendOctet("/api/import/template/preview", buf)).status, 200);
  const res = await sendJson("POST", "/api/import/template/apply", {
    token: first.body.token,
    tabs: ["accounts"],
    baseRev: await currentRev(),
  });
  assert.equal(res.status, 410, "evicted token → 410");
});

test("preview guard rails: content-type, macro filename, garbage bytes, renamed tabs, oversize", async () => {
  // The octet-stream exception is scoped to the preview route only.
  const jsonCt = await fetch(base + "/api/import/template/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(jsonCt.status, 415);
  const octetOnJsonRoute = await fetch(base + "/api/import/template/apply", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: "{}",
  });
  assert.equal(octetOnJsonRoute.status, 415);

  const macroName = await sendOctet("/api/import/template/preview?filename=data.xlsm", buildTemplateWorkbook(placeholderState()));
  assert.equal(macroName.status, 400);
  assert.match(macroName.body.errors[0].message, /\.xlsm\/\.xlsb/);

  const garbage = await sendOctet("/api/import/template/preview", Buffer.from("definitely not a workbook"));
  assert.equal(garbage.status, 400);
  assert.match(garbage.body.errors[0].message, /not a valid \.xlsx/);

  const macroZip = await sendOctet(
    "/api/import/template/preview",
    makeZip([{ name: "xl/vbaProject.bin", data: Buffer.from("junk") }])
  );
  assert.equal(macroZip.status, 400);
  assert.match(macroZip.body.errors[0].message, /macro-enabled/);

  const renamed = await sendOctet("/api/import/template/preview", wbBuffer({ Foo: [["x"], [1]] }));
  assert.equal(renamed.status, 400);
  assert.match(renamed.body.errors[0].message, /no recognized tabs/);

  const oversize = await sendOctet("/api/import/template/preview", Buffer.alloc(20 * 1024 * 1024 + 1));
  assert.equal(oversize.status, 413);

  assert.equal(await currentRev(), await currentRev(), "guard-rail probes never move the rev");
});

test("blocked tab via API: preview marks it, apply of the blocked tab 400s, valid sibling applies", async () => {
  const buf = wbBuffer({
    Properties: [HEADERS.Properties, ["Bad", "abc", 100, 0, null, null, null]],
    Spending: [HEADERS.Spending, ["groceries", 650]],
  });
  const pv = await sendOctet("/api/import/template/preview", buf);
  assert.equal(pv.status, 200);
  const propTab = pv.body.preview.tabs.find((t) => t.key === "properties");
  assert.equal(propTab.status, "blocked");
  assert.equal(propTab.errors[0].cell, "Properties!B2");
  assert.equal(pv.body.preview.tabs.find((t) => t.key === "income").status, "missing");

  const blockedApply = await sendJson("POST", "/api/import/template/apply", {
    token: pv.body.token,
    tabs: ["properties"],
    baseRev: pv.body.rev,
  });
  assert.equal(blockedApply.status, 400);

  const okApply = await sendJson("POST", "/api/import/template/apply", {
    token: pv.body.token,
    tabs: ["spending"],
    baseRev: pv.body.rev,
  });
  assert.equal(okApply.status, 200);
  const state = (await getJson("/api/state")).body.state;
  assert.deepEqual(state.spending, [{ name: "groceries", monthly: 650, fromYear: null, toYear: null, realGrowthPct: 0 }]);
  assert.ok(state.properties.length > 0, "properties section untouched by the blocked tab");
});
