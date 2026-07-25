// Pure-logic chart tests (U7): balance-chart model + readout, cash-flow view,
// trend model + geometry, snapshot copy. No DOM — public/ui/{charts,trends,
// snapshots}.mjs must load under plain Node (no DOM globals at module top
// level), which this file enforces by importing them.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chartModel,
  xForYear,
  yearAtX,
  readoutAt,
  shortLabel,
  cashflowView,
  createBalanceChart,
  createCashflowTable,
} from "../public/ui/charts.mjs";
import {
  trendModel,
  requiredPerYear,
  pathD,
  seriesGeometry,
  renderTrends,
  initTrends,
  TRENDS_EMPTY_COPY,
} from "../public/ui/trends.mjs";
import { snapshotWhen, restoreConfirmText, initSnapshots, STALE_LIST_COPY } from "../public/ui/snapshots.mjs";
import { simulate } from "../src/engine/simulate.mjs";
import { placeholderState } from "../src/model/placeholder.mjs";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/** Build a ScenarioSeries from balances, one per year starting at startYear. */
function mk(key, bals, startYear = 2025) {
  return { key, label: `label:${key}`, path: bals.map((bal, i) => ({ year: startYear + i, age: 40 + i, bal })) };
}

/** Parse "Mx y Lx y…" into [{x, y}] pairs. */
function dPoints(d) {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const pts = [];
  for (let i = 0; i < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
  return pts;
}

/** A well-formed trend row; overrides poke holes in it. */
function trendRow(overrides = {}) {
  return {
    v: 1,
    ts: "2026-07-01T14:00:00.000Z",
    date: "2026-07-01",
    source: "edit",
    rev: 3,
    totalBalance: 1_500_000,
    monthlySpend: 7200,
    requiredBase: { kind: "value", perYear: 85_000 },
    requiredWorst: { kind: "unreachable" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// chartModel — scaling
// ---------------------------------------------------------------------------

test("chartModel: negative-crossing range puts the $0 line strictly inside the plot", () => {
  const m = chartModel([mk("base", [100, 50, -50, -100])]);
  assert.equal(m.empty, false);
  assert.ok(m.zeroY !== null, "zero line exists");
  assert.ok(m.zeroY > m.plot.y && m.zeroY < m.plot.y + m.plot.h, "$0 strictly inside the plot");
  assert.ok(m.domain.yMin < -100 && m.domain.yMax > 100, "domain padded beyond the data");
  const pts = dPoints(m.paths[0].d);
  assert.equal(pts.length, 4);
  assert.ok(pts[0].y < m.zeroY, "positive balance draws above the $0 line (y grows downward)");
  assert.ok(pts.at(-1).y > m.zeroY, "negative balance draws below the $0 line");
});

test("chartModel: all-positive range pins $0 to the plot floor", () => {
  const m = chartModel([mk("base", [100, 200, 300])]);
  assert.equal(m.domain.yMin, 0, "floor is exactly $0");
  assert.equal(m.zeroY, m.plot.y + m.plot.h, "$0 gridline sits on the plot floor");
  for (const p of dPoints(m.paths[0].d)) {
    assert.ok(p.y >= m.plot.y && p.y <= m.plot.y + m.plot.h, "every point inside the plot");
  }
});

test("chartModel: all-negative range pins $0 to the plot ceiling", () => {
  const m = chartModel([mk("base", [-100, -200, -300])]);
  assert.equal(m.domain.yMax, 0);
  assert.equal(m.zeroY, m.plot.y, "$0 gridline sits on the plot ceiling");
});

test("chartModel: empty input and empty paths produce a well-formed empty model", () => {
  const none = chartModel([]);
  assert.equal(none.empty, true);
  assert.deepEqual(none.paths, []);
  assert.equal(none.zeroY, null);
  assert.deepEqual(none.xTicks, []);
  const emptyPath = chartModel([{ key: "base", label: "Base case", path: [] }]);
  assert.equal(emptyPath.empty, true);
  assert.deepEqual(emptyPath.paths, [{ key: "base", label: "Base case", d: "", visible: true }]);
  assert.equal(xForYear(emptyPath, 2030), null, "helpers are null-safe on empty models");
  assert.equal(yearAtX(emptyPath, 100), null);
});

test("chartModel: single scenario with a single point still renders (a visible dash, no NaN)", () => {
  const m = chartModel([mk("base", [500])]);
  assert.equal(m.empty, false);
  assert.ok(m.paths[0].d.length > 0, "single point gets a drawable d");
  assert.ok(!/NaN/.test(m.paths[0].d), "no NaN in the path");
  assert.equal(dPoints(m.paths[0].d).length, 2, "lone point widened to a short dash");
  assert.ok(!m.xTicks.some((t) => Number.isNaN(t.x)), "degenerate x-scale stays finite");
});

test("chartModel: x ticks land on decades", () => {
  const m = chartModel([mk("base", new Array(31).fill(100))]); // 2025..2055
  assert.deepEqual(m.xTicks.map((t) => t.label), ["2030", "2040", "2050"]);
  const xs = m.xTicks.map((t) => t.x);
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b), "ticks ordered left to right");
});

test("chartModel: hidden scenarios keep their path but are excluded from the y-scale", () => {
  const wild = mk("everything", [0, 1e9]);
  const base = mk("base", [0, 100]);
  const m = chartModel([base, wild], { hidden: ["everything"] });
  assert.equal(m.paths.find((p) => p.key === "everything").visible, false);
  assert.equal(m.paths.find((p) => p.key === "base").visible, true);
  assert.ok(m.domain.yMax < 1e6, "scale follows the visible series only");
  assert.equal(chartModel([base], { hidden: ["base"] }).empty, true, "all-hidden → empty model");
});

test("chartModel: $0 never gets a duplicate y-tick label (the dashed line owns it)", () => {
  const m = chartModel([mk("base", [100, -100])]);
  assert.ok(!m.yTicks.some((t) => t.label === "$0"));
  assert.ok(m.yTicks.length > 0, "other ticks still present");
});

test("xForYear / yearAtX round-trip and clamp to the domain", () => {
  const m = chartModel([mk("base", new Array(21).fill(50))]); // 2025..2045
  assert.equal(yearAtX(m, xForYear(m, 2030)), 2030);
  assert.equal(yearAtX(m, xForYear(m, 2045)), 2045);
  assert.equal(yearAtX(m, -1e6), 2025, "clamps left");
  assert.equal(yearAtX(m, 1e6), 2045, "clamps right");
});

// ---------------------------------------------------------------------------
// readoutAt — the fixed info bar under the chart
// ---------------------------------------------------------------------------

test("readoutAt: per-scenario balance at the year; scenarios without that year are skipped", () => {
  const series = [mk("base", [10, 20, 30]), mk("stress", [5, 15], 2026)]; // stress covers 2026..2027 only
  assert.deepEqual(readoutAt(series, 2026), [
    { key: "base", label: "label:base", bal: 20 },
    { key: "stress", label: "label:stress", bal: 5 },
  ]);
  assert.deepEqual(readoutAt(series, 2025), [{ key: "base", label: "label:base", bal: 10 }]);
  assert.deepEqual(readoutAt(series, 1999), [], "year outside every path → no rows");
});

test("shortLabel: known scenario keys shorten; unknown keys fall back to the full label", () => {
  assert.equal(shortLabel("drawdown", "Market −30% now"), "market −30%");
  assert.equal(shortLabel("custom-future", "My custom scenario"), "My custom scenario");
});

// ---------------------------------------------------------------------------
// cashflowView — drill-down table paging
// ---------------------------------------------------------------------------

test("cashflowView: first 15 rows by default, all rows when showAll", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ year: 2026 + i }));
  const closed = cashflowView(rows, false);
  assert.equal(closed.shown.length, 15);
  assert.equal(closed.shown[14].year, 2040, "the FIRST 15 years");
  assert.equal(closed.hiddenCount, 25);
  const open = cashflowView(rows, true);
  assert.equal(open.shown.length, 40);
  assert.equal(open.hiddenCount, 0);
  const short = cashflowView(rows.slice(0, 10), false);
  assert.equal(short.shown.length, 10);
  assert.equal(short.hiddenCount, 0);
});

// ---------------------------------------------------------------------------
// trendModel — tolerant shaping of trends.jsonl rows
// ---------------------------------------------------------------------------

test("trendModel: last row per calendar date wins, all sources count, points sorted by date", () => {
  const { points, enough } = trendModel([
    trendRow({ date: "2026-07-02", totalBalance: 2, source: "shutdown" }),
    trendRow({ date: "2026-07-01", totalBalance: 1, source: "edit" }),
    trendRow({ date: "2026-07-01", totalBalance: 99, source: "restore" }), // later line wins
  ]);
  assert.equal(enough, true);
  assert.deepEqual(points.map((p) => [p.date, p.totalBalance]), [
    ["2026-07-01", 99],
    ["2026-07-02", 2],
  ]);
});

test("trendModel: null / non-object / missing-field / wrong-type rows are skipped", () => {
  const { points } = trendModel([
    null,
    "garbage",
    42,
    [trendRow()],
    trendRow({ date: undefined }),
    trendRow({ date: "July 1" }),
    trendRow({ totalBalance: "1500000" }),
    trendRow({ monthlySpend: NaN }),
    trendRow({ requiredBase: undefined }),
    trendRow({ requiredBase: null }),
    trendRow({ date: "2026-07-03" }), // the one good row
  ]);
  assert.equal(points.length, 1);
  assert.equal(points[0].date, "2026-07-03");
});

test("trendModel: unknown fields and future v values are tolerated", () => {
  const { points } = trendModel([
    trendRow({ v: 99, futureField: { deeply: "nested" }, date: "2026-07-01" }),
    trendRow({ v: 2, anotherThing: [1, 2, 3], date: "2026-07-02", totalBalance: 7 }),
  ]);
  assert.equal(points.length, 2);
  assert.equal(points[1].totalBalance, 7);
});

test("trendModel/requiredPerYear: met → 0, value → perYear, unreachable and unknown kinds → gap", () => {
  assert.equal(requiredPerYear({ kind: "met" }), 0);
  assert.equal(requiredPerYear({ kind: "value", perYear: 85_000 }), 85_000);
  assert.equal(requiredPerYear({ kind: "unreachable" }), null);
  assert.equal(requiredPerYear({ kind: "some-future-kind" }), null);
  assert.equal(requiredPerYear({ kind: "value", perYear: "85000" }), null, "non-numeric perYear → gap, not NaN");
  const { points } = trendModel([
    trendRow({ date: "2026-07-01", requiredBase: { kind: "met" } }),
    trendRow({ date: "2026-07-02", requiredBase: { kind: "unreachable" } }),
    trendRow({ date: "2026-07-03", requiredBase: { kind: "value", perYear: 40_000 } }),
  ]);
  assert.deepEqual(points.map((p) => p.required), [0, null, 40_000]);
});

test("trendModel: fewer than 2 points flags the empty state (0 rows, 1 row, same-day rows)", () => {
  assert.deepEqual(trendModel([]), { points: [], enough: false });
  assert.deepEqual(trendModel(undefined), { points: [], enough: false }, "non-array input tolerated");
  assert.equal(trendModel([trendRow()]).enough, false);
  const sameDay = trendModel([trendRow({ totalBalance: 1 }), trendRow({ totalBalance: 2 })]);
  assert.equal(sameDay.enough, false, "two rows on ONE day collapse to one point");
  assert.equal(sameDay.points[0].totalBalance, 2);
});

// ---------------------------------------------------------------------------
// pathD + seriesGeometry — gaps break the line, never bridge it
// ---------------------------------------------------------------------------

test("pathD: null points lift the pen — one M per segment", () => {
  const d = pathD([{ x: 0, y: 0 }, null, { x: 10, y: 10 }, { x: 20, y: 5 }]);
  assert.equal(d, "M0 0 M10 10 L20 5");
  assert.equal(pathD([]), "");
  assert.equal(pathD([null, null]), "");
});

test("seriesGeometry: gaps split segments, dots mark real points, latest is the LAST day's value", () => {
  const points = [
    { date: "2026-07-01", totalBalance: 1, monthlySpend: 1, required: 10_000 },
    { date: "2026-07-02", totalBalance: 2, monthlySpend: 1, required: null }, // unreachable day
    { date: "2026-07-03", totalBalance: 3, monthlySpend: 1, required: 30_000 },
    { date: "2026-07-04", totalBalance: 4, monthlySpend: 1, required: 20_000 },
  ];
  const g = seriesGeometry(points, "required");
  assert.equal((g.d.match(/M/g) ?? []).length, 2, "the gap breaks the line into two segments");
  assert.equal(g.dots.length, 3, "one dot per non-null point");
  assert.equal(g.latest, 20_000);
  const gapLast = seriesGeometry(points.slice(0, 2), "required");
  assert.equal(gapLast.latest, null, "latest is null when the newest day is a gap");
  assert.ok(!/NaN/.test(seriesGeometry(points, "monthlySpend").d), "flat series stays finite");
  assert.deepEqual(seriesGeometry([], "totalBalance"), { d: "", dots: [], latest: null });
});

test("seriesGeometry: x spacing is proportional to calendar time", () => {
  const points = [
    { date: "2026-07-01", totalBalance: 1, monthlySpend: 1, required: null },
    { date: "2026-07-02", totalBalance: 2, monthlySpend: 1, required: null },
    { date: "2026-07-11", totalBalance: 3, monthlySpend: 1, required: null }, // a 9-day silence
  ];
  const [a, b, c] = seriesGeometry(points, "totalBalance").dots;
  assert.ok(c.x - b.x > (b.x - a.x) * 5, "a missed week reads as a longer gap");
});

// ---------------------------------------------------------------------------
// snapshots — copy helpers
// ---------------------------------------------------------------------------

test("restoreConfirmText: names the snapshot's date AND source, warns that current state is preserved", () => {
  const text = restoreConfirmText({ file: "x.json", ts: "2026-07-10T14:02:33.123Z", source: "template-import" });
  assert.match(text, /^Restore snapshot from \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(template-import\)\? Current state is snapshotted first\.$/);
});

test("snapshotWhen: minute-precision local stamp; a garbled ts passes through instead of blanking", () => {
  assert.match(snapshotWhen("2026-07-10T14:02:33.123Z"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(snapshotWhen("not-a-date"), "not-a-date");
});

// ---------------------------------------------------------------------------
// module discipline: DOM controllers are exported functions, never executed at import
// ---------------------------------------------------------------------------

test("DOM controllers load under plain Node without touching document", () => {
  for (const fn of [createBalanceChart, createCashflowTable, renderTrends, initTrends, initSnapshots]) {
    assert.equal(typeof fn, "function");
  }
  assert.ok(TRENDS_EMPTY_COPY.includes("every day you save"));
  assert.ok(STALE_LIST_COPY.includes("try again"));
});

// ---- v5: the cash-flow table's tax column reads r.tax from the engine rows ----

function taxDrawdownState(enabled) {
  const s = placeholderState();
  s.incomes = [];
  s.properties = [];
  s.portfolio.balance = 400_000; // small enough to draw down from year 0
  s.tax = { enabled, effectiveGainsRatePct: 20, embeddedGainPct: 50 };
  return s;
}

test("cashflowView preserves the per-year tax the column renders", () => {
  const shownOn = cashflowView(simulate(taxDrawdownState(true)).rows, true).shown;
  const shownOff = cashflowView(simulate(taxDrawdownState(false)).rows, true).shown;
  assert.ok(shownOn.every((r) => typeof r.tax === "number"), "every row carries a numeric tax");
  assert.ok(shownOn.some((r) => r.tax > 0), "a drawdown year shows a positive tax when enabled");
  assert.ok(shownOff.every((r) => r.tax === 0), "disabled → every tax cell is 0");
});
