// Balance-over-time chart + the cash-flow drill-down (U7).
//
// Same discipline as the rest of public/ui: PURE data shaping up top
// (chartModel, readoutAt, cashflowView, …) with no DOM access at module top
// level — node:test imports this file under plain Node — plus thin DOM
// controllers at the bottom that app.mjs instantiates once and feeds on every
// re-render (so legend toggles and the hover readout survive re-renders).
//
// CSP discipline: no style attributes anywhere. Geometry lands as dynamic SVG
// attributes (d, x1, y1, viewBox); every color/width comes from a CSS class —
// scenario hues via the .scen-<key> custom properties in style.css.
import { el, setText, show } from "./dom.mjs";
import { fmtCompact } from "./verdict.mjs";

/** @typedef {{year: number, age: number, bal: number}} PathPoint */
/** @typedef {{key: string, label: string, path: PathPoint[]}} ScenarioSeries */

// ---------------------------------------------------------------------------
// pure: chart model
// ---------------------------------------------------------------------------

const PAD = { top: 12, right: 12, bottom: 20, left: 8 };

/** Round to 2 decimals — keeps SVG attribute strings short and stable. @param {number} n */
function r2(n) {
  return Math.round(n * 100) / 100;
}

/** 1/2/5 × 10^k tick step ≥ raw. @param {number} raw positive */
function niceStep(raw) {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  if (n <= 1) return mag;
  if (n <= 2) return 2 * mag;
  if (n <= 5) return 5 * mag;
  return 10 * mag;
}

/**
 * @param {PathPoint[]} path
 * @param {(year: number) => number} xFor @param {(bal: number) => number} yFor
 */
function lineD(path, xFor, yFor) {
  if (path.length === 0) return "";
  if (path.length === 1) {
    // A lone point would be an invisible zero-length stroke — show a short dash.
    const x = xFor(path[0].year);
    const y = r2(yFor(path[0].bal));
    return `M${r2(x - 2)} ${y} L${r2(x + 2)} ${y}`;
  }
  return path.map((p, i) => `${i ? "L" : "M"}${r2(xFor(p.year))} ${r2(yFor(p.bal))}`).join(" ");
}

/**
 * Shape sim paths into an SVG-ready model. Pure and total: empty input, empty
 * paths, single points, all-positive, all-negative, and negative-crossing
 * ranges all produce a well-formed model (never NaN).
 *
 * Y-domain policy: hidden scenarios are excluded from the scale (toggling a
 * wild scenario off rescales the rest); an all-positive range pins $0 to the
 * plot floor, an all-negative range pins it to the ceiling, and a crossing
 * range gets padding on both sides so the $0 gridline sits inside the plot.
 *
 * @param {ScenarioSeries[]} series one entry per scenario, path = sim.path
 * @param {{width?: number, height?: number, hidden?: Iterable<string>}} [opts]
 * @returns {{width: number, height: number, plot: {x:number,y:number,w:number,h:number},
 *   empty: boolean, domain: {yearMin:number,yearMax:number,yMin:number,yMax:number}|null,
 *   paths: {key:string,label:string,d:string,visible:boolean}[], zeroY: number|null,
 *   xTicks: {x:number,label:string}[], yTicks: {y:number,label:string}[]}}
 */
export function chartModel(series, opts = {}) {
  const width = opts.width ?? 640;
  const height = opts.height ?? 280;
  const hidden = new Set(opts.hidden ?? []);
  const plot = { x: PAD.left, y: PAD.top, w: width - PAD.left - PAD.right, h: height - PAD.top - PAD.bottom };
  const visible = (s) => !hidden.has(s.key);

  const visiblePts = series.filter(visible).flatMap((s) => s.path);
  if (visiblePts.length === 0) {
    return {
      width,
      height,
      plot,
      empty: true,
      domain: null,
      zeroY: null,
      xTicks: [],
      yTicks: [],
      paths: series.map((s) => ({ key: s.key, label: s.label, d: "", visible: visible(s) })),
    };
  }

  let yearMin = Infinity;
  let yearMax = -Infinity;
  let balMin = Infinity;
  let balMax = -Infinity;
  for (const p of visiblePts) {
    if (p.year < yearMin) yearMin = p.year;
    if (p.year > yearMax) yearMax = p.year;
    if (p.bal < balMin) balMin = p.bal;
    if (p.bal > balMax) balMax = p.bal;
  }

  const span = balMax - balMin;
  const pad = (span || Math.max(Math.abs(balMax), Math.abs(balMin), 1)) * 0.06;
  let yMin;
  let yMax;
  if (balMin >= 0) {
    yMin = 0; // all positive: $0 is the plot floor
    yMax = balMax + pad;
  } else if (balMax <= 0) {
    yMax = 0; // all negative: $0 is the ceiling
    yMin = balMin - pad;
  } else {
    yMin = balMin - pad;
    yMax = balMax + pad;
  }

  const xSpan = yearMax - yearMin || 1;
  const xFor = (year) => plot.x + (plot.w * (year - yearMin)) / xSpan;
  const yFor = (v) => plot.y + (plot.h * (yMax - v)) / (yMax - yMin);

  /** @type {{x:number,label:string}[]} decade ticks; degenerate ranges fall back to the endpoints */
  const xTicks = [];
  for (let y = Math.ceil(yearMin / 10) * 10; y <= yearMax; y += 10) {
    xTicks.push({ x: r2(xFor(y)), label: String(y) });
  }
  if (xTicks.length === 0) {
    xTicks.push({ x: r2(xFor(yearMin)), label: String(yearMin) });
    if (yearMax > yearMin) xTicks.push({ x: r2(xFor(yearMax)), label: String(yearMax) });
  }

  /** @type {{y:number,label:string}[]} */
  const yTicks = [];
  const step = niceStep((yMax - yMin) / 4);
  for (let v = Math.ceil(yMin / step) * step; v <= yMax + step * 1e-9; v += step) {
    if (Math.abs(v) < step * 1e-9) continue; // $0 has its own labeled dashed line
    yTicks.push({ y: r2(yFor(v)), label: fmtCompact(v) });
  }

  return {
    width,
    height,
    plot,
    empty: false,
    domain: { yearMin, yearMax, yMin, yMax },
    zeroY: yMin <= 0 && 0 <= yMax ? r2(yFor(0)) : null,
    xTicks,
    yTicks,
    paths: series.map((s) => ({ key: s.key, label: s.label, d: lineD(s.path, xFor, yFor), visible: visible(s) })),
  };
}

/** Pixel x for a year (null when the model is empty). @param {ReturnType<typeof chartModel>} model @param {number} year */
export function xForYear(model, year) {
  if (!model.domain) return null;
  const { yearMin, yearMax } = model.domain;
  return r2(model.plot.x + (model.plot.w * (year - yearMin)) / (yearMax - yearMin || 1));
}

/** Nearest integer year for a pixel x, clamped to the domain (null when empty). @param {ReturnType<typeof chartModel>} model @param {number} px */
export function yearAtX(model, px) {
  if (!model.domain) return null;
  const { yearMin, yearMax } = model.domain;
  const t = (px - model.plot.x) / (model.plot.w || 1);
  return Math.max(yearMin, Math.min(yearMax, Math.round(yearMin + t * (yearMax - yearMin))));
}

/**
 * Rows for the fixed readout bar: every scenario's balance at `year`.
 * Scenarios whose path doesn't include that year are skipped (never NaN).
 * The DOM layer filters out hidden scenarios.
 * @param {ScenarioSeries[]} series @param {number} year
 * @returns {{key:string, label:string, bal:number}[]}
 */
export function readoutAt(series, year) {
  const rows = [];
  for (const s of series) {
    const pt = s.path.find((p) => p.year === year);
    if (pt) rows.push({ key: s.key, label: s.label, bal: pt.bal });
  }
  return rows;
}

/** Legend/readout copy — the full scenario labels are too long for chips. */
const SHORT_LABELS = {
  base: "base",
  spend: "spend more",
  p50: "50%",
  p80: "80%",
  p90: "90%",
  s50: "spend more 50%",
  s90: "spend more 90%",
};

/** @param {string} key @param {string} label fallback for unknown keys */
export function shortLabel(key, label) {
  return SHORT_LABELS[key] ?? label;
}

// ---------------------------------------------------------------------------
// pure: cash-flow drill-down view
// ---------------------------------------------------------------------------

/**
 * @template T
 * @param {T[]} rows @param {boolean} showAll @param {number} [limit]
 * @returns {{shown: T[], hiddenCount: number}}
 */
export function cashflowView(rows, showAll, limit = 15) {
  const shown = showAll ? rows : rows.slice(0, limit);
  return { shown, hiddenCount: rows.length - shown.length };
}

// ---------------------------------------------------------------------------
// DOM (browser only — called from app.mjs, never at import time)
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * el() for the SVG namespace. Numbers are fine — setAttribute stringifies.
 * @param {string} tag @param {Record<string, string|number>} [attrs] @param {...(Node|string)} children
 */
export function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const child of children) {
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * The balance-over-time chart controller. Build once, then update(series) on
 * every re-render. Internal state (hidden scenarios, readout year) survives
 * updates. Hover moves the crosshair + fixed readout bar below the chart; a
 * touch tap does the same and the readout stays until the next tap (nothing
 * ever floats over the chart).
 * @param {HTMLElement} mount
 */
export function createBalanceChart(mount) {
  const W = 640;
  const H = 280;
  /** @type {ScenarioSeries[]} */ let series = [];
  /** @type {Set<string>} */ const hidden = new Set();
  /** @type {number|null} */ let readoutYear = null; // null → default to the final year
  /** @type {ReturnType<typeof chartModel>|null} */ let model = null;
  /** @type {SVGElement|null} */ let crossEl = null;

  const legend = el("div", { class: "chart-legend" });
  const svg = svgEl("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "balance over time by scenario" });
  const readout = el("div", { class: "chart-readout" });
  mount.append(legend, svg, readout);

  /** @param {PointerEvent} e viewBox x from a pointer event */
  function pxFromEvent(e) {
    const rect = svg.getBoundingClientRect();
    return ((e.clientX - rect.left) / (rect.width || 1)) * W;
  }

  /** @param {number|null} year */
  function setYear(year) {
    if (year === null) return;
    readoutYear = year;
    positionCrosshair();
    renderReadout();
  }

  // Hover tracks; a tap (pointerdown) sets and STAYS — nothing clears on
  // leave, so the readout is sticky for touch and mouse alike.
  svg.addEventListener("pointermove", (e) => model && setYear(yearAtX(model, pxFromEvent(e))));
  svg.addEventListener("pointerdown", (e) => model && setYear(yearAtX(model, pxFromEvent(e))));

  function positionCrosshair() {
    if (!crossEl || !model) return;
    if (readoutYear === null || !model.domain) {
      crossEl.classList.add("hidden");
      return;
    }
    const x = xForYear(model, readoutYear);
    crossEl.setAttribute("x1", String(x));
    crossEl.setAttribute("x2", String(x));
    crossEl.classList.remove("hidden");
  }

  function renderReadout() {
    readout.textContent = "";
    if (!model || !model.domain) {
      setText(readout, "—");
      return;
    }
    const year = readoutYear ?? model.domain.yearMax;
    readout.appendChild(el("span", { class: "ro-year" }, String(year)));
    for (const row of readoutAt(series, year)) {
      if (hidden.has(row.key)) continue;
      readout.appendChild(el("span", { class: `ro scen-${row.key}` }, `${shortLabel(row.key, row.label)} ${fmtCompact(row.bal)}`));
    }
  }

  function render() {
    model = chartModel(series, { width: W, height: H, hidden });

    legend.textContent = "";
    for (const s of series) {
      const off = hidden.has(s.key);
      const chip = el(
        "button",
        { type: "button", class: `chip scen-${s.key}${off ? " off" : ""}`, "aria-pressed": String(!off), title: s.label },
        el("span", { class: "swatch" }),
        shortLabel(s.key, s.label)
      );
      chip.addEventListener("click", () => {
        if (!hidden.delete(s.key)) hidden.add(s.key);
        render();
      });
      legend.appendChild(chip);
    }

    svg.textContent = "";
    if (!model.empty) {
      for (const t of model.yTicks) {
        svg.appendChild(svgEl("line", { class: "gridline", x1: model.plot.x, x2: model.plot.x + model.plot.w, y1: t.y, y2: t.y }));
        svg.appendChild(svgEl("text", { class: "tick-label", x: model.plot.x + 2, y: t.y - 3 }, t.label));
      }
      if (model.zeroY !== null) {
        svg.appendChild(svgEl("line", { class: "zero-line", x1: model.plot.x, x2: model.plot.x + model.plot.w, y1: model.zeroY, y2: model.zeroY }));
        svg.appendChild(svgEl("text", { class: "tick-label", x: model.plot.x + model.plot.w - 2, y: model.zeroY - 3, "text-anchor": "end" }, "$0"));
      }
      for (const t of model.xTicks) {
        svg.appendChild(svgEl("text", { class: "tick-label", x: t.x, y: H - 6, "text-anchor": "middle" }, t.label));
      }
    }
    for (const p of model.paths) {
      if (!p.d) continue;
      svg.appendChild(svgEl("path", { class: `scen-line scen-${p.key}${p.visible ? "" : " hidden"}`, d: p.d }));
    }
    crossEl = svgEl("line", { class: "crosshair hidden", x1: 0, x2: 0, y1: model.plot.y, y2: model.plot.y + model.plot.h });
    svg.appendChild(crossEl);

    if (model.domain && readoutYear !== null) {
      readoutYear = Math.max(model.domain.yearMin, Math.min(model.domain.yearMax, readoutYear));
    }
    positionCrosshair();
    renderReadout();
  }

  return {
    /** @param {ScenarioSeries[]} next */
    update(next) {
      series = next;
      render();
    },
  };
}

/**
 * Year-by-year cash-flow table for the BASE scenario (sim.rows). Renders the
 * first 15 years with a show-all toggle; the toggle state survives updates.
 * @param {HTMLElement} mount
 */
export function createCashflowTable(mount) {
  /** @type {import("../../src/engine/simulate.mjs").YearRow[]} */ let rows = [];
  let showAll = false;

  const headRow = el("tr", {}, el("th", {}, "year"), el("th", {}, "age"));
  for (const label of ["income", "SS", "health", "spend", "saved in", "taken out", "of which RMD", "tax", "return", "balance"]) {
    headRow.appendChild(el("th", { class: "num" }, label));
  }
  const tbody = el("tbody");
  const toggle = el("button", { type: "button", class: "small showall hidden" }, "");
  toggle.addEventListener("click", () => {
    showAll = !showAll;
    render();
  });
  mount.append(el("table", { class: "cashflow" }, el("thead", {}, headRow), tbody), toggle);

  /** @param {number} v */
  const money = (v) => el("td", { class: "num" }, fmtCompact(v));

  function render() {
    const view = cashflowView(rows, showAll);
    tbody.textContent = "";
    for (const r of view.shown) {
      tbody.appendChild(
        el(
          "tr",
          {},
          el("td", {}, String(r.year)),
          el("td", { class: "dim" }, String(r.age)),
          money(r.income),
          money(r.ss),
          money(r.health),
          money(r.spend),
          money(r.contrib),
          money(r.withdrawn),
          el("td", { class: "num dim" }, r.rmd > 0 ? fmtCompact(r.rmd) : "–"),
          money(r.tax),
          el("td", { class: "num dim" }, `${r.returnPct.toFixed(1)}%`),
          el("td", { class: r.bal < 0 ? "num neg" : "num" }, fmtCompact(r.bal))
        )
      );
    }
    show(toggle, rows.length > 15);
    setText(toggle, showAll ? "Show first 15 years" : `Show all ${rows.length} years`);
  }

  return {
    /** @param {import("../../src/engine/simulate.mjs").YearRow[]} next */
    update(next) {
      rows = next;
      render();
    },
  };
}
