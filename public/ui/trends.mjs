// Trends over calendar time (U7): small multiples of totalBalance,
// monthlySpend, and the base-case gap over the trend-row history.
//
// Fetched from /api/trends ONCE at page load — deliberately. A trend row is
// appended at most on the first save of each calendar date (plus shutdown),
// so re-fetching after every save would almost never show anything new;
// reload the page to refresh.
//
// trendModel is tolerant by design (belt-and-suspenders — the server already
// skips torn lines): null/unparseable/missing-field rows are skipped, unknown
// fields and future `v` values ride along untouched, and the LAST row per
// calendar date wins regardless of source (edit/migration/restore/shutdown
// all count — they're history).
import { el } from "./dom.mjs";
import { fmtCompact } from "./verdict.mjs";
import { svgEl } from "./charts.mjs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** @param {unknown} v */
function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * gapBase → a plottable number: "met" → 0 (nothing more needed), "value" →
 * amount, "unreachable" (and any future kind) → null (a gap in the line).
 * Rows written before the gap existed (v2, which carried the old required
 * income instead) also plot as null: the two numbers aren't comparable.
 * @param {unknown} gap
 * @returns {number|null}
 */
export function gapAmount(gap) {
  if (gap === null || typeof gap !== "object") return null;
  const g = /** @type {{kind?: unknown, amount?: unknown}} */ (gap);
  if (g.kind === "met") return 0;
  if (g.kind === "value" && isNum(g.amount)) return /** @type {number} */ (g.amount);
  return null;
}

/**
 * @typedef {{date: string, totalBalance: number, monthlySpend: number, gap: number|null}} TrendPoint
 *
 * Shape raw trend rows (from GET /api/trends) into per-day points.
 * @param {unknown} rows
 * @returns {{points: TrendPoint[], enough: boolean}} enough = ≥2 points (else show the empty state)
 */
export function trendModel(rows) {
  /** @type {Map<string, TrendPoint>} */
  const byDate = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const r = /** @type {Record<string, any>} */ (row);
    if (typeof r.date !== "string" || !DATE_RE.test(r.date)) continue;
    if (!isNum(r.totalBalance) || !isNum(r.monthlySpend)) continue;
    const hasGap = r.gapBase !== null && typeof r.gapBase === "object";
    const hasLegacy = r.requiredBase !== null && typeof r.requiredBase === "object";
    if (!hasGap && !hasLegacy) continue;
    // Unknown fields and future `v` values are tolerated (ignored). Map.set
    // means the last row per calendar date wins — file order is append order.
    byDate.set(r.date, {
      date: r.date,
      totalBalance: r.totalBalance,
      monthlySpend: r.monthlySpend,
      gap: hasGap ? gapAmount(r.gapBase) : null,
    });
  }
  const points = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { points, enough: points.length >= 2 };
}

/**
 * Multi-segment SVG path over nullable points — null entries lift the pen,
 * so gaps (unreachable days) break the line instead of bridging it.
 * @param {({x: number, y: number}|null)[]} pts
 */
export function pathD(pts) {
  let d = "";
  let pen = false;
  for (const p of pts) {
    if (p === null) {
      pen = false;
      continue;
    }
    d += `${d ? " " : ""}${pen ? "L" : "M"}${p.x} ${p.y}`;
    pen = true;
  }
  return d;
}

/**
 * Geometry for one small multiple. X is proportional to calendar time (a
 * missed week reads as a longer gap); Y spans the series' own min/max.
 * `latest` is the LAST point's value — null when the latest day is a gap.
 * @param {TrendPoint[]} points @param {"totalBalance"|"monthlySpend"|"gap"} key
 * @param {{width?: number, height?: number}} [opts]
 * @returns {{d: string, dots: {x:number,y:number}[], latest: number|null}}
 */
export function seriesGeometry(points, key, opts = {}) {
  const width = opts.width ?? 260;
  const height = opts.height ?? 64;
  const pad = 6;
  const vals = points.map((p) => p[key]).filter((v) => v !== null);
  if (vals.length === 0) return { d: "", dots: [], latest: null };

  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (min === max) {
    const bump = Math.max(1, Math.abs(min)) * 0.1; // flat series still draws mid-plot
    min -= bump;
    max += bump;
  }
  const ts = points.map((p) => Date.parse(p.date));
  const t0 = Math.min(...ts);
  const tSpan = Math.max(...ts) - t0 || 1;
  const r2 = (n) => Math.round(n * 100) / 100;

  const xy = points.map((p, i) => {
    const v = p[key];
    if (v === null) return null;
    return {
      x: r2(pad + ((width - 2 * pad) * (ts[i] - t0)) / tSpan),
      y: r2(pad + ((height - 2 * pad) * (max - v)) / (max - min)),
    };
  });
  const last = points[points.length - 1];
  return { d: pathD(xy), dots: /** @type {{x:number,y:number}[]} */ (xy.filter((p) => p !== null)), latest: last ? last[key] : null };
}

export const TRENDS_EMPTY_COPY =
  "Trends appear after your first few days of edits — every day you save, a point lands here.";

const SERIES = [
  { key: /** @type {const} */ ("totalBalance"), label: "total balance" },
  { key: /** @type {const} */ ("monthlySpend"), label: "monthly spend" },
  { key: /** @type {const} */ ("gap"), label: "gap today (base)" },
];

// ---------------------------------------------------------------------------
// DOM (browser only — called from app.mjs, never at import time)
// ---------------------------------------------------------------------------

/**
 * Render the trend section from a model (exported separately so a failed
 * fetch can still render the empty state).
 * @param {HTMLElement} mount @param {ReturnType<typeof trendModel>} model
 */
export function renderTrends(mount, model) {
  mount.textContent = "";
  if (!model.enough) {
    mount.appendChild(el("div", { class: "trend-empty" }, TRENDS_EMPTY_COPY));
    return;
  }
  const W = 260;
  const H = 64;
  for (const s of SERIES) {
    const g = seriesGeometry(model.points, s.key, { width: W, height: H });
    const svg = svgEl("svg", { class: "trend-chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${s.label} trend` });
    if (g.d) svg.appendChild(svgEl("path", { class: "trend-line", d: g.d }));
    for (const dot of g.dots) svg.appendChild(svgEl("circle", { class: "trend-dot", cx: dot.x, cy: dot.y, r: 1.8 }));
    mount.appendChild(
      el(
        "div",
        { class: "trend-multiple" },
        el("div", { class: "trend-head" }, el("span", { class: "l" }, s.label), el("span", { class: "v" }, g.latest === null ? "—" : fmtCompact(g.latest))),
        svg
      )
    );
  }
}

/**
 * Fetch /api/trends once and render. Errors degrade to the empty state —
 * trends are advisory, never load-blocking.
 * @param {HTMLElement} mount
 * @param {{fetchFn?: (url: string) => Promise<{status: number, json: () => Promise<any>}>}} [opts]
 */
export async function initTrends(mount, opts = {}) {
  const fetchFn = opts.fetchFn ?? ((url) => fetch(url));
  let rows = [];
  try {
    const res = await fetchFn("/api/trends");
    if (res.status === 200) rows = (await res.json())?.rows ?? [];
  } catch {
    /* server gone mid-load — the empty state renders below */
  }
  renderTrends(mount, trendModel(rows));
}
