// XLSX template import/export (U8). Pure functions — the server endpoint in
// api.mjs wires them to HTTP. TEMPLATE_DEF (tabs/columns/units) lives in
// scripts/build-template.mjs so the parser and the generated template share
// one definition.
//
// Load-bearing semantics, mirrored from src/model/schema.mjs:
//   - EMPTY nullable cell (payoff/sale year, proceeds) → null ("keep forever"),
//     NEVER coerced to 0. A 0 sale year is a cell-addressed error.
//   - Per-tab replace: a present tab replaces its whole section; an absent tab
//     leaves that section untouched. A tab with any cell error is BLOCKED
//     individually; other valid tabs in the same file remain applicable.
//
// Security posture, enforced BEFORE xlsx.read ever sees the bytes:
//   - The upload is a ZIP. We scan the central directory ourselves and reject:
//     >200 entries, per-entry or summed declared uncompressed size >100MB,
//     unsupported compression methods, vbaProject.bin entries, and
//     macroEnabled content types. Every deflated entry is test-inflated with
//     zlib maxOutputLength pinned to its declared size, so a header that lies
//     about its uncompressed size throws instead of ballooning memory.
//   - Exported text cells are written as explicit strings and prefixed with a
//     guard apostrophe when they start with = + - @ TAB or CR (formula
//     injection). Import strips the guard so round-trips preserve the text.
import { inflateRawSync } from "node:zlib";
import * as XLSX from "xlsx";
import { TEMPLATE_DEF } from "../../scripts/build-template.mjs";
import { END_STATE_MODES } from "../model/schema.mjs";

/** @typedef {import("../model/schema.mjs").RunwayState} RunwayState */
/** @typedef {import("../../scripts/build-template.mjs").TabDef} TabDef */
/** @typedef {import("../../scripts/build-template.mjs").ColumnDef} ColumnDef */
/** @typedef {import("xlsx").CellObject} CellObject */

/**
 * @typedef {{cell: string, message: string}} CellIssue cell is "Sheet!A1"-style
 * @typedef {{rows: any[], errors: CellIssue[]}} ParsedTab
 * @typedef {Object} ParsedTemplate
 * @property {string[]} tabsFound   canonical tab keys, in TEMPLATE_DEF order
 * @property {string[]} tabsMissing
 * @property {Record<string, ParsedTab>} perTab keyed by canonical tab key
 *
 * @typedef {{before: number, after: number}} Delta
 * @typedef {Object} TabPreview
 * @property {string} key
 * @property {string} label
 * @property {"ready"|"blocked"|"missing"} status
 * @property {number} adds
 * @property {number} removes
 * @property {number} changes
 * @property {CellIssue[]} errors
 * @typedef {Object} TemplatePreview
 * @property {TabPreview[]} tabs in TEMPLATE_DEF order
 * @property {{totalBalance: Delta, monthlySpend: Delta}} headline
 */

export const MAX_ZIP_ENTRIES = 200;
export const MAX_UNCOMPRESSED_TOTAL = 100 * 1024 * 1024; // per entry AND summed
export const SHEET_ROWS = 10000;

/** Every pre-tab-level rejection: not a zip, bounds, macro content, unreadable. */
export class TemplateFileError extends Error {
  /** @param {string} msg */
  constructor(msg) {
    super(msg);
    this.name = "TemplateFileError";
  }
}

/** Macro-enabled workbook filenames are rejected outright. @param {string} name */
export function isRejectedFilename(name) {
  return /\.(xlsm|xlsb)$/i.test(name);
}

// ---------------------------------------------------------------------------
// formula-injection guard (export adds, import strips — exact involution)
// ---------------------------------------------------------------------------

const DANGEROUS_LEAD = /^'*[=+\-@\t\r]/;

/** @param {string} s */
export function guardText(s) {
  return DANGEROUS_LEAD.test(s) ? "'" + s : s;
}

/** @param {string} s */
export function unguardText(s) {
  return s.startsWith("'") && DANGEROUS_LEAD.test(s.slice(1)) ? s.slice(1) : s;
}

// ---------------------------------------------------------------------------
// ZIP bounds check — runs on the raw bytes BEFORE xlsx.read
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** @param {Buffer} buf @returns {number} EOCD offset, or -1 */
function findEocd(buf) {
  const floor = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Scan the zip's central directory and test-inflate every entry under a hard
 * output cap. Throws TemplateFileError on any bounds or macro violation.
 * @param {Buffer} buf
 */
function scanZip(buf) {
  if (buf.length < 22) throw new TemplateFileError("not a valid .xlsx file (too small to be a zip)");
  const eocd = findEocd(buf);
  if (eocd < 0) throw new TemplateFileError("not a valid .xlsx file (no zip directory found)");
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_ZIP_ENTRIES) {
    throw new TemplateFileError(`zip has too many entries (${count} > ${MAX_ZIP_ENTRIES})`);
  }
  const cdOffset = buf.readUInt32LE(eocd + 16);

  /** @type {{name: string, method: number, compSize: number, uncompSize: number, localOffset: number}[]} */
  const entries = [];
  let off = cdOffset;
  let declaredTotal = 0;
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CDIR_SIG) {
      throw new TemplateFileError("not a valid .xlsx file (corrupt zip directory)");
    }
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    if (off + 46 + nameLen > buf.length) throw new TemplateFileError("not a valid .xlsx file (corrupt zip directory)");
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);

    if (/vbaProject\.bin/i.test(name)) {
      throw new TemplateFileError("macro-enabled workbook rejected (vbaProject.bin present)");
    }
    if (uncompSize > MAX_UNCOMPRESSED_TOTAL) {
      throw new TemplateFileError(`zip entry "${name}" declares an uncompressed size over the 100MB cap`);
    }
    declaredTotal += uncompSize;
    if (declaredTotal > MAX_UNCOMPRESSED_TOTAL) {
      throw new TemplateFileError("zip declares more than 100MB of uncompressed content in total");
    }
    if (method !== 0 && method !== 8) {
      throw new TemplateFileError(`zip entry "${name}" uses an unsupported compression method`);
    }
    entries.push({ name, method, compSize, uncompSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }

  // Test-inflate every entry, output-capped at its DECLARED size: a header
  // that lies (declares small, inflates big) throws here instead of OOMing
  // inside xlsx.read.
  for (const e of entries) {
    if (e.localOffset + 30 > buf.length || buf.readUInt32LE(e.localOffset) !== LOCAL_SIG) {
      throw new TemplateFileError("not a valid .xlsx file (corrupt local zip header)");
    }
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const dataStart = e.localOffset + 30 + nameLen + extraLen;
    if (dataStart + e.compSize > buf.length) {
      throw new TemplateFileError("not a valid .xlsx file (zip entry data out of bounds)");
    }
    const data = buf.subarray(dataStart, dataStart + e.compSize);
    /** @type {Buffer} */
    let content;
    if (e.method === 0) {
      if (data.length !== e.uncompSize) {
        throw new TemplateFileError(`zip entry "${e.name}" lies about its size`);
      }
      content = data;
    } else {
      try {
        content = inflateRawSync(data, {
          maxOutputLength: Math.min(Math.max(e.uncompSize, 1), MAX_UNCOMPRESSED_TOTAL),
        });
      } catch {
        throw new TemplateFileError(`zip entry "${e.name}" is corrupt or lies about its uncompressed size`);
      }
      if (content.length > e.uncompSize) {
        throw new TemplateFileError(`zip entry "${e.name}" lies about its uncompressed size`);
      }
    }
    // Real macro workbooks declare a macroEnabled OVERRIDE for a part (e.g.
    // /xl/workbook.xml in an .xlsm). Note: a <Default Extension="bin" …> line
    // alone is NOT a macro signal — SheetJS emits one in every macro-free file.
    if (
      /(^|\/)\[Content_Types\]\.xml$/i.test(e.name) &&
      /<Override[^>]*macroEnabled/i.test(content.toString("utf8"))
    ) {
      throw new TemplateFileError("macro-enabled workbook rejected (macroEnabled content type)");
    }
  }
}

// ---------------------------------------------------------------------------
// cell readers
// ---------------------------------------------------------------------------

/** @param {CellObject|null|undefined} cell */
function isEmptyCell(cell) {
  if (!cell || cell.t === "z" || cell.v === undefined || cell.v === null) return true;
  if (cell.t === "s" && String(cell.v).trim() === "") return true;
  return false;
}

/**
 * Text cell → trimmed string, with the export guard apostrophe stripped.
 * @param {CellObject|null|undefined} cell
 * @returns {{value?: string, error?: string}}
 */
function readText(cell) {
  if (isEmptyCell(cell)) return { value: "" };
  const c = /** @type {CellObject} */ (cell);
  if (c.t === "s") return { value: unguardText(String(c.v)).trim() };
  if (c.t === "n") return { value: String(c.v) };
  return { error: "expected text" };
}

/**
 * Numeric cell coercion (documented + tested):
 *   "$1,200" / "1,200" → 1200; "25%" → 25 (percent fields are plain numbers
 *   meaning percent); an Excel percent-FORMATTED numeric cell (0.25 shown as
 *   25%) → 25; EMPTY nullable cell → null, NEVER 0; text → error.
 * @param {CellObject|null|undefined} cell
 * @param {boolean} nullable
 * @returns {{value?: number|null, error?: string}}
 */
function readNumber(cell, nullable) {
  if (isEmptyCell(cell)) {
    return nullable ? { value: null } : { error: "expected a number, cell is empty" };
  }
  const c = /** @type {CellObject} */ (cell);
  if (c.t === "n") {
    const v = Number(c.v);
    if (!Number.isFinite(v)) return { error: "expected a finite number" };
    // Excel percent format stores 25% as 0.25 — surface the number the user saw.
    if (typeof c.w === "string" && /%\s*$/.test(c.w)) return { value: Math.round(v * 100 * 1e10) / 1e10 };
    return { value: v };
  }
  if (c.t === "s") {
    const raw = unguardText(String(c.v)).trim();
    let t = raw;
    if (t.endsWith("%")) t = t.slice(0, -1);
    t = t.replace(/\$/g, "").replace(/,/g, "").trim();
    if (t === "" || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) {
      return { error: `expected a number, got '${raw}'` };
    }
    return { value: Number(t) };
  }
  if (c.t === "b") return { error: `expected a number, got ${c.v ? "TRUE" : "FALSE"}` };
  return { error: "expected a number" };
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

/** @param {string} s */
function normName(s) {
  return s.trim().toLowerCase();
}

/** @param {string} sheetName @param {number} r 0-based @param {number} c 0-based */
function cellAddr(sheetName, r, c) {
  return `${sheetName}!${XLSX.utils.encode_cell({ r, c })}`;
}

/**
 * Dense-mode rows for a sheet ("!data"), tolerating sparse holes.
 * @param {import("xlsx").WorkSheet} sheet
 * @returns {(CellObject|null|undefined)[][]}
 */
function denseRows(sheet) {
  return /** @type {any} */ (sheet)["!data"] ?? [];
}

/** @param {(CellObject|null|undefined)[]} rowCells @param {number[]} colIndexes */
function rowIsEmpty(rowCells, colIndexes) {
  return colIndexes.every((c) => c < 0 || isEmptyCell(rowCells[c]));
}

/**
 * Match TEMPLATE_DEF columns to the sheet's header row (row 1). Reordered
 * columns are fine; a missing required column blocks the tab.
 * @param {TabDef} def
 * @param {(CellObject|null|undefined)[]} headerCells
 * @param {CellIssue[]} errors
 * @returns {number[]} per-def-column sheet column index (-1 for absent optional)
 */
function matchColumns(def, headerCells, errors) {
  const found = headerCells.map((cell) => {
    if (isEmptyCell(cell)) return "";
    const { value } = readText(cell);
    return normName(value ?? "");
  });
  return def.columns.map((col) => {
    const idx = found.indexOf(normName(col.header));
    if (idx < 0 && !col.optional) {
      errors.push({ cell: `${def.name}!A1`, message: `missing column "${col.header}" in row 1` });
    }
    return idx;
  });
}

/**
 * @param {TabDef} def
 * @param {import("xlsx").WorkSheet} sheet
 * @returns {ParsedTab}
 */
function parseListTab(def, sheet) {
  /** @type {CellIssue[]} */
  const errors = [];
  /** @type {any[]} */
  const rows = [];
  const data = denseRows(sheet);
  const cols = matchColumns(def, data[0] ?? [], errors);
  if (errors.length) return { rows, errors };

  for (let r = 1; r < data.length; r++) {
    const rowCells = data[r] ?? [];
    if (rowIsEmpty(rowCells, cols)) continue;
    /** @type {Record<string, unknown>} */
    const row = {};
    def.columns.forEach((col, i) => {
      const c = cols[i];
      const cell = c < 0 ? undefined : rowCells[c];
      if (col.type === "text") {
        const { value, error } = readText(cell);
        if (error !== undefined) errors.push({ cell: cellAddr(def.name, r, c), message: error });
        else if (value === "") errors.push({ cell: cellAddr(def.name, r, c), message: "name required" });
        else row[col.field] = value;
        return;
      }
      const { value, error } = readNumber(cell, col.nullable === true);
      if (error !== undefined) {
        errors.push({ cell: cellAddr(def.name, r, c), message: error });
        return;
      }
      if (col.zeroError && value === 0) {
        errors.push({ cell: cellAddr(def.name, r, c), message: col.zeroError });
        return;
      }
      row[col.field] = value;
    });
    if (def.key === "income" && typeof row.fromYear === "number" && typeof row.toYear === "number" && row.toYear < row.fromYear) {
      errors.push({
        cell: cellAddr(def.name, r, cols[3]),
        message: `to-year ${row.toYear} is before from-year ${row.fromYear}`,
      });
    }
    rows.push(row);
  }
  return { rows, errors };
}

/**
 * Accounts is the single portfolio bucket — exactly one data row.
 * @param {TabDef} def
 * @param {import("xlsx").WorkSheet} sheet
 * @returns {ParsedTab}
 */
function parseSingleTab(def, sheet) {
  const parsed = parseListTab(def, sheet);
  if (parsed.errors.length) return parsed;
  if (parsed.rows.length === 0) {
    parsed.errors.push({ cell: `${def.name}!A2`, message: "enter the portfolio balance in row 2" });
  } else if (parsed.rows.length > 1) {
    parsed.errors.push({ cell: `${def.name}!A3`, message: "only one portfolio row is supported (single bucket)" });
  }
  return parsed;
}

/** @returns {TabDef} */
function assumptionsDef() {
  const def = TEMPLATE_DEF.tabs.find((t) => t.key === "assumptions");
  if (!def) throw new Error("TEMPLATE_DEF has no assumptions tab");
  return def;
}

/**
 * @param {TabDef} def
 * @param {import("xlsx").WorkSheet} sheet
 * @returns {ParsedTab} rows are {key, value} pairs
 */
function parseSettingsTab(def, sheet) {
  /** @type {CellIssue[]} */
  const errors = [];
  /** @type {{key: string, value: number|string}[]} */
  const rows = [];
  const data = denseRows(sheet);
  const cols = matchColumns(def, data[0] ?? [], errors);
  if (errors.length) return { rows, errors };
  const [keyCol, valueCol] = cols;
  const settings = def.settings ?? [];
  const seen = new Set();

  for (let r = 1; r < data.length; r++) {
    const rowCells = data[r] ?? [];
    const keyCell = rowCells[keyCol];
    if (isEmptyCell(keyCell)) continue;
    const key = (readText(keyCell).value ?? "").trim();
    if (key === "" || key.startsWith("#")) continue; // comment / note row
    const setting = settings.find((s) => s.key === key);
    if (!setting) {
      errors.push({ cell: cellAddr(def.name, r, keyCol), message: `unknown setting '${key}'` });
      continue;
    }
    if (seen.has(key)) {
      errors.push({ cell: cellAddr(def.name, r, keyCol), message: `duplicate setting '${key}'` });
      continue;
    }
    seen.add(key);
    const valueCell = rowCells[valueCol];
    if (setting.type === "mode") {
      const { value, error } = readText(valueCell);
      const mode = (value ?? "").toLowerCase();
      if (error !== undefined || !/** @type {string[]} */ (END_STATE_MODES).includes(mode)) {
        errors.push({
          cell: cellAddr(def.name, r, valueCol),
          message: `must be one of ${END_STATE_MODES.join(", ")}`,
        });
        continue;
      }
      rows.push({ key, value: mode });
      continue;
    }
    const { value, error } = readNumber(valueCell, false);
    if (error !== undefined || typeof value !== "number") {
      errors.push({ cell: cellAddr(def.name, r, valueCol), message: error ?? "expected a number" });
      continue;
    }
    rows.push({ key, value });
  }
  return { rows, errors };
}

/**
 * Bounds-check, then parse the workbook against TEMPLATE_DEF. Throws
 * TemplateFileError for anything pre-tab-level (bad zip, bounds, macro,
 * unreadable workbook); tab/cell problems come back as per-tab errors.
 * @param {Buffer} buffer raw .xlsx bytes
 * @returns {ParsedTemplate}
 */
export function parseTemplate(buffer) {
  scanZip(buffer); // (1) DoS + macro defense BEFORE any xlsx parsing

  /** @type {import("xlsx").WorkBook} */
  let wb;
  try {
    wb = XLSX.read(buffer, { type: "buffer", dense: true, sheetRows: SHEET_ROWS });
  } catch (e) {
    throw new TemplateFileError(`could not read workbook: ${e instanceof Error ? e.message : String(e)}`);
  }

  /** @type {Map<string, string>} normalized sheet name → actual */
  const byName = new Map(wb.SheetNames.map((n) => [normName(n), n]));

  /** @type {string[]} */
  const tabsFound = [];
  /** @type {string[]} */
  const tabsMissing = [];
  /** @type {Record<string, ParsedTab>} */
  const perTab = {};

  for (const def of TEMPLATE_DEF.tabs) {
    const actual = byName.get(normName(def.name));
    if (actual === undefined) {
      tabsMissing.push(def.key);
      continue;
    }
    tabsFound.push(def.key);
    const sheet = wb.Sheets[actual];
    /** @type {ParsedTab} */
    let parsed;
    if (def.kind === "single") parsed = parseSingleTab(def, sheet);
    else if (def.kind === "settings") parsed = parseSettingsTab(def, sheet);
    else parsed = parseListTab(def, sheet);

    // sheetRows truncation guard: refuse to silently ignore rows we never read.
    const fullref = /** @type {any} */ (sheet)["!fullref"];
    if (typeof fullref === "string" && XLSX.utils.decode_range(fullref).e.r + 1 > SHEET_ROWS) {
      parsed.errors.push({ cell: `${def.name}!A1`, message: `sheet has more than ${SHEET_ROWS} rows` });
    }
    perTab[def.key] = parsed;
  }

  return { tabsFound, tabsMissing, perTab };
}

/** Found tabs with zero errors — the only tabs applyTabs will accept. @param {ParsedTemplate} parsed */
export function applicableTabs(parsed) {
  return parsed.tabsFound.filter((k) => parsed.perTab[k].errors.length === 0);
}

// ---------------------------------------------------------------------------
// assumptions path mapping
// ---------------------------------------------------------------------------

/** @type {Record<string, string[]>} keys whose sheet name differs from the state path */
const ASSUMPTION_ALIASES = {
  "endState.bequest": ["endState", "amounts", "bequest"],
  "endState.floor": ["endState", "amounts", "floor"],
};

/** @param {string} key */
function assumptionSegments(key) {
  return ASSUMPTION_ALIASES[key] ?? key.split(".");
}

/** @param {RunwayState} state @param {string} key */
function getAssumption(state, key) {
  return assumptionSegments(key).reduce((o, k) => /** @type {any} */ (o)?.[k], /** @type {any} */ (state));
}

/** @param {RunwayState} state @param {string} key @param {number|string} value */
function setAssumption(state, key, value) {
  const segs = assumptionSegments(key);
  const last = /** @type {string} */ (segs[segs.length - 1]);
  let target = /** @type {any} */ (state);
  for (const k of segs.slice(0, -1)) target = target[k];
  target[last] = value;
}

// ---------------------------------------------------------------------------
// preview + apply
// ---------------------------------------------------------------------------

/**
 * Name-keyed list diff: rows matched by name, changed when any field differs.
 * @param {any[]} oldRows @param {any[]} newRows @param {string[]} fields
 */
function diffList(oldRows, newRows, fields) {
  const pool = oldRows.map((row) => ({ used: false, row }));
  let adds = 0;
  let changes = 0;
  for (const n of newRows) {
    const match = pool.find((p) => !p.used && p.row.name === n.name);
    if (!match) {
      adds += 1;
      continue;
    }
    match.used = true;
    if (fields.some((f) => !Object.is(match.row[f], n[f]))) changes += 1;
  }
  return { adds, removes: pool.filter((p) => !p.used).length, changes };
}

/** @param {RunwayState} state */
function monthlySpend(state) {
  return state.spending.reduce((sum, c) => sum + (typeof c.monthly === "number" ? c.monthly : 0), 0);
}

/**
 * Per-tab replace preview: add/remove/change counts for valid tabs, cell
 * errors for blocked ones, "missing" for absent ones, plus headline deltas
 * computed by applying every valid tab.
 * @param {RunwayState} state
 * @param {ParsedTemplate} parsed
 * @returns {TemplatePreview}
 */
export function previewTemplate(state, parsed) {
  /** @type {TabPreview[]} */
  const tabs = [];
  for (const def of TEMPLATE_DEF.tabs) {
    const base = { key: def.key, label: def.name, adds: 0, removes: 0, changes: 0 };
    if (!parsed.tabsFound.includes(def.key)) {
      tabs.push({ ...base, status: "missing", errors: [] });
      continue;
    }
    const t = parsed.perTab[def.key];
    if (t.errors.length) {
      tabs.push({ ...base, status: "blocked", errors: t.errors });
      continue;
    }
    if (def.kind === "single") {
      const row = t.rows[0];
      const changed = !Object.is(row.balance, state.portfolio.balance) || !Object.is(row.realReturnPct, state.portfolio.realReturnPct);
      tabs.push({ ...base, status: "ready", changes: changed ? 1 : 0, errors: [] });
    } else if (def.kind === "settings") {
      const changes = /** @type {{key: string, value: number|string}[]} */ (t.rows).filter(
        ({ key, value }) => !Object.is(getAssumption(state, key), value)
      ).length;
      tabs.push({ ...base, status: "ready", changes, errors: [] });
    } else {
      const section = /** @type {"properties"|"incomes"|"spending"} */ (def.section);
      const counts = diffList(state[section], t.rows, def.columns.map((c) => c.field));
      tabs.push({ ...base, status: "ready", ...counts, errors: [] });
    }
  }

  const applicable = applicableTabs(parsed);
  const after = applicable.length ? applyTabs(state, parsed, applicable) : state;
  return {
    tabs,
    headline: {
      totalBalance: { before: state.portfolio.balance, after: after.portfolio.balance },
      monthlySpend: { before: monthlySpend(state), after: monthlySpend(after) },
    },
  };
}

/**
 * Apply the chosen tabs — pure; returns a new state. Every tab key must be a
 * found, error-free tab (the server pre-validates against applicableTabs;
 * this throws defensively otherwise).
 * @param {RunwayState} state
 * @param {ParsedTemplate} parsed
 * @param {string[]} tabKeys
 * @returns {RunwayState}
 */
export function applyTabs(state, parsed, tabKeys) {
  const ok = applicableTabs(parsed);
  const next = structuredClone(state);
  for (const key of tabKeys) {
    if (!ok.includes(key)) throw new Error(`tab '${key}' is not applicable`);
    const def = TEMPLATE_DEF.tabs.find((t) => t.key === key);
    if (!def) throw new Error(`unknown tab '${key}'`);
    const t = parsed.perTab[key];
    if (def.kind === "single") {
      const row = t.rows[0];
      next.portfolio = { balance: row.balance, realReturnPct: row.realReturnPct };
    } else if (def.kind === "settings") {
      for (const { key: path, value } of /** @type {{key: string, value: number|string}[]} */ (t.rows)) {
        setAssumption(next, path, value);
      }
    } else {
      const section = /** @type {"properties"|"incomes"|"spending"} */ (def.section);
      /** @type {any} */ (next)[section] = structuredClone(t.rows);
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

/**
 * Explicit-cell sheet builder: numbers as {t:"n"}, everything else as a
 * guarded {t:"s"} string — a text cell can never be written as a formula.
 * @param {(string|number|null|undefined)[][]} aoa
 * @returns {import("xlsx").WorkSheet}
 */
function sheetFromAoa(aoa) {
  /** @type {import("xlsx").WorkSheet} */
  const ws = {};
  let maxC = 1;
  aoa.forEach((row, r) => {
    maxC = Math.max(maxC, row.length);
    row.forEach((v, c) => {
      if (v === null || v === undefined) return;
      const addr = XLSX.utils.encode_cell({ r, c });
      ws[addr] = typeof v === "number" ? { t: "n", v } : { t: "s", v: guardText(String(v)) };
    });
  });
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(aoa.length - 1, 0), c: maxC - 1 } });
  return ws;
}

/**
 * Fill the template shape with a state. Used by GET /api/export/template and
 * by scripts/build-template.mjs (with defaultState) to write the blank template.
 * @param {RunwayState} state
 * @returns {Buffer} .xlsx bytes
 */
export function buildTemplateWorkbook(state) {
  const wb = XLSX.utils.book_new();
  for (const def of TEMPLATE_DEF.tabs) {
    /** @type {(string|number|null|undefined)[][]} */
    const aoa = [def.columns.map((c) => c.header)];
    if (def.kind === "single") {
      aoa.push([state.portfolio.balance, state.portfolio.realReturnPct]);
    } else if (def.kind === "settings") {
      for (const s of def.settings ?? []) {
        const v = s.key === "endState.mode" ? state.endState.mode : /** @type {number} */ (getAssumption(state, s.key));
        aoa.push([s.key, v, s.doc]);
      }
      if (def.note) aoa.push([def.note]);
    } else {
      const section = /** @type {"properties"|"incomes"|"spending"} */ (def.section);
      for (const row of /** @type {any[]} */ (state[section])) {
        aoa.push(def.columns.map((c) => row[c.field]));
      }
    }
    const ws = sheetFromAoa(aoa);
    ws["!cols"] = def.columns.map((c) => ({ wch: Math.max(c.header.length + 2, 12) }));
    XLSX.utils.book_append_sheet(wb, ws, def.name);
  }
  return /** @type {Buffer} */ (XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}
