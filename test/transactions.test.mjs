// Transaction CSV import (U9): parse/mapping/sign/normalize/dedupe/derive/
// apply semantics on in-test CSV fixtures, plus the preview→apply API flow on
// a real ephemeral server with an injected clock (the derivation window's
// current-month exclusion is clock-driven).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createStore } from "../src/server/store.mjs";
import { createApi } from "../src/server/api.mjs";
import { defaultState } from "../src/model/schema.mjs";
import {
  applyDerived,
  CsvFileError,
  dedupeRows,
  deriveCategories,
  headerSignature,
  normalizeRows,
  parseCsv,
  suggestMapping,
  suggestSignConvention,
} from "../src/import/transactions.mjs";
import { clientCsvError, excludedCopy, fmtMonth, signDetectedCopy, windowCopy } from "../public/ui/imports.mjs";

const NOW = new Date("2026-07-15T10:00:00.000Z"); // current month = 2026-07

// ---------------------------------------------------------------------------
// fixtures (CSV strings, in-test)
// ---------------------------------------------------------------------------

// Card-style export: charges positive. Spans 2026-03 (earliest, partial) →
// 2026-07 (current, partial); the derivation window is Apr–Jun (3 months).
const CARD_CSV =
  [
    "Date,Amount,Description,Category",
    "2026-03-20,100.00,SAFEWAY #123,groceries", // earliest month → excluded from derivation
    "2026-04-05,120.00,SAFEWAY #123,groceries",
    "2026-04-18,$60,TRADER JOES,groceries", // $-prefixed amount
    "2026-05-10,90.00,SAFEWAY #123,groceries",
    "2026-06-02,30.00,TRADER JOES,groceries",
    "2026-05-15,45.00,NETFLIX,fun",
    "2026-04-10,80.00,CVS PHARMACY #1234,pharmacy", // healthcare → flagged
    "2026-05-20,200.00,HOME DEPOT #55,home repair", // property → flagged
    "2026-07-01,999.00,AMAZON,fun", // current month → excluded from derivation
  ].join("\n") + "\n";

// Hand-computed derivation over Apr–Jun (monthsCounted 3):
//   groceries 120+60+90+30 = 300 → 100.00/mo (3 active months)
//   home repair 200 → 66.67/mo (flagged)   pharmacy 80 → 26.67/mo (flagged)
//   fun 45 → 15.00/mo

const CARD_MAPPING = { date: "Date", amount: "Amount", description: "Description", category: "Category" };

// Bank-style export: spends negative, income positive, no category column,
// mixed date formats (MM/DD/YYYY and M/D/YY), comma+parens amounts.
const BANK_CSV =
  [
    "Posted Date,Debit,Payee",
    "04/05/2026,-52.10,COMCAST",
    "04/12/2026,-19.99,SPOTIFY",
    "5/20/26,-1200.00,CHASE EPAY MORTGAGE", // description-derived name → property-flagged
    '05/03/2026,"-1,250.50",LANDLORD LLC',
    "05/15/2026,(35.00),CVS PHARMACY #9",
    "5/28/26,2500.00,PAYROLL DIRECT DEP", // income → excluded after sign flip
  ].join("\n") + "\n";

function parseAndNormalize(csv, mapping, signConvention) {
  const { rows } = parseCsv(csv);
  return normalizeRows(rows, mapping, { signConvention });
}

// ---------------------------------------------------------------------------
// parseCsv degenerate states
// ---------------------------------------------------------------------------

test("parseCsv degenerate states are explicit errors: empty, header-only, headerless, blank headers", () => {
  assert.throws(() => parseCsv(""), { name: "CsvFileError", message: /empty/ });
  assert.throws(() => parseCsv("   \n \n"), { name: "CsvFileError", message: /empty/ });
  assert.throws(() => parseCsv("Date,Amount,Description\n"), { name: "CsvFileError", message: /no data rows/ });
  // A first line that parses as transaction data (headerless export) is
  // refused — the first row must never be silently swallowed as headers.
  assert.throws(() => parseCsv("2026-01-02,-45.00,STARBUCKS\n2026-01-03,-9.00,BAGEL\n"), {
    name: "CsvFileError",
    message: /looks like transaction data/,
  });
  assert.throws(() => parseCsv("1/2/26,-45.00,STARBUCKS\n1/3/26,-9.00,BAGEL\n"), { name: "CsvFileError" });
  assert.throws(() => parseCsv(",,\n1,2,3\n"), { name: "CsvFileError", message: /header/ });
  assert.ok(new CsvFileError("x") instanceof Error);
});

// ---------------------------------------------------------------------------
// mapping suggestion + saved mappings
// ---------------------------------------------------------------------------

test("suggestMapping: fuzzy header match by role, one header per role", () => {
  const { mapping, source } = suggestMapping(["Posted Date", "Debit", "Payee"], {});
  assert.equal(source, "suggested");
  assert.deepEqual(mapping, { date: "Posted Date", amount: "Debit", description: "Payee", category: null });

  const m2 = suggestMapping(["Transaction Date", "Amount", "Merchant Name", "Category", "Memo"], {}).mapping;
  assert.deepEqual(m2, { date: "Transaction Date", amount: "Amount", description: "Merchant Name", category: "Category" });

  // No date-like header → explicit null, never a guess.
  const m3 = suggestMapping(["When", "Value", "What"], {}).mapping;
  assert.deepEqual(m3, { date: null, amount: null, description: null, category: null });
});

test("saved mapping reused on exact header-signature match; stale mapping falls back explicitly", () => {
  const headers = ["Transaction Date", "Amount", "Merchant", "Category"];
  const sig = headerSignature(headers);
  assert.equal(headerSignature(["Category", "Merchant", "Amount", "Transaction Date"]), sig, "signature is order-independent");
  assert.notEqual(headerSignature(["Transaction Date", "Amount", "Merchant"]), sig, "removing a column changes the signature");

  const custom = { date: "Transaction Date", amount: "Amount", description: "Category", category: "Merchant" }; // deliberately non-fuzzy
  const saved = { [sig]: { mapping: custom } };
  const hit = suggestMapping(headers, saved);
  assert.equal(hit.source, "saved");
  assert.deepEqual(hit.mapping, custom, "saved mapping wins verbatim over the fuzzy suggestion");

  // Saved mapping referencing a column that no longer exists → explicit
  // stale-saved state, fuzzy fallback (never a silent half-match).
  const stale = { [sig]: { mapping: { date: "Transaction Date", amount: "Old Amount", description: "Merchant", category: null } } };
  const miss = suggestMapping(headers, stale);
  assert.equal(miss.source, "stale-saved");
  assert.deepEqual(miss.mapping, { date: "Transaction Date", amount: "Amount", description: "Merchant", category: "Category" });
});

// ---------------------------------------------------------------------------
// sign convention
// ---------------------------------------------------------------------------

test("sign suggestion: majority sign with the counts as the basis; both conventions normalize to positive spend", () => {
  const card = parseCsv(CARD_CSV);
  const cardSign = suggestSignConvention(card.rows, CARD_MAPPING);
  assert.deepEqual(cardSign, { convention: "positive-is-charge", negative: 0, positive: 9, total: 9 });

  const bank = parseCsv(BANK_CSV);
  const bankMapping = suggestMapping(bank.headers, {}).mapping;
  const bankSign = suggestSignConvention(bank.rows, bankMapping);
  // Parenthesized (35.00) is negative; only the payroll row is positive.
  assert.deepEqual(bankSign, { convention: "negative-is-spend", negative: 5, positive: 1, total: 6 });

  // positive-is-charge: positive raw amounts stored as positive spend.
  const cardNorm = parseAndNormalize(CARD_CSV, CARD_MAPPING, "positive-is-charge");
  assert.equal(cardNorm.rows.length, 9);
  assert.ok(cardNorm.rows.every((r) => r.amount > 0), "stored spend amounts are positive");
  assert.deepEqual(cardNorm.rows[0], { rowNumber: 2, date: "2026-03-20", amount: 100, description: "SAFEWAY #123", category: "groceries" });
  assert.equal(cardNorm.rows[2].amount, 60, "$-prefixed amount parsed");

  // negative-is-spend flips: -52.10 → 52.10 spend; +2500 payroll → refund/income.
  const bankNorm = parseAndNormalize(BANK_CSV, bankMapping, "negative-is-spend");
  assert.equal(bankNorm.rows.length, 5);
  assert.deepEqual(bankNorm.rows[0], { rowNumber: 2, date: "2026-04-05", amount: 52.1, description: "COMCAST", category: "uncategorized" });
  assert.equal(bankNorm.rows[3].amount, 1250.5, "comma-thousands amount parsed");
  assert.equal(bankNorm.rows[4].amount, 35, "parenthesized negative = spend under negative-is-spend");
  assert.deepEqual(bankNorm.excluded.refunds, { count: 1, rowNumbers: [7] }, "payroll excluded as refund/income");

  // Wrong convention for a card file → EVERY row lands in refund/income —
  // counted and inspectable, never silently stored as negative spend.
  const flipped = parseAndNormalize(CARD_CSV, CARD_MAPPING, "negative-is-spend");
  assert.equal(flipped.rows.length, 0);
  assert.equal(flipped.excluded.refunds.count, 9);
});

// ---------------------------------------------------------------------------
// dates: formats, unparseable rows, DD/MM ambiguity
// ---------------------------------------------------------------------------

test("unparseable dates and amounts are excluded WITH row numbers, never guessed", () => {
  const csv =
    [
      "Date,Amount,Description",
      "2026-05-01,10.00,OK ISO",
      "05/02/2026,11.00,OK MMDDYYYY",
      "5/3/26,12.00,OK MDYY",
      "notadate,13.00,BAD DATE",
      "2026-13-40,14.00,BAD ISO",
      "2026-05-06,not-a-number,BAD AMOUNT",
    ].join("\n") + "\n";
  const norm = parseAndNormalize(csv, { date: "Date", amount: "Amount", description: "Description", category: null }, "positive-is-charge");
  assert.deepEqual(norm.rows.map((r) => r.date), ["2026-05-01", "2026-05-02", "2026-05-03"]);
  assert.deepEqual(norm.excluded.badDates, { count: 2, rowNumbers: [5, 6] });
  assert.deepEqual(norm.excluded.badAmounts, { count: 1, rowNumbers: [7] });
  assert.equal(norm.ambiguity, undefined, "no ambiguity warning without day-first evidence");
});

test("more than 12 day-first-only rows → ambiguity warning naming the count", () => {
  // 13 rows valid ONLY as DD/MM (day 13–25 in the first position), plus two
  // unambiguous rows — the 13 flips exceed the >12 threshold.
  const rows = ["Date,Amount,Description"];
  for (let d = 13; d <= 25; d++) rows.push(`${d}/01/2026,5.00,DAY FIRST ${d}`);
  rows.push("01/05/2026,6.00,FINE", "02/06/2026,7.00,ALSO FINE");
  const norm = parseAndNormalize(rows.join("\n") + "\n", { date: "Date", amount: "Amount", description: "Description", category: null }, "positive-is-charge");
  assert.equal(norm.rows.length, 2);
  assert.equal(norm.excluded.badDates.count, 13);
  assert.ok(norm.ambiguity, "ambiguity warning surfaced");
  assert.equal(norm.ambiguity.count, 13);
  assert.match(norm.ambiguity.message, /13 rows.*day-first/i);

  // 12 or fewer day-first rows: excluded as bad dates but no ambiguity alarm.
  const few = ["Date,Amount,Description"];
  for (let d = 13; d <= 24; d++) few.push(`${d}/01/2026,5.00,DAY FIRST ${d}`);
  const fewNorm = parseAndNormalize(few.join("\n") + "\n", { date: "Date", amount: "Amount", description: "Description", category: null }, "positive-is-charge");
  assert.equal(fewNorm.excluded.badDates.count, 12);
  assert.equal(fewNorm.ambiguity, undefined);
});

// ---------------------------------------------------------------------------
// dedupe
// ---------------------------------------------------------------------------

test("two identical same-day rows in ONE file both survive; re-import dedupes both", () => {
  const csv = "Date,Amount,Description\n2026-05-01,4.50,COFFEE\n2026-05-01,4.50,COFFEE\n";
  const mapping = { date: "Date", amount: "Amount", description: "Description", category: null };
  const norm = parseAndNormalize(csv, mapping, "positive-is-charge");

  const first = dedupeRows(norm.rows, []);
  assert.equal(first.fresh.length, 2, "genuine same-day duplicate charges BOTH survive");
  assert.equal(first.dupes.count, 0);

  const again = dedupeRows(norm.rows, first.fresh);
  assert.equal(again.fresh.length, 0, "re-importing the same file stores nothing");
  assert.deepEqual(again.dupes, { count: 2, rowNumbers: [2, 3] });
});

test("10 rows duplicated across two imports → excluded once each, reported", () => {
  const mapping = { date: "Date", amount: "Amount", description: "Description", category: null };
  const lines = Array.from({ length: 12 }, (_, i) => `2026-05-${String(i + 1).padStart(2, "0")},${i + 1}.00,SHOP ${i}`);
  const fileA = "Date,Amount,Description\n" + lines.join("\n") + "\n";
  const stored = dedupeRows(parseAndNormalize(fileA, mapping, "positive-is-charge").rows, []).fresh;
  assert.equal(stored.length, 12);

  // File B overlaps A on 10 rows and adds 5 new ones.
  const fileB =
    "Date,Amount,Description\n" +
    lines.slice(0, 10).join("\n") +
    "\n" +
    Array.from({ length: 5 }, (_, i) => `2026-06-0${i + 1},${i + 20}.00,NEW ${i}`).join("\n") +
    "\n";
  const { fresh, dupes } = dedupeRows(parseAndNormalize(fileB, mapping, "positive-is-charge").rows, stored);
  assert.equal(dupes.count, 10);
  assert.equal(fresh.length, 5);
  assert.deepEqual(dupes.rowNumbers, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

// ---------------------------------------------------------------------------
// derivation: complete-months window, averages, flags
// ---------------------------------------------------------------------------

test("derivation excludes BOTH the current month and the earliest month; averages match hand-computed values", () => {
  const norm = parseAndNormalize(CARD_CSV, CARD_MAPPING, "positive-is-charge");
  const derived = deriveCategories(dedupeRows(norm.rows, []).fresh, { now: NOW });

  assert.deepEqual(derived.window, { from: "2026-04", to: "2026-06", monthsCounted: 3 });
  assert.deepEqual(derived.excludedMonths, ["2026-07", "2026-03"], "partial current + earliest months named");

  assert.deepEqual(derived.categories, [
    { name: "groceries", monthly: 100, months: 3, total: 300 },
    { name: "home repair", monthly: 66.67, months: 1, total: 200, flagged: true },
    { name: "pharmacy", monthly: 26.67, months: 1, total: 80, flagged: true },
    { name: "fun", monthly: 15, months: 1, total: 45 },
  ]);
});

test("derivation degenerate: fewer than 3 distinct months → no window, no categories", () => {
  const csv = "Date,Amount,Description,Category\n2026-06-10,50.00,X,stuff\n2026-07-02,60.00,Y,stuff\n";
  const norm = parseAndNormalize(csv, CARD_MAPPING, "positive-is-charge");
  const derived = deriveCategories(norm.rows, { now: NOW });
  assert.deepEqual(derived.categories, []);
  assert.equal(derived.window, null);
  assert.deepEqual(derived.excludedMonths, ["2026-07", "2026-06"]);
});

test("modeled-elsewhere flags apply case-insensitively to categories AND description-derived names", () => {
  // No category column: names derive from descriptions (digits/# stripped),
  // so merchant patterns like CVS / Home Depot / mortgage are still caught.
  const bankMapping = { date: "Posted Date", amount: "Debit", description: "Payee", category: null };
  const norm = parseAndNormalize(BANK_CSV, bankMapping, "negative-is-spend");
  const derived = deriveCategories(norm.rows, { now: NOW });
  const byName = new Map(derived.categories.map((c) => [c.name, c]));

  // April is the earliest (excluded) month, so the window is May only.
  assert.deepEqual(derived.window, { from: "2026-05", to: "2026-05", monthsCounted: 1 });
  assert.equal(byName.get("CVS PHARMACY").flagged, true, "description-derived healthcare name flagged");
  assert.equal(byName.get("CHASE EPAY MORTGAGE").flagged, true, "description-derived property name flagged");
  assert.equal(byName.get("LANDLORD LLC").flagged, undefined);

  // Case-insensitive on explicit category names too. (The 2026-04 row only
  // pads the window: earliest month is excluded, so May+June are counted.)
  const csv =
    "Date,Amount,Description,Category\n2026-04-01,1,W,setup\n2026-05-01,10,X,DENTAL Care\n2026-05-02,11,Y,Plumbing Fix\n2026-06-02,11,Z,dining\n";
  const cats = deriveCategories(parseAndNormalize(csv, CARD_MAPPING, "positive-is-charge").rows, { now: NOW }).categories;
  const flags = Object.fromEntries(cats.map((c) => [c.name, c.flagged ?? false]));
  assert.deepEqual(flags, { "DENTAL Care": true, "Plumbing Fix": true, dining: false });
});

// ---------------------------------------------------------------------------
// applyDerived modes
// ---------------------------------------------------------------------------

test("each apply mode produces the expected spending array on a shared fixture", () => {
  const state = defaultState();
  state.spending = [
    { name: "Groceries", monthly: 999 },
    { name: "rent", monthly: 2000 },
  ];
  const cats = [
    { name: "groceries", monthly: 100 },
    { name: "fun", monthly: 15 },
  ];

  const replaced = applyDerived(state, cats, "replace-all");
  assert.deepEqual(replaced.spending, [
    { name: "groceries", monthly: 100 },
    { name: "fun", monthly: 15 },
  ]);

  const updated = applyDerived(state, cats, "update-matching-names");
  assert.deepEqual(updated.spending, [
    { name: "Groceries", monthly: 100 }, // matched case-insensitively, keeps its own name
    { name: "rent", monthly: 2000 },
  ]);

  const added = applyDerived(state, cats, "add-new-only");
  assert.deepEqual(added.spending, [
    { name: "Groceries", monthly: 999 },
    { name: "rent", monthly: 2000 },
    { name: "fun", monthly: 15 },
  ]);

  assert.deepEqual(state.spending, [
    { name: "Groceries", monthly: 999 },
    { name: "rent", monthly: 2000 },
  ], "applyDerived is pure — the input state is untouched");
  assert.throws(() => applyDerived(state, cats, "nuke"), /unknown apply mode/);
});

// ---------------------------------------------------------------------------
// UI copy helpers (pure, imported under plain Node)
// ---------------------------------------------------------------------------

test("UI copy helpers: window line, sign-detection basis, client CSV checks, excluded report", () => {
  assert.equal(fmtMonth("2026-07"), "Jul 2026");
  assert.equal(
    windowCopy({ window: { from: "2025-09", to: "2026-06", monthsCounted: 10 }, excludedMonths: ["2026-07", "2025-08"] }),
    "Sep 2025 – Jun 2026, 10 complete months (excluded: partial Jul 2026, partial Aug 2025)"
  );
  assert.match(windowCopy({ window: null, excludedMonths: [] }), /Not enough complete months/);
  assert.equal(signDetectedCopy({ convention: "positive-is-charge", negative: 2, positive: 23, total: 25 }), "detected: charges are positive (23 of 25 rows)");
  assert.equal(signDetectedCopy({ convention: "negative-is-spend", negative: 30, positive: 1, total: 31 }), "detected: spends are negative (30 of 31 rows)");
  assert.equal(clientCsvError("statement.csv", 1000), null);
  assert.match(clientCsvError("statement.xlsx", 1000), /\.csv/);
  assert.match(clientCsvError("big.csv", 51 * 1024 * 1024), /too large/);
  assert.deepEqual(
    excludedCopy({ parsed: 20, storedNew: 14, dupes: 3, refunds: 1, badDates: { count: 2, rowNumbers: [5, 9] }, badAmounts: { count: 0, rowNumbers: [] } }),
    ["20 rows parsed", "14 new", "3 duplicates (already stored)", "1 refund/income row", "2 unparseable dates (rows 5, 9)"]
  );
});

// ---------------------------------------------------------------------------
// API integration: preview → apply on a real server, injected clock
// ---------------------------------------------------------------------------

let dir;
let store;
let server;
let base;
const CLOCK = { t: new Date(NOW) };
const STORE_OPTS = { now: () => CLOCK.t, _failAfter: /** @type {any} */ (null) };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "runway-txn-"));
  store = createStore(dir, STORE_OPTS);
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
  return { status: res.status, body: await res.json() };
}

async function sendJson(method, path, payload) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function sendCsv(path, text) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "text/csv" },
    body: text,
  });
  return { status: res.status, body: await res.json() };
}

async function currentRev() {
  return (await getJson("/health")).body.rev;
}

function txnFile() {
  return JSON.parse(readFileSync(join(dir, "transactions.json"), "utf8"));
}

test("preview → apply: rev threading, 409 stale, 410 bad token, 400 bad mode/categories, snapshot + files on disk", async () => {
  // Seed real data so the import has something to update (and snapshot).
  const seeded = defaultState();
  seeded.spending = [
    { name: "Groceries", monthly: 999 },
    { name: "rent", monthly: 2000 },
  ];
  const put = await sendJson("PUT", "/api/state", { state: seeded, baseRev: await currentRev() });
  assert.equal(put.status, 200);

  const pv = await sendCsv("/api/import/transactions/preview", CARD_CSV);
  assert.equal(pv.status, 200);
  assert.equal(typeof pv.body.token, "string");
  assert.equal(pv.body.rev, await currentRev(), "preview returns the rev the apply must thread");
  const p = pv.body.preview;
  assert.equal(p.mappingSource, "suggested");
  assert.deepEqual(p.mapping, CARD_MAPPING);
  assert.equal(p.signConvention.value, "positive-is-charge");
  assert.deepEqual(p.signConvention.suggestion, { convention: "positive-is-charge", negative: 0, positive: 9, total: 9 });
  assert.deepEqual(
    { parsed: p.counts.parsed, storedNew: p.counts.storedNew, dupes: p.counts.dupes, refunds: p.counts.refunds },
    { parsed: 9, storedNew: 9, dupes: 0, refunds: 0 }
  );
  assert.equal(p.sampleRows.length, 8, "first 8 parsed rows");
  assert.deepEqual(p.sampleRows[0], { row: 2, date: "2026-03-20", amount: 100, description: "SAFEWAY #123" });
  assert.deepEqual(p.derived.window, { from: "2026-04", to: "2026-06", monthsCounted: 3 });
  assert.equal(p.derived.categories.find((c) => c.name === "pharmacy").flagged, true);
  assert.equal(p.derived.categories.find((c) => c.name === "home repair").flagged, true);

  const rev = pv.body.rev;
  const token = pv.body.token;

  const stale = await sendJson("POST", "/api/import/transactions/apply", { token, mode: "replace-all", includeCategories: [], baseRev: rev - 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.rev, rev);

  const expired = await sendJson("POST", "/api/import/transactions/apply", { token: "nope", mode: "replace-all", includeCategories: [], baseRev: rev });
  assert.equal(expired.status, 410);

  const badMode = await sendJson("POST", "/api/import/transactions/apply", { token, mode: "sideways", includeCategories: [], baseRev: rev });
  assert.equal(badMode.status, 400);
  assert.ok(badMode.body.errors.some((e) => e.path === "mode"));

  const badCats = await sendJson("POST", "/api/import/transactions/apply", { token, mode: "replace-all", includeCategories: ["no-such-cat"], baseRev: rev });
  assert.equal(badCats.status, 400);
  assert.ok(badCats.body.errors.some((e) => e.path === "includeCategories"));

  // Untick honored: flagged categories stay excluded unless named.
  const ok = await sendJson("POST", "/api/import/transactions/apply", {
    token,
    mode: "update-matching-names",
    includeCategories: ["groceries", "fun"],
    baseRev: rev,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.rev, rev + 1);

  const state = (await getJson("/api/state")).body.state;
  assert.deepEqual(state.spending, [
    { name: "Groceries", monthly: 100 }, // updated from real behavior, name kept
    { name: "rent", monthly: 2000 }, // no derived match → untouched
  ]);

  // transactions.json: versioned envelope, all 9 normalized rows stored.
  const tf = txnFile();
  assert.equal(tf.schemaVersion, 1);
  assert.equal(tf.transactions.length, 9);
  assert.deepEqual(tf.transactions[0], { date: "2026-03-20", amount: 100, description: "SAFEWAY #123", category: "groceries" });

  // Pre-import snapshot with the txn-import source tag.
  const snaps = (await fetch(base + "/api/snapshots").then((r) => r.json())).snapshots;
  assert.ok(snaps.some((s) => s.source === "txn-import"), "pre-import snapshot tagged txn-import");

  // Mapping persisted by header signature.
  const mf = JSON.parse(readFileSync(join(dir, "mappings.json"), "utf8"));
  assert.equal(mf.schemaVersion, 1);
  const sig = headerSignature(["Date", "Amount", "Description", "Category"]);
  assert.deepEqual(mf.mappings[sig].mapping, CARD_MAPPING);

  // A used token is burned.
  const reuse = await sendJson("POST", "/api/import/transactions/apply", { token, mode: "replace-all", includeCategories: [], baseRev: rev + 1 });
  assert.equal(reuse.status, 410);
});

test("saved mapping reused on second preview; re-import dedupes; replace-all apply writes .bak and merges rows", async () => {
  // Same header set → saved mapping, mapping step skippable.
  const csv2 = "Date,Amount,Description,Category\n2026-06-20,10.00,ARCADE,fun\n2026-05-02,25.00,BOOKSTORE,books\n";
  const pv2 = await sendCsv("/api/import/transactions/preview", csv2);
  assert.equal(pv2.status, 200);
  assert.equal(pv2.body.preview.mappingSource, "saved");
  assert.deepEqual(pv2.body.preview.mapping, CARD_MAPPING);

  // Re-importing the ORIGINAL file dedupes everything against the store.
  const redo = await sendCsv("/api/import/transactions/preview", CARD_CSV);
  assert.equal(redo.status, 200);
  assert.equal(redo.body.preview.counts.storedNew, 0);
  assert.equal(redo.body.preview.counts.dupes, 9);
  assert.equal(redo.body.preview.sampleRows[0].excluded, "duplicate");

  // Apply csv2 replace-all: fun = (45+10)/3 = 18.33, books = 25/3 = 8.33.
  const apply2 = await sendJson("POST", "/api/import/transactions/apply", {
    token: pv2.body.token,
    mode: "replace-all",
    includeCategories: ["groceries", "fun", "books"],
    baseRev: pv2.body.rev,
  });
  assert.equal(apply2.status, 200);

  const state = (await getJson("/api/state")).body.state;
  assert.deepEqual(state.spending, [
    { name: "groceries", monthly: 100 },
    { name: "fun", monthly: 18.33 },
    { name: "books", monthly: 8.33 },
  ]);

  // Transactions always MERGE (apply mode shapes spending only): 9 + 2.
  assert.equal(txnFile().transactions.length, 11);

  // The full-file replace preserved the previous rows as a .bak.
  const baks = readdirSync(dir).filter((n) => /^transactions\.json\.bak-/.test(n));
  assert.ok(baks.length >= 1, "replace wrote transactions.json.bak-{ts}");
  const bak = JSON.parse(readFileSync(join(dir, baks.sort().pop()), "utf8"));
  assert.equal(bak.transactions.length, 9, ".bak carries the pre-import store");
});

test("write order pinned by failure injection: transactions.json commits BEFORE current.json; re-running the apply repairs", async () => {
  const csv3 = "Date,Amount,Description,Category\n2026-06-25,55.00,GAS STATION,auto\n";
  const pv = await sendCsv("/api/import/transactions/preview", csv3);
  assert.equal(pv.status, 200);
  const revBefore = pv.body.rev;
  const spendBefore = (await getJson("/api/state")).body.state.spending;

  STORE_OPTS._failAfter = "transactions-write";
  try {
    const crashed = await sendJson("POST", "/api/import/transactions/apply", {
      token: pv.body.token,
      mode: "add-new-only",
      includeCategories: ["auto"],
      baseRev: revBefore,
    });
    assert.equal(crashed.status, 500);
  } finally {
    STORE_OPTS._failAfter = null;
  }

  // Crash landed AFTER the transactions commit, BEFORE the state save:
  // rows are on disk, spending and rev are untouched.
  assert.equal(txnFile().transactions.length, 12, "transactions committed first");
  assert.equal(await currentRev(), revBefore, "rev untouched — save never ran");
  assert.deepEqual((await getJson("/api/state")).body.state.spending, spendBefore, "spending untouched");

  // Documented crash repair: derivation is re-runnable from stored rows —
  // the token survived the failure, so the same apply just runs again.
  const retry = await sendJson("POST", "/api/import/transactions/apply", {
    token: pv.body.token,
    mode: "add-new-only",
    includeCategories: ["auto"],
    baseRev: revBefore,
  });
  assert.equal(retry.status, 200);
  assert.equal(txnFile().transactions.length, 12, "idempotent rewrite — no duplicated rows");
  const spending = (await getJson("/api/state")).body.state.spending;
  assert.deepEqual(spending[spending.length - 1], { name: "auto", monthly: 18.33 }, "55/3 over the 3-month window");
});

test("incomplete mapping: no token, explicit missing roles; explicit query mapping + sign override completes the preview", async () => {
  const csv = "When,Value,What\n2026-05-01,-10.00,THING\n2026-06-01,-12.00,THING\n2026-04-01,-9.00,OTHER\n";
  const pv = await sendCsv("/api/import/transactions/preview", csv);
  assert.equal(pv.status, 200);
  assert.equal(pv.body.token, undefined, "no token while the mapping is incomplete");
  assert.deepEqual(pv.body.preview.missing, ["date", "amount", "description"]);

  const q = "?date=When&amount=Value&description=What&sign=negative-is-spend";
  const pv2 = await sendCsv(`/api/import/transactions/preview${q}`, csv);
  assert.equal(pv2.status, 200);
  assert.equal(typeof pv2.body.token, "string");
  assert.equal(pv2.body.preview.mappingSource, "explicit");
  assert.equal(pv2.body.preview.counts.storedNew, 3);
  assert.equal(pv2.body.preview.signConvention.value, "negative-is-spend");

  const badCol = await sendCsv("/api/import/transactions/preview?date=Nope&amount=Value&description=What", csv);
  assert.equal(badCol.status, 400);
  assert.match(badCol.body.errors[0].message, /does not exist/);
});

test("guard rails: content types are route-scoped; degenerate CSV bodies are explicit 400s; rev never moves", async () => {
  const revBefore = await currentRev();

  const jsonOnPreview = await fetch(base + "/api/import/transactions/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(jsonOnPreview.status, 415, "preview requires text/csv or octet-stream");

  const octet = await fetch(base + "/api/import/transactions/preview", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from(CARD_CSV),
  });
  assert.equal(octet.status, 200, "octet-stream also accepted on the preview route");

  const csvOnApply = await fetch(base + "/api/import/transactions/apply", {
    method: "POST",
    headers: { "Content-Type": "text/csv" },
    body: "{}",
  });
  assert.equal(csvOnApply.status, 415, "the CSV exception is scoped to the preview route");

  const empty = await sendCsv("/api/import/transactions/preview", "");
  assert.equal(empty.status, 400);
  assert.match(empty.body.errors[0].message, /empty/);

  const headerless = await sendCsv("/api/import/transactions/preview", "2026-01-02,-45.00,STARBUCKS\n");
  assert.equal(headerless.status, 400);
  assert.match(headerless.body.errors[0].message, /looks like transaction data/);

  const headerOnly = await sendCsv("/api/import/transactions/preview", "Date,Amount,Description\n");
  assert.equal(headerOnly.status, 400);
  assert.match(headerOnly.body.errors[0].message, /no data rows/);

  assert.equal(await currentRev(), revBefore, "guard-rail probes never move the rev");
});
