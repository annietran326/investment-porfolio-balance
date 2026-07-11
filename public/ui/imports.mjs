// Spreadsheet import/export card (U8): download the current state as an
// .xlsx, or upload a filled template — preview per tab (counts, cell errors,
// blocked markers, headline deltas), pick tabs, apply.
//
// Flow: file chosen → client-side filename/size checks → pipeline.flushOrCancel()
// → POST raw bytes to /api/import/template/preview → render panel → Apply
// (flushOrCancel again, then POST apply with the PREVIEW's rev — if the state
// moved since the preview, the 409 correctly invalidates it) → location.reload().
//
// U9 (transaction CSV import) will extend this module with a second entry
// point on the same card.
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
  const panel = el("div", { class: "import-preview hidden" });
  mount.append(el("div", { class: "import-actions" }, exportBtn, fileLabel, fileInput), err, panel);

  function resetPanel() {
    panel.textContent = "";
    show(panel, false);
    fileInput.value = "";
  }

  fileInput.addEventListener("change", () => void onFile());

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
}
