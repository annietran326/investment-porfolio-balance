// Import/export card (U8 + U9): download the current state as an .xlsx,
// upload a filled template — preview per tab (counts, cell errors, blocked
// markers, headline deltas), pick tabs, apply — or upload a bank/card
// transaction CSV: mapping step (skipped when a saved mapping matches) +
// sign toggle + sample table, then a derivation preview (complete-months
// window, category averages, modeled-elsewhere flags, excluded-rows report,
// apply-mode choice), then apply.
//
// Both flows: file chosen → client-side checks → pipeline.flushOrCancel() →
// POST raw bytes to the preview endpoint → render panel → Apply
// (flushOrCancel again, then POST apply with the PREVIEW's rev — if the state
// moved since the preview, the 409 correctly invalidates it) → location.reload().
//
// Pure copy helpers live up top (no DOM at module top level — node:test can
// import this file under plain Node); DOM wiring below.
import { el, setText, show } from "./dom.mjs";

export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Client-side pre-checks mirroring the server's cheap rejections, for
 * friendlier copy before any upload. Returns null when the file may be sent.
 * @param {string} name @param {number} size
 */
export function clientFileError(name, size) {
  if (/\.(xlsm|xlsb)$/i.test(name)) {
    return "Macro-enabled workbooks (.xlsm/.xlsb) are not accepted — save as a plain .xlsx first.";
  }
  if (size > IMPORT_MAX_BYTES) return "File is too large — imports are capped at 20 MB.";
  return null;
}

/** "3 added, 1 removed, 2 changed" — or "no changes". @param {{adds: number, removes: number, changes: number}} t */
export function countsCopy(t) {
  const parts = [];
  if (t.adds) parts.push(`${t.adds} added`);
  if (t.removes) parts.push(`${t.removes} removed`);
  if (t.changes) parts.push(`${t.changes} changed`);
  return parts.length ? parts.join(", ") : "no changes";
}

/** @param {number} n */
export function fmtUsd(n) {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** Headline delta line. @param {string} label @param {{before: number, after: number}} d */
export function deltaCopy(label, d) {
  if (d.before === d.after) return `${label}: ${fmtUsd(d.before)} (unchanged)`;
  return `${label}: ${fmtUsd(d.before)} → ${fmtUsd(d.after)}`;
}

export const MISSING_TAB_COPY = "not present — section unchanged";

// ---------------------------------------------------------------------------
// transaction CSV helpers (pure)
// ---------------------------------------------------------------------------

export const TXN_IMPORT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Client-side pre-checks for the transactions flow. Null when sendable.
 * @param {string} name @param {number} size
 */
export function clientCsvError(name, size) {
  if (!/\.csv$/i.test(name)) return "Expected a .csv file — export transactions as CSV from your bank or card.";
  if (size > TXN_IMPORT_MAX_BYTES) return "File is too large — CSV imports are capped at 50 MB.";
  return null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-07" → "Jul 2026". @param {string} ym */
export function fmtMonth(ym) {
  return `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
}

/**
 * Derivation-window line, e.g. "Sep 2025 – Jun 2026, 10 complete months
 * (excluded: partial Jul 2026, partial Aug 2025)".
 * @param {{window: {from: string, to: string, monthsCounted: number}|null, excludedMonths: string[]}} derived
 */
export function windowCopy(derived) {
  if (!derived.window) {
    return "Not enough complete months to derive spending — the earliest month and the current month are both excluded as partial.";
  }
  const { from, to, monthsCounted } = derived.window;
  const range = from === to ? fmtMonth(from) : `${fmtMonth(from)} – ${fmtMonth(to)}`;
  const ex = derived.excludedMonths.map((m) => `partial ${fmtMonth(m)}`).join(", ");
  return `${range}, ${monthsCounted} complete month${monthsCounted === 1 ? "" : "s"}${ex ? ` (excluded: ${ex})` : ""}`;
}

/**
 * Why the sign convention was suggested, e.g. "detected: charges are
 * positive (23 of 25 rows)".
 * @param {{convention: string, negative: number, positive: number, total: number}} s
 */
export function signDetectedCopy(s) {
  const positiveIsCharge = s.convention === "positive-is-charge";
  const label = positiveIsCharge ? "charges are positive" : "spends are negative";
  return `detected: ${label} (${positiveIsCharge ? s.positive : s.negative} of ${s.total} rows)`;
}

/**
 * Excluded-rows report parts, all counted and inspectable.
 * @param {{parsed: number, storedNew: number, dupes: number, refunds: number,
 *   badDates: {count: number, rowNumbers: number[]},
 *   badAmounts: {count: number, rowNumbers: number[]}}} c
 * @returns {string[]}
 */
export function excludedCopy(c) {
  const parts = [`${c.parsed} rows parsed`, `${c.storedNew} new`];
  if (c.dupes) parts.push(`${c.dupes} duplicate${c.dupes === 1 ? "" : "s"} (already stored)`);
  if (c.refunds) parts.push(`${c.refunds} refund/income row${c.refunds === 1 ? "" : "s"}`);
  if (c.badDates.count) parts.push(`${c.badDates.count} unparseable date${c.badDates.count === 1 ? "" : "s"} (rows ${c.badDates.rowNumbers.join(", ")})`);
  if (c.badAmounts.count) parts.push(`${c.badAmounts.count} unparseable amount${c.badAmounts.count === 1 ? "" : "s"} (rows ${c.badAmounts.rowNumbers.join(", ")})`);
  return parts;
}

// ---------------------------------------------------------------------------
// DOM (browser only — called from app.mjs, never at import time)
// ---------------------------------------------------------------------------

/**
 * Build the imports/export card body. fetch/reload/navigation are injectable
 * for tests.
 * @param {HTMLElement} mount
 * @param {{pipeline: {flushOrCancel: () => Promise<any>},
 *   fetchFn?: (url: string, init?: object) => Promise<{status: number, json: () => Promise<any>}>,
 *   reload?: () => void,
 *   navigate?: (url: string) => void}} opts
 */
export function initImports(mount, opts) {
  const pipeline = opts.pipeline;
  const fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
  const reload = opts.reload ?? (() => location.reload());
  const navigate = opts.navigate ?? ((url) => location.assign(url));

  const err = el("div", { class: "issue" });
  const exportBtn = el("button", { type: "button", class: "small" }, "Download my data as spreadsheet");
  exportBtn.addEventListener("click", () => navigate("/api/export/template"));
  const fileInput = /** @type {HTMLInputElement} */ (
    el("input", { type: "file", id: "importTemplateFile", accept: ".xlsx", class: "visually-hidden" })
  );
  const fileLabel = el("label", { class: "filebtn", for: "importTemplateFile" }, "Import spreadsheet (.xlsx)");
  const csvInput = /** @type {HTMLInputElement} */ (
    el("input", { type: "file", id: "importTxnFile", accept: ".csv,text/csv", class: "visually-hidden" })
  );
  const csvLabel = el("label", { class: "filebtn", for: "importTxnFile" }, "Import transactions (.csv)");
  const panel = el("div", { class: "import-preview hidden" });
  const csvErr = el("div", { class: "issue" });
  const csvPanel = el("div", { class: "import-preview hidden" });
  mount.append(
    el("div", { class: "import-actions" }, exportBtn, fileLabel, fileInput, csvLabel, csvInput),
    err,
    panel,
    csvErr,
    csvPanel
  );

  function resetPanel() {
    panel.textContent = "";
    show(panel, false);
    fileInput.value = "";
  }

  fileInput.addEventListener("change", () => void onFile());
  csvInput.addEventListener("change", () => void onCsvFile());

  async function onFile() {
    const file = fileInput.files?.[0];
    if (!file) return;
    setText(err, "");
    panel.textContent = "";
    show(panel, false);
    const clientErr = clientFileError(file.name, file.size);
    if (clientErr) {
      setText(err, clientErr);
      fileInput.value = "";
      return;
    }
    let bytes;
    try {
      bytes = await file.arrayBuffer();
    } catch {
      setText(err, "Could not read that file.");
      fileInput.value = "";
      return;
    }
    await pipeline.flushOrCancel(); // settle any pending save before previewing against the server state
    let res;
    try {
      res = await fetchFn(`/api/import/template/preview?filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
      });
    } catch {
      setText(err, "Preview failed — is the server still running?");
      fileInput.value = "";
      return;
    }
    const body = await res.json().catch(() => null);
    if (res.status !== 200 || !body?.preview || typeof body.token !== "string") {
      // Distinct server rejections (bounds, macro content, no recognized
      // tabs, oversized) each arrive with their own message.
      setText(err, body?.errors?.map((/** @type {any} */ e) => e.message).join("; ") || `Preview failed (HTTP ${res.status}).`);
      fileInput.value = "";
      return;
    }
    renderPreview(file.name, body);
  }

  /** @param {string} name @param {{preview: any, token: string, rev: number}} body */
  function renderPreview(name, body) {
    const { preview, token, rev } = body;
    /** @type {Set<string>} */
    const selected = new Set();
    const applyBtn = /** @type {HTMLButtonElement} */ (el("button", { type: "button" }, "Apply"));
    const cancelBtn = /** @type {HTMLButtonElement} */ (el("button", { type: "button", class: "small" }, "Cancel"));
    const applyNote = el("span", { class: "issue" });
    cancelBtn.addEventListener("click", resetPanel);

    const blocked = new Set(preview.tabs.filter((/** @type {any} */ t) => t.status === "blocked").map((/** @type {any} */ t) => t.key));
    function refreshApply() {
      const blockedSelected = [...selected].some((k) => blocked.has(k));
      applyBtn.disabled = selected.size === 0 || blockedSelected;
      setText(applyNote, blockedSelected ? "Untick the blocked tabs (or fix the cells and re-import) to apply." : "");
    }

    panel.appendChild(
      el("div", { class: "dim" }, `Preview of ${name} — each ticked tab replaces its whole section.`)
    );
    const list = el("div", { class: "import-tabs" });
    for (const t of preview.tabs) {
      const row = el("div", { class: "import-tab" });
      if (t.status === "missing") {
        row.append(el("span", { class: "import-tab-name dim" }, t.label), el("span", { class: "dim" }, MISSING_TAB_COPY));
        list.appendChild(row);
        continue;
      }
      const cb = /** @type {HTMLInputElement} */ (el("input", { type: "checkbox" }));
      if (t.status === "ready") {
        cb.checked = true;
        selected.add(t.key);
      }
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(t.key);
        else selected.delete(t.key);
        refreshApply();
      });
      row.appendChild(el("label", { class: "import-tab-name" }, cb, t.label));
      if (t.status === "blocked") {
        row.appendChild(el("span", { class: "snapshot-chip import-blocked" }, "blocked"));
        const errs = el("div", { class: "import-errors" });
        for (const ce of t.errors) errs.appendChild(el("div", { class: "issue" }, `${ce.cell}: ${ce.message}`));
        row.appendChild(errs);
      } else {
        row.appendChild(el("span", { class: "dim" }, countsCopy(t)));
      }
      list.appendChild(row);
    }
    panel.appendChild(list);
    panel.appendChild(
      el(
        "div",
        { class: "import-headline mono" },
        `${deltaCopy("Total balance", preview.headline.totalBalance)} · ${deltaCopy("Monthly spend", preview.headline.monthlySpend)}`
      )
    );
    panel.appendChild(el("div", { class: "import-actions" }, applyBtn, cancelBtn, applyNote));
    refreshApply();
    show(panel, true);

    applyBtn.addEventListener("click", () => void apply());

    async function apply() {
      applyBtn.disabled = true;
      cancelBtn.disabled = true;
      setText(err, "");
      try {
        await pipeline.flushOrCancel(); // settle any pending save before mutating server-side
        const res = await fetchFn("/api/import/template/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, tabs: [...selected], baseRev: rev }),
        });
        if (res.status === 200) {
          reload(); // full reload re-fetches state cleanly — nothing else to render
          return;
        }
        if (res.status === 409) {
          setText(err, "Your data changed since this preview — choose the file again.");
          resetPanel();
          return;
        }
        if (res.status === 410) {
          setText(err, "This preview expired — choose the file again.");
          resetPanel();
          return;
        }
        const body = await res.json().catch(() => null);
        setText(
          err,
          body?.errors?.map((/** @type {any} */ e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join("; ") ||
            `Import failed (HTTP ${res.status}).`
        );
      } catch {
        setText(err, "Import failed — is the server still running?");
      }
      applyBtn.disabled = false;
      cancelBtn.disabled = false;
      refreshApply();
    }
  }

  // -------------------------------------------------------------------------
  // transaction CSV flow (U9)
  // -------------------------------------------------------------------------

  let csvText = "";
  let csvName = "";

  function resetCsvPanel() {
    csvPanel.textContent = "";
    show(csvPanel, false);
    csvInput.value = "";
    csvText = "";
    csvName = "";
  }

  async function onCsvFile() {
    const file = csvInput.files?.[0];
    if (!file) return;
    setText(csvErr, "");
    csvPanel.textContent = "";
    show(csvPanel, false);
    const clientErr = clientCsvError(file.name, file.size);
    if (clientErr) {
      setText(csvErr, clientErr);
      csvInput.value = "";
      return;
    }
    try {
      csvText = await file.text();
    } catch {
      setText(csvErr, "Could not read that file.");
      csvInput.value = "";
      return;
    }
    csvName = file.name;
    await previewCsv({});
  }

  /**
   * POST the held CSV text with optional explicit mapping/sign params and
   * render the result. Re-invoked whenever the user changes a dropdown or
   * the sign toggle.
   * @param {Record<string, string>} params
   */
  async function previewCsv(params) {
    setText(csvErr, "");
    await pipeline.flushOrCancel(); // settle any pending save before previewing against the server state
    const query = new URLSearchParams(params).toString();
    let res;
    try {
      res = await fetchFn(`/api/import/transactions/preview${query ? `?${query}` : ""}`, {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: csvText,
      });
    } catch {
      setText(csvErr, "Preview failed — is the server still running?");
      resetCsvPanel();
      return;
    }
    const body = await res.json().catch(() => null);
    if (res.status !== 200 || !body?.preview) {
      // Non-destructive: keep the current panel (mapping picks survive) so
      // the user can adjust; allow re-picking the same file.
      setText(csvErr, body?.errors?.map((/** @type {any} */ e) => e.message).join("; ") || `Preview failed (HTTP ${res.status}).`);
      csvInput.value = "";
      return;
    }
    renderCsvPreview(body);
  }

  /** @param {{preview: any, token?: string, rev: number}} body */
  function renderCsvPreview(body) {
    const { preview, token, rev } = body;
    csvPanel.textContent = "";
    csvPanel.appendChild(el("div", { class: "dim" }, `Preview of ${csvName}`));
    for (const note of preview.notes ?? []) csvPanel.appendChild(el("div", { class: "issue is-warning" }, note));

    // --- mapping step + sign toggle -----------------------------------------
    const mapping = preview.mapping;
    /** @type {Record<string, HTMLSelectElement>} */
    const selects = {};
    const mapGrid = el("div", { class: "txn-map" });
    for (const role of ["date", "amount", "description", "category"]) {
      const field = el("div", { class: "field" });
      const sel = /** @type {HTMLSelectElement} */ (el("select", { "aria-label": `${role} column` }));
      if (role === "category") sel.appendChild(el("option", { value: "" }, "(none)"));
      else sel.appendChild(el("option", { value: "" }, "— choose —"));
      for (const h of preview.headers) sel.appendChild(el("option", { value: h }, h));
      sel.value = mapping[role] ?? "";
      // Re-preview only once date+amount+description are all chosen — a
      // half-picked mapping has nothing to compute yet.
      sel.addEventListener("change", () => {
        const p = currentParams();
        if (p.date && p.amount && p.description) void previewCsv(p);
      });
      selects[role] = sel;
      field.append(el("label", {}, `${role} column`), sel);
      mapGrid.appendChild(field);
    }

    const signWrap = el("div", { class: "import-actions" });
    /** @type {HTMLInputElement[]} */
    const signRadios = [];
    const signValue = preview.signConvention?.value ?? "positive-is-charge";
    for (const [value, label] of [
      ["negative-is-spend", "spends are negative (bank export)"],
      ["positive-is-charge", "charges are positive (card export)"],
    ]) {
      const radio = /** @type {HTMLInputElement} */ (el("input", { type: "radio", name: "txnSign", value }));
      radio.checked = value === signValue;
      radio.addEventListener("change", () => {
        const p = currentParams();
        if (p.date && p.amount && p.description) void previewCsv(p);
      });
      signRadios.push(radio);
      signWrap.appendChild(el("label", { class: "txn-radio" }, radio, label));
    }

    function currentParams() {
      /** @type {Record<string, string>} */
      const p = {};
      for (const role of ["date", "amount", "description"]) {
        if (selects[role].value) p[role] = selects[role].value;
      }
      if (selects.category.value) p.category = selects.category.value;
      const sign = signRadios.find((r) => r.checked);
      if (sign) p.sign = sign.value;
      return p;
    }

    const mapSection = el("div", {});
    if (preview.mappingSource === "stale-saved") {
      mapSection.appendChild(
        el("div", { class: "issue is-warning" }, "Saved column mapping no longer matches this file — using suggestions instead.")
      );
    }
    if (preview.mappingSource === "saved" && !preview.missing?.length) {
      // Saved mapping matched — skip the mapping step, offer a way back in.
      const changeBtn = el("button", { type: "button", class: "linklike" }, "(change)");
      const editor = el("div", { class: "hidden" }, mapGrid);
      changeBtn.addEventListener("click", () => show(editor, true));
      mapSection.append(el("div", { class: "dim" }, "using saved mapping ✓ ", changeBtn), editor);
    } else {
      mapSection.appendChild(mapGrid);
    }
    csvPanel.appendChild(mapSection);

    if (preview.missing?.length) {
      // Degenerate: some role (e.g. date) has no mappable column — explicit,
      // and nothing below can render until the user picks columns.
      csvPanel.appendChild(
        el("div", { class: "issue" }, `No ${preview.missing.join(", ")} column could be mapped — pick the column${preview.missing.length === 1 ? "" : "s"} above.`)
      );
      show(csvPanel, true);
      return;
    }

    if (preview.signConvention?.suggestion) {
      signWrap.appendChild(el("span", { class: "dim" }, signDetectedCopy(preview.signConvention.suggestion)));
    }
    csvPanel.appendChild(signWrap);

    // --- sample table (catch date-format and sign errors by eye) ------------
    const sample = el("table", { class: "txn-sample" });
    sample.appendChild(
      el("thead", {}, el("tr", {}, el("th", {}, "date"), el("th", {}, "amount"), el("th", {}, "description"), el("th", {}, "")))
    );
    const tbody = el("tbody", {});
    for (const r of preview.sampleRows ?? []) {
      const amt = r.excluded === "unparseable-date" || r.excluded === "unparseable-amount" ? "—" : fmtSignedUsd(r.amount);
      tbody.appendChild(
        el(
          "tr",
          { class: r.excluded ? "dim" : "" },
          el("td", {}, String(r.date)),
          el("td", {}, amt),
          el("td", { class: "name" }, r.description),
          el("td", { class: "dim" }, r.excluded ? `excluded: ${r.excluded}` : "")
        )
      );
    }
    sample.appendChild(tbody);
    csvPanel.append(el("div", { class: "dim" }, "First rows as parsed — check dates and signs:"), sample);

    // --- counts + excluded report -------------------------------------------
    const counts = preview.counts;
    csvPanel.appendChild(el("div", { class: "mono import-headline" }, excludedCopy(counts).join(" · ")));
    if (counts.ambiguity) csvPanel.appendChild(el("div", { class: "issue is-warning" }, counts.ambiguity.message));
    if (counts.parsed > 0 && counts.storedNew === 0 && counts.refunds === counts.parsed) {
      csvPanel.appendChild(
        el("div", { class: "issue is-warning" }, "Every row normalized to a refund — all amounts are one sign; try flipping the sign convention.")
      );
    }

    // --- derivation preview ---------------------------------------------------
    const derived = preview.derived;
    csvPanel.appendChild(el("div", { class: "dim" }, `Derived monthly spending — ${windowCopy(derived)}`));

    /** @type {Map<string, HTMLInputElement>} */
    const includeBoxes = new Map();
    if (derived.categories.length === 0) {
      csvPanel.appendChild(el("div", { class: "dim" }, "No categories derivable yet — import a span covering at least three months (first and current are excluded)."));
    } else {
      const table = el("table", { class: "txn-cats" });
      table.appendChild(
        el(
          "thead",
          {},
          el("tr", {}, el("th", {}, "include"), el("th", {}, "category"), el("th", {}, "$/mo avg"), el("th", {}, "months"), el("th", {}, "total"), el("th", {}, ""))
        )
      );
      const catBody = el("tbody", {});
      for (const c of derived.categories) {
        const cb = /** @type {HTMLInputElement} */ (el("input", { type: "checkbox" }));
        cb.checked = !c.flagged; // default: flagged = excluded; the user can untick/tick
        includeBoxes.set(c.name, cb);
        catBody.appendChild(
          el(
            "tr",
            {},
            el("td", { class: "txn-include" }, cb),
            el("td", { class: "name" }, c.name),
            el("td", {}, fmtUsd(c.monthly)),
            el("td", {}, String(c.months)),
            el("td", {}, fmtUsd(c.total)),
            el("td", {}, c.flagged ? el("span", { class: "snapshot-chip txn-flagged" }, "modeled elsewhere — excluded") : el("span", {}))
          )
        );
      }
      table.appendChild(catBody);
      csvPanel.appendChild(table);
    }

    // --- apply mode + actions -------------------------------------------------
    /** @type {HTMLInputElement[]} */
    const modeRadios = [];
    const modeWrap = el("div", { class: "import-actions" });
    for (const [value, label] of [
      ["replace-all", "replace all spending"],
      ["update-matching-names", "update matching names"],
      ["add-new-only", "add new only"],
    ]) {
      const radio = /** @type {HTMLInputElement} */ (el("input", { type: "radio", name: "txnMode", value }));
      radio.checked = value === "update-matching-names";
      modeRadios.push(radio);
      modeWrap.appendChild(el("label", { class: "txn-radio" }, radio, label));
    }

    const applyBtn = /** @type {HTMLButtonElement} */ (el("button", { type: "button" }, "Apply"));
    const cancelBtn = /** @type {HTMLButtonElement} */ (el("button", { type: "button", class: "small" }, "Cancel"));
    cancelBtn.addEventListener("click", resetCsvPanel);
    applyBtn.disabled = typeof token !== "string";
    csvPanel.append(modeWrap, el("div", { class: "import-actions" }, applyBtn, cancelBtn));
    show(csvPanel, true);

    applyBtn.addEventListener("click", () => void applyCsv());

    async function applyCsv() {
      applyBtn.disabled = true;
      cancelBtn.disabled = true;
      setText(csvErr, "");
      const includeCategories = [...includeBoxes.entries()].filter(([, cb]) => cb.checked).map(([name]) => name);
      const mode = modeRadios.find((r) => r.checked)?.value ?? "update-matching-names";
      try {
        await pipeline.flushOrCancel(); // settle any pending save before mutating server-side
        const res = await fetchFn("/api/import/transactions/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, mode, includeCategories, baseRev: rev }),
        });
        if (res.status === 200) {
          reload(); // full reload re-fetches state cleanly — nothing else to render
          return;
        }
        if (res.status === 409) {
          setText(csvErr, "Your data changed since this preview — choose the file again.");
          resetCsvPanel();
          return;
        }
        if (res.status === 410) {
          setText(csvErr, "This preview expired — choose the file again.");
          resetCsvPanel();
          return;
        }
        const resBody = await res.json().catch(() => null);
        setText(
          csvErr,
          resBody?.errors?.map((/** @type {any} */ e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join("; ") ||
            `Import failed (HTTP ${res.status}).`
        );
      } catch {
        setText(csvErr, "Import failed — is the server still running?");
      }
      applyBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  }
}

/** Signed dollars for the sample table: spends positive, refunds negative. @param {number} n */
function fmtSignedUsd(n) {
  const cents = Math.round(Math.abs(n) * 100) % 100;
  const body = `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0 })}`;
  return n < 0 ? `−${body}` : body;
}
