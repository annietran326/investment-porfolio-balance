// Transaction CSV import (U9). Pure functions — the server endpoints in
// api.mjs wire them to HTTP and the store. Bank/card CSV exports become
// normalized stored transactions, which become derived monthly spending
// categories the user reviews and applies to state.spending.
//
// Load-bearing semantics:
//   - NOTHING is guessed silently. Degenerate files (empty, headerless), bad
//     dates, bad amounts, refunds, and duplicates are all explicit: counted,
//     row-numbered where useful, and inspectable in the preview.
//   - Stored spend amounts are POSITIVE spend. The sign convention
//     ("negative-is-spend" for bank exports, "positive-is-charge" for card
//     exports) flips raw amounts on the way in; net-negative spend after
//     normalization is excluded as refund/income, never stored as negative.
//   - Dedupe key is (date, amount, description, occurrenceIndexWithinFile):
//     the nth identical triple in ONE file gets suffix n, so two genuine
//     same-day identical charges in one file BOTH survive, while re-importing
//     an overlapping export still dedupes against stored rows.
//     ACCEPTED MISS (documented): the same genuine duplicate pair split
//     across two DIFFERENT files (one charge per file) — the second file's
//     copy is occurrence 0 and the store already holds one, so it is wrongly
//     deduped. Rare, and the safe direction (never double-counts).
//   - Derivation uses complete months only: the current calendar month AND
//     the earliest month present are both excluded (both presumed partial).
//   - "Modeled elsewhere" flagging: categories whose names (from the file OR
//     derived from descriptions) match healthcare/property patterns are
//     default-FLAGGED for exclusion — the model carries healthcare + property
//     costs separately, and double-counting inflates required income. The
//     user can untick the flag in the UI.
import { createHash } from "node:crypto";
import Papa from "papaparse";
import { newSpendingCategory } from "../model/schema.mjs";

/** @typedef {import("../model/schema.mjs").RunwayState} RunwayState */

/**
 * @typedef {Record<string, string>} CsvRow raw papaparse row, keyed by header
 * @typedef {Object} ParsedCsv
 * @property {string[]} headers
 * @property {CsvRow[]} rows
 *
 * @typedef {"negative-is-spend"|"positive-is-charge"} SignConvention
 * @typedef {Object} SignSuggestion
 * @property {SignConvention} convention
 * @property {number} negative rows with a negative raw amount
 * @property {number} positive rows with a positive raw amount
 * @property {number} total    rows with any parseable non-zero amount
 *
 * @typedef {Object} Mapping
 * @property {string|null} date
 * @property {string|null} amount
 * @property {string|null} description
 * @property {string|null} category
 * @typedef {"saved"|"stale-saved"|"suggested"} MappingSource
 * @typedef {{mapping: Mapping, source: MappingSource, signature: string}} MappingSuggestion
 *
 * @typedef {Object} TxnRow a stored transaction
 * @property {string} date ISO YYYY-MM-DD
 * @property {number} amount positive = spend
 * @property {string} description
 * @property {string} category from the file, or "uncategorized"
 *
 * @typedef {TxnRow & {rowNumber: number, excluded?: string}} AnnotatedRow
 * @typedef {{count: number, rowNumbers: number[]}} ExcludedBucket
 * @typedef {Object} NormalizeResult
 * @property {(TxnRow & {rowNumber: number})[]} rows kept rows, file order
 * @property {AnnotatedRow[]} all every row annotated, file order (kept + excluded)
 * @property {{badDates: ExcludedBucket, badAmounts: ExcludedBucket, refunds: ExcludedBucket}} excluded
 * @property {{count: number, message: string}} [ambiguity]
 *
 * @typedef {Object} DerivedCategory
 * @property {string} name
 * @property {number} monthly average over the window's complete months
 * @property {number} months  distinct months with activity
 * @property {number} total
 * @property {boolean} [flagged] "modeled elsewhere" — default-excluded
 * @typedef {Object} Derived
 * @property {DerivedCategory[]} categories
 * @property {{from: string, to: string, monthsCounted: number}|null} window YYYY-MM bounds
 * @property {string[]} excludedMonths partial months present but excluded
 */

/** Every whole-file rejection: empty, headerless, no data rows. */
export class CsvFileError extends Error {
  /** @param {string} msg */
  constructor(msg) {
    super(msg);
    this.name = "CsvFileError";
  }
}

export const APPLY_MODES = /** @type {const} */ (["replace-all", "update-matching-names", "add-new-only"]);

// Categories the model already carries separately (health section, property
// costs) — matching names are default-flagged for exclusion from spending.
export const HEALTHCARE_RE = /pharmacy|medical|health|dental|cvs|walgreens|insurance/i;
export const PROPERTY_RE = /home depot|lowes|repair|plumb|hvac|property|mortgage/i;

// Row numbers throughout are 1-based FILE lines (the header is line 1, the
// first data row is line 2) so they match what the user sees in an editor.

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

/**
 * Parse CSV text (header row required). Degenerate states are EXPLICIT
 * errors, never guesses: an empty file, a missing/blank header row, a first
 * row that looks like transaction data, or a header with no data rows all
 * throw CsvFileError.
 * @param {string} text
 * @returns {ParsedCsv}
 */
export function parseCsv(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new CsvFileError("the file is empty — nothing to import");
  }
  const result = Papa.parse(text, { header: true, skipEmptyLines: "greedy" });
  const headers = (result.meta.fields ?? []).map((h) => String(h ?? "").trim());
  if (headers.length === 0 || headers.every((h) => h === "")) {
    throw new CsvFileError("no header row found — the first line must name the columns");
  }
  if (headers.some((h) => h === "")) {
    throw new CsvFileError("the header row has empty column names — every column needs a name");
  }
  // A header cell that parses as a date means the first line is DATA, not
  // headers (a headerless bank export) — refuse explicitly instead of
  // swallowing the first transaction as a header row.
  if (headers.some((h) => parseDate(h).iso !== null)) {
    throw new CsvFileError("the first row looks like transaction data, not column headers — add a header row");
  }
  const rows = /** @type {CsvRow[]} */ (result.data);
  if (rows.length === 0) {
    throw new CsvFileError("no data rows below the header — nothing to import");
  }
  return { headers, rows };
}

// ---------------------------------------------------------------------------
// column mapping
// ---------------------------------------------------------------------------

const ROLE_PATTERNS = /** @type {Record<"date"|"amount"|"description"|"category", RegExp>} */ ({
  date: /date|posted/i,
  amount: /amount|debit|credit/i,
  description: /description|payee|merchant|memo/i,
  category: /category/i,
});

/**
 * Signature for a header set: sorted, case-normalized headers, hashed. Saved
 * mappings are keyed by this, so the same export format is recognized
 * regardless of column ORDER; any added/removed/renamed column changes it.
 * @param {string[]} headers
 */
export function headerSignature(headers) {
  const sorted = headers.map((h) => h.trim().toLowerCase()).sort();
  return createHash("sha256").update(sorted.join("")).digest("hex").slice(0, 16);
}

/** Fuzzy header match, one header per role. @param {string[]} headers @returns {Mapping} */
function fuzzyMapping(headers) {
  const used = new Set();
  /** @type {Mapping} */
  const mapping = { date: null, amount: null, description: null, category: null };
  for (const role of /** @type {const} */ (["date", "amount", "description", "category"])) {
    const hit = headers.find((h) => !used.has(h) && ROLE_PATTERNS[role].test(h));
    if (hit !== undefined) {
      mapping[role] = hit;
      used.add(hit);
    }
  }
  return mapping;
}

/**
 * Suggest a column mapping. An exact header-signature match reuses the saved
 * mapping (the UI skips the mapping step). A signature-matched mapping whose
 * column names no longer exist in the file (e.g. mappings.json edited by
 * hand, or a column's casing changed) is an explicit "stale-saved" state that
 * falls back to the fuzzy suggestion — never a silent half-match.
 * @param {string[]} headers
 * @param {Record<string, {mapping?: Mapping}>} savedMappings keyed by signature
 * @returns {MappingSuggestion}
 */
export function suggestMapping(headers, savedMappings) {
  const signature = headerSignature(headers);
  const saved = savedMappings?.[signature];
  if (saved && saved.mapping && typeof saved.mapping === "object") {
    const m = saved.mapping;
    const required = [m.date, m.amount, m.description];
    const optional = m.category ? [m.category] : [];
    const ok =
      required.every((c) => typeof c === "string" && headers.includes(c)) &&
      optional.every((c) => headers.includes(/** @type {string} */ (c)));
    if (ok) {
      return {
        mapping: { date: m.date, amount: m.amount, description: m.description, category: m.category ?? null },
        source: "saved",
        signature,
      };
    }
    return { mapping: fuzzyMapping(headers), source: "stale-saved", signature };
  }
  return { mapping: fuzzyMapping(headers), source: "suggested", signature };
}

// ---------------------------------------------------------------------------
// cell parsers (dates + amounts)
// ---------------------------------------------------------------------------

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;
const SLASH_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;

/** @param {number} y @param {number} m 1-based */
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** @param {number} y @param {number} m @param {number} d */
function validYmd(y, m, d) {
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** @param {number} n */
function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Parse a date cell. Accepted formats: ISO (YYYY-MM-DD, optionally with a
 * time suffix), MM/DD/YYYY, M/D/YY (2-digit years are 20YY). Slash dates are
 * read MONTH-FIRST; `ddmmValid` reports whether the day-first reading would
 * have been valid instead — the ambiguity counter in normalizeRows uses it.
 * @param {unknown} raw
 * @returns {{iso: string|null, ddmmValid: boolean}}
 */
export function parseDate(raw) {
  const s = String(raw ?? "").trim();
  let m = ISO_RE.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    return validYmd(y, mo, d) ? { iso: `${m[1]}-${m[2]}-${m[3]}`, ddmmValid: false } : { iso: null, ddmmValid: false };
  }
  m = SLASH_RE.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const ddmm = validYmd(y, b, a);
    if (validYmd(y, a, b)) return { iso: `${y}-${pad2(a)}-${pad2(b)}`, ddmmValid: ddmm };
    return { iso: null, ddmmValid: ddmm };
  }
  return { iso: null, ddmmValid: false };
}

/**
 * Parse an amount cell: strip $ and commas, parentheses = negative, leading
 * +/- honored. Unparseable → null (the row is excluded with its row number),
 * NEVER coerced to 0.
 * @param {unknown} raw
 * @returns {number|null}
 */
export function parseAmount(raw) {
  let s = String(raw ?? "").trim();
  if (s === "") return null;
  // A real currency cell is short — bucket anything longer as a bad value
  // instead of feeding it to the regexes below.
  if (s.length > 64) return null;
  let neg = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) {
    neg = true;
    s = paren[1].trim();
  }
  s = s.replace(/\$/g, "").replace(/,/g, "").trim();
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return null;
  const v = Number(s);
  if (!Number.isFinite(v)) return null;
  return neg ? -v : v;
}

/**
 * Majority-sign heuristic over the raw amount column, returned WITH the
 * counts so the UI can show WHY ("detected: charges are positive (23 of 25
 * rows)"). Mostly-negative amounts read like a bank export (debits negative);
 * mostly-positive like a card export (charges positive). Ties lean
 * positive-is-charge.
 * @param {CsvRow[]} rows
 * @param {Mapping} mapping
 * @returns {SignSuggestion}
 */
export function suggestSignConvention(rows, mapping) {
  let negative = 0;
  let positive = 0;
  const col = mapping.amount;
  if (col !== null) {
    for (const r of rows) {
      const v = parseAmount(r[col]);
      if (v === null || v === 0) continue;
      if (v < 0) negative += 1;
      else positive += 1;
    }
  }
  return {
    convention: negative > positive ? "negative-is-spend" : "positive-is-charge",
    negative,
    positive,
    total: negative + positive,
  };
}

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

/**
 * Normalize raw CSV rows into transaction rows. Every exclusion is explicit
 * and bucketed: unparseable-date and unparseable-amount carry row numbers;
 * refund/income is any row whose spend is <= 0 AFTER sign normalization.
 * When more than 12 rows are invalid month-first but valid day-first, an
 * ambiguity warning names the count (the file likely uses DD/MM dates).
 * @param {CsvRow[]} rows
 * @param {Mapping} mapping date/amount/description required, category optional
 * @param {{signConvention: SignConvention}} opts
 * @returns {NormalizeResult}
 */
export function normalizeRows(rows, mapping, { signConvention }) {
  const dateCol = mapping.date;
  const amountCol = mapping.amount;
  const descCol = mapping.description;
  if (dateCol === null || amountCol === null || descCol === null) {
    throw new Error("normalizeRows requires a complete mapping (date, amount, description)");
  }
  /** @type {AnnotatedRow[]} */
  const all = [];
  /** @type {(TxnRow & {rowNumber: number})[]} */
  const kept = [];
  /** @type {number[]} */
  const badDates = [];
  /** @type {number[]} */
  const badAmounts = [];
  /** @type {number[]} */
  const refunds = [];
  let dayFirstOnly = 0;

  rows.forEach((r, i) => {
    const rowNumber = i + 2; // header is file line 1
    const description = String(r[descCol] ?? "").trim();
    const rawCat = mapping.category !== null ? String(r[mapping.category] ?? "").trim() : "";
    const category = rawCat || "uncategorized";
    const d = parseDate(r[dateCol]);
    if (d.iso === null) {
      if (d.ddmmValid) dayFirstOnly += 1;
      badDates.push(rowNumber);
      all.push({ rowNumber, date: String(r[dateCol] ?? "").trim(), amount: 0, description, category, excluded: "unparseable-date" });
      return;
    }
    const v = parseAmount(r[amountCol]);
    if (v === null) {
      badAmounts.push(rowNumber);
      all.push({ rowNumber, date: d.iso, amount: 0, description, category, excluded: "unparseable-amount" });
      return;
    }
    const spend = Math.round((signConvention === "negative-is-spend" ? -v : v) * 100) / 100;
    if (spend <= 0) {
      refunds.push(rowNumber);
      all.push({ rowNumber, date: d.iso, amount: spend, description, category, excluded: "refund-or-income" });
      return;
    }
    const row = { rowNumber, date: d.iso, amount: spend, description, category };
    kept.push(row);
    all.push(row);
  });

  /** @type {NormalizeResult} */
  const out = {
    rows: kept,
    all,
    excluded: {
      badDates: { count: badDates.length, rowNumbers: badDates },
      badAmounts: { count: badAmounts.length, rowNumbers: badAmounts },
      refunds: { count: refunds.length, rowNumbers: refunds },
    },
  };
  if (dayFirstOnly > 12) {
    out.ambiguity = {
      count: dayFirstOnly,
      message: `${dayFirstOnly} rows are only valid as day-first (DD/MM) dates — this file may use day/month order; those rows were excluded as unparseable`,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// dedupe
// ---------------------------------------------------------------------------

/** @param {{date: string, amount: number, description: string}} r */
function tripleKey(r) {
  return `${r.date}${r.amount}${String(r.description).trim().toLowerCase()}`;
}

/**
 * Dedupe incoming rows against the stored set. Key = (date, amount,
 * description, occurrenceIndexWithinFile): the nth identical triple in this
 * file survives iff the store holds fewer than n+1 copies of the triple.
 * See the module header for the documented accepted miss.
 * @param {(TxnRow & {rowNumber: number})[]} rows normalized kept rows, file order
 * @param {TxnRow[]} stored
 * @returns {{fresh: TxnRow[], dupes: ExcludedBucket}}
 */
export function dedupeRows(rows, stored) {
  /** @type {Map<string, number>} */
  const storedCount = new Map();
  for (const s of stored) {
    const k = tripleKey(s);
    storedCount.set(k, (storedCount.get(k) ?? 0) + 1);
  }
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {TxnRow[]} */
  const fresh = [];
  /** @type {number[]} */
  const dupeRowNumbers = [];
  for (const r of rows) {
    const k = tripleKey(r);
    const occ = seen.get(k) ?? 0;
    seen.set(k, occ + 1);
    if (occ < (storedCount.get(k) ?? 0)) {
      dupeRowNumbers.push(r.rowNumber);
    } else {
      fresh.push({ date: r.date, amount: r.amount, description: r.description, category: r.category });
    }
  }
  return { fresh, dupes: { count: dupeRowNumbers.length, rowNumbers: dupeRowNumbers } };
}

// ---------------------------------------------------------------------------
// derive monthly categories
// ---------------------------------------------------------------------------

/** @param {string} ym YYYY-MM */
function monthIndex(ym) {
  return Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
}

/**
 * Category name for grouping: the file category when present; otherwise a
 * description-derived merchant name (digits/#/* stripped, whitespace
 * collapsed) so "CVS PHARMACY #1234" and "CVS PHARMACY #5678" group — and so
 * the modeled-elsewhere patterns can see merchant names even without a
 * category column. Grouping itself is case-insensitive.
 * @param {TxnRow} r
 */
function categoryNameOf(r) {
  const c = String(r.category ?? "").trim();
  if (c && c.toLowerCase() !== "uncategorized") return c;
  const derived = String(r.description ?? "").replace(/[#*\d]+/g, " ").replace(/\s+/g, " ").trim();
  return derived || "uncategorized";
}

/**
 * Derive monthly spending categories from stored rows, complete months only:
 * both the CURRENT calendar month and the EARLIEST month present are excluded
 * (both presumed partial). The monthly average divides by the calendar span
 * of the window (a month with no transactions genuinely means no spend), not
 * just months with activity. Healthcare/property-pattern categories come back
 * flagged (default-excluded; the user can untick).
 * @param {TxnRow[]} storedRows
 * @param {{now: Date}} opts
 * @returns {Derived}
 */
export function deriveCategories(storedRows, { now }) {
  const currentMonth = now.toISOString().slice(0, 7);
  const monthsPresent = [...new Set(storedRows.map((r) => r.date.slice(0, 7)))].sort();
  /** @type {string[]} */
  const excludedMonths = [];
  if (monthsPresent.length) {
    const earliest = monthsPresent[0];
    if (monthsPresent.includes(currentMonth) && currentMonth !== earliest) excludedMonths.push(currentMonth);
    excludedMonths.push(earliest);
  }
  const earliest = monthsPresent[0] ?? "";
  const included = monthsPresent.filter((m) => m > earliest && m < currentMonth);
  if (included.length === 0) return { categories: [], window: null, excludedMonths };

  const from = included[0];
  const to = included[included.length - 1];
  const monthsCounted = monthIndex(to) - monthIndex(from) + 1;

  /** @type {Map<string, {name: string, total: number, months: Set<string>}>} */
  const groups = new Map();
  for (const r of storedRows) {
    const m = r.date.slice(0, 7);
    if (m === earliest || m >= currentMonth) continue;
    const name = categoryNameOf(r);
    const key = name.toLowerCase();
    let g = groups.get(key);
    if (!g) {
      g = { name, total: 0, months: new Set() };
      groups.set(key, g);
    }
    g.total = Math.round((g.total + r.amount) * 100) / 100;
    g.months.add(m);
  }

  const categories = [...groups.values()]
    .map((g) => {
      /** @type {DerivedCategory} */
      const cat = {
        name: g.name,
        monthly: Math.round((g.total / monthsCounted) * 100) / 100,
        months: g.months.size,
        total: g.total,
      };
      if (HEALTHCARE_RE.test(g.name) || PROPERTY_RE.test(g.name)) cat.flagged = true;
      return cat;
    })
    .sort((a, b) => b.monthly - a.monthly || (a.name < b.name ? -1 : 1));

  return { categories, window: { from, to, monthsCounted }, excludedMonths };
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

/**
 * Apply derived categories to state.spending — pure; returns a new state.
 *   replace-all            spending becomes exactly the given categories
 *   update-matching-names  existing rows keep their names; a case-insensitive
 *                          name match updates the monthly amount; nothing is
 *                          added or removed
 *   add-new-only           existing rows untouched; categories whose names
 *                          match nothing are appended
 * @param {RunwayState} state
 * @param {{name: string, monthly: number}[]} categories after the user's untick
 * @param {string} mode
 * @returns {RunwayState}
 */
// Only name + monthly are read; a DerivedCategory carries extra fields that the
// factory ignores. The result is always a valid v2 SpendingCategory array.
export function applyDerived(state, categories, mode) {
  const next = structuredClone(state);
  // Derived categories are v2 spending lines: perpetual (fromYear/toYear null)
  // and inflation-tracking (growthPct null) by default. The factory fills the
  // new fields so nothing is missed and the result validates as v2.
  const cats = categories.map((c) => newSpendingCategory({ name: c.name, monthly: c.monthly }));
  if (mode === "replace-all") {
    next.spending = cats;
    return next;
  }
  if (mode === "update-matching-names") {
    const byName = new Map(cats.map((c) => [c.name.trim().toLowerCase(), c]));
    next.spending = next.spending.map((s) => {
      const hit = byName.get(s.name.trim().toLowerCase());
      return hit ? { ...s, monthly: hit.monthly } : s;
    });
    return next;
  }
  if (mode === "add-new-only") {
    const existing = new Set(next.spending.map((s) => s.name.trim().toLowerCase()));
    next.spending = next.spending.concat(cats.filter((c) => !existing.has(c.name.trim().toLowerCase())));
    return next;
  }
  throw new Error(`unknown apply mode '${mode}'`);
}
