// Browser entry point — thin DOM wiring over the pure modules. The engine and
// model are imported DIRECTLY into the browser: every state change re-runs the
// simulation and solver locally (instant), and saves flow through the
// debounced, serialized save pipeline.
//
// Rendering discipline: form inputs update in place (typing never loses focus
// or characters); results/verdict/table re-render on every state change; row
// lists rebuild only on add/remove. All user-controlled strings land via
// .value / .textContent — never innerHTML.
import { simulate } from "/engine/simulate.mjs";
import { requiredIncome } from "/engine/solver.mjs";
import { SCENARIOS } from "/engine/scenarios.mjs";
import { validate, PLAN_TO_AGE_PRESETS } from "/model/schema.mjs";
import { qs, el, setText, show } from "./ui/dom.mjs";
import { verdictCopy, fmtCompact, requiredCell, runwayCell } from "./ui/verdict.mjs";
import { createSavePipeline } from "./ui/save.mjs";
import {
  addRow,
  removeRow,
  setRowValue,
  setValueAtPath,
  setEndStateMode,
  setEndStateAmount,
  endStateAmountValue,
  parseNumField,
  renderRows,
} from "./ui/forms.mjs";

const JSON_HEADERS = { "Content-Type": "application/json" };

const boot = await (await fetch("/api/state")).json();
let state = boot.state;
const seededAtLoad = boot.seeded === true;
let placeholderBannerLive = false;

const pipeline = createSavePipeline({
  fetchFn: (url, init) => fetch(url, init),
  initialRev: boot.rev,
  debounceMs: 1500,
  onState: renderBadge,
});

const LISTS = {
  properties: { container: qs("#propList"), template: qs("#tpl-property"), addBtn: qs("#addProp") },
  incomes: { container: qs("#incomeList"), template: qs("#tpl-income"), addBtn: qs("#addIncome") },
  spending: { container: qs("#spendList"), template: qs("#tpl-spend"), addBtn: qs("#addSpend") },
};

// ---------------------------------------------------------------------------
// state → DOM
// ---------------------------------------------------------------------------

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => o?.[k], obj);
}

/** Set an input's value from state — but NEVER touch the element being typed in. */
function setValueIfIdle(input, v) {
  if (document.activeElement === input) return;
  const next = v === null || v === undefined ? "" : String(v);
  if (input.value !== next) input.value = next;
}

/** Sync every scalar control from state (presets, sliders, end-state field). */
function syncScalars() {
  for (const input of document.querySelectorAll("[data-path]")) {
    setValueIfIdle(input, getPath(state, input.dataset.path));
  }
  for (const btn of qs("#agePresets").querySelectorAll("button")) {
    btn.classList.toggle("active", Number(btn.dataset.preset) === state.profile.endAge);
  }
  const mode = state.endState.mode;
  setValueIfIdle(qs("#endMode"), mode);
  show(qs("#endAmountField"), mode !== "zero");
  if (mode !== "zero") {
    setText(qs("#endAmountLabel"), mode === "bequest" ? "Bequest amount ($)" : "Floor amount ($)");
    setValueIfIdle(qs("#endAmount"), endStateAmountValue(state));
  }
}

function renderList(kind) {
  const { container, template } = LISTS[kind];
  renderRows(container, /** @type {HTMLTemplateElement} */ (template), state[kind], {
    onField: (index, key, raw, isText) => {
      commit(setRowValue(state, kind, index, key, isText ? raw : parseNumField(raw)));
    },
    onRemove: (index) => commit(removeRow(state, kind, index), kind),
  });
}

// ---------------------------------------------------------------------------
// validation issues → field slots
// ---------------------------------------------------------------------------

function issueSlotNear(input) {
  const field = input.closest(".field");
  if (field) {
    const slot = field.querySelector(".issue");
    if (slot) return slot;
  }
  const head = input.closest(".head");
  if (head && head.nextElementSibling?.classList.contains("issue")) return head.nextElementSibling;
  return null;
}

function issueSlotFor(path) {
  const m = /^(properties|incomes|spending)\[(\d+)\]\.(\w+)$/.exec(path);
  if (m) {
    const row = LISTS[m[1]].container.children[Number(m[2])];
    const input = row?.querySelector(`[data-key="${m[3]}"]`);
    return input ? issueSlotNear(input) : null;
  }
  if (path === "endState.mode") return issueSlotNear(qs("#endMode"));
  if (path.startsWith("endState.amounts")) return issueSlotNear(qs("#endAmount"));
  const input = document.querySelector(`[data-path="${CSS.escape(path)}"]`);
  return input ? issueSlotNear(input) : null;
}

function renderIssues(errors, warnings) {
  for (const slot of document.querySelectorAll(".issue")) {
    slot.textContent = "";
    slot.classList.remove("is-warning");
  }
  const globalBox = qs("#globalIssues");
  globalBox.textContent = "";
  const paint = (issue, isWarning) => {
    const slot = issueSlotFor(issue.path);
    if (!slot) {
      globalBox.appendChild(
        el("div", { class: isWarning ? "issue is-warning" : "issue" }, `${issue.path}: ${issue.message}`)
      );
      return;
    }
    slot.textContent = issue.message;
    slot.classList.toggle("is-warning", isWarning);
  };
  for (const w of warnings) paint(w, true); // errors painted last — they win the slot
  for (const e of errors) paint(e, false);
}

// ---------------------------------------------------------------------------
// results (verdict, KPIs, scenario table) — re-rendered on every valid change
// ---------------------------------------------------------------------------

function setKpi(sel, text, cls) {
  const node = qs(sel);
  node.className = cls ? `v ${cls}` : "v";
  setText(node, text);
}

function renderResults() {
  const results = SCENARIOS.map((sc) => ({
    label: sc.label,
    sim: simulate(state, sc.overlay, 0),
    req: requiredIncome(state, sc.overlay),
  }));
  const base = results[0];

  const copy = verdictCopy(base.req, state);
  const verdict = qs("#verdict");
  verdict.classList.toggle("good", copy.tone === "good");
  verdict.classList.toggle("bad", copy.tone === "bad");
  setText(qs("#verdictHeadline"), copy.headline);
  setText(qs("#verdictDetail"), copy.detail);

  const run = runwayCell(base.sim);
  setKpi("#kpiRunway", run.text, run.cls === "neg" ? "warn" : run.cls);
  const req = requiredCell(base.req);
  setKpi("#kpiRequired", req.text, req.cls);
  setText(qs("#kpiRequiredLabel"), `required income → age ${state.work.untilAge}`);
  setKpi("#kpiEndBal", fmtCompact(base.sim.endBal), base.sim.endBal >= 0 ? "pos" : "neg");
  setText(qs("#kpiEndBalLabel"), `end balance @ ${state.profile.endAge} (no extra income)`);
  const annualSpend = state.spending.reduce((sum, c) => sum + (typeof c.monthly === "number" ? c.monthly : 0), 0) * 12;
  setKpi("#kpiSpend", fmtCompact(annualSpend), "");

  setText(qs("#thRequired"), `Required $/yr → age ${state.work.untilAge}`);
  const tbody = qs("#scenarioRows");
  tbody.textContent = "";
  for (const r of results) {
    const rc = runwayCell(r.sim);
    const qc = requiredCell(r.req);
    tbody.appendChild(
      el(
        "tr",
        {},
        el("td", { class: "name" }, r.label),
        el("td", { class: rc.cls }, rc.text),
        el("td", { class: qc.cls }, qc.text)
      )
    );
  }
}

// ---------------------------------------------------------------------------
// the single write path
// ---------------------------------------------------------------------------

/**
 * Every edit funnels through here: swap state, keep controls in sync,
 * validate (errors block the PUT but never the render), then queue the save.
 * @param {object} next @param {string} [rebuildKind] list to rebuild (add/remove only)
 */
function commit(next, rebuildKind) {
  state = next;
  if (placeholderBannerLive) {
    show(qs("#placeholderBanner"), false); // example-data banner dismisses on first edit
    placeholderBannerLive = false;
  }
  if (rebuildKind) renderList(rebuildKind);
  syncScalars();
  const { errors, warnings } = validate(state);
  renderIssues(errors, warnings);
  if (errors.length) {
    pipeline.markInvalid(`${errors[0].path}: ${errors[0].message}`);
  } else {
    renderResults();
    pipeline.edit(state);
  }
}

// ---------------------------------------------------------------------------
// save badge + conflict banner
// ---------------------------------------------------------------------------

const BADGE_TEXT = { idle: "", pending: "unsaved changes", saving: "Saving…", saved: "Saved" };

function renderBadge(snap) {
  const badge = qs("#saveBadge");
  if (snap.status === "conflict") {
    show(badge, false);
    show(qs("#conflictBanner"), true);
    return;
  }
  let text = BADGE_TEXT[snap.status];
  if (snap.status === "error") text = snap.message ? `Save failed — ${snap.message}` : "Save failed";
  if (snap.status === "invalid") text = `Not saved — ${snap.message}`;
  setText(qs("#saveBadgeText"), text ?? "");
  show(qs("#btnRetry"), snap.status === "error");
  badge.className = `badge ${snap.status}`;
  const firstRunQuiet = !seededAtLoad && !snap.everSaved && (snap.status === "pending" || snap.status === "saving");
  show(badge, snap.status !== "idle" && !firstRunQuiet);
}

// ---------------------------------------------------------------------------
// recovery panel (server quarantined a corrupt current.json)
// ---------------------------------------------------------------------------

function renderRecovery(recovery) {
  setText(qs("#recoveryDetail"), `Damaged file preserved as ${recovery.quarantinedAs}.`);
  const list = qs("#recoveryList");
  list.textContent = "";
  for (const snap of recovery.snapshots) {
    const btn = el("button", { type: "button", class: "small" }, "Restore");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      setText(qs("#recoveryError"), "");
      try {
        const res = await fetch("/api/restore", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ file: snap.file, baseRev: pipeline.rev() }),
        });
        if (res.ok) {
          location.reload();
          return;
        }
        setText(qs("#recoveryError"), `Restore failed (HTTP ${res.status}).`);
      } catch {
        setText(qs("#recoveryError"), "Restore failed — is the server still running?");
      }
      btn.disabled = false;
    });
    list.appendChild(
      el(
        "div",
        { class: "snapshot-row" },
        el("span", { class: "mono" }, new Date(snap.ts).toLocaleString()),
        el("span", { class: "dim" }, snap.source),
        btn
      )
    );
  }
  show(qs("#recoveryPanel"), true);
}

// ---------------------------------------------------------------------------
// static wiring (runs once)
// ---------------------------------------------------------------------------

function buildStaticBindings() {
  // scalar fields (number inputs + range sliders share data-path; syncScalars links them)
  for (const input of document.querySelectorAll("[data-path]")) {
    input.addEventListener("input", () => {
      commit(setValueAtPath(state, input.dataset.path, parseNumField(input.value)));
    });
  }

  // plan-to-age preset segmented control — sets the endAge field, which stays editable
  const presets = qs("#agePresets");
  for (const age of PLAN_TO_AGE_PRESETS) {
    const btn = el("button", { type: "button", "data-preset": String(age) }, String(age));
    btn.addEventListener("click", () => commit(setValueAtPath(state, "profile.endAge", age)));
    presets.appendChild(btn);
  }

  // end state: mode select + amount bound to amounts[mode] (preserved across switches)
  qs("#endMode").addEventListener("change", (e) => commit(setEndStateMode(state, e.target.value)));
  qs("#endAmount").addEventListener("input", (e) => commit(setEndStateAmount(state, parseNumField(e.target.value))));

  // row lists
  for (const kind of Object.keys(LISTS)) {
    LISTS[kind].addBtn.addEventListener("click", () => commit(addRow(state, kind), kind));
  }

  qs("#btnRetry").addEventListener("click", () => pipeline.retry());
  qs("#btnReload").addEventListener("click", () => location.reload());

  // reset: snapshot current, delete it, return to the unseeded placeholder
  qs("#btnReset").addEventListener("click", async () => {
    if (!confirm("Reset all data? Today's numbers are preserved as a snapshot; the app returns to example data.")) return;
    pipeline.cancel(); // the pending queue is describing data we're discarding
    try {
      const res = await fetch("/api/reset", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ baseRev: pipeline.rev() }),
      });
      if (res.ok) {
        location.reload();
        return;
      }
      if (res.status === 409) {
        show(qs("#conflictBanner"), true);
        return;
      }
      alert(`Reset failed (HTTP ${res.status}).`);
    } catch {
      alert("Reset failed — is the server still running?");
    }
  });

  // corrupt-recovery "start fresh": placeholder is already live in memory —
  // just drop the panel and adopt unseeded semantics (first edit seeds).
  qs("#btnStartFresh").addEventListener("click", () => {
    show(qs("#recoveryPanel"), false);
    placeholderBannerLive = true;
    show(qs("#placeholderBanner"), true);
  });

  // v0 import from the unseeded banner
  qs("#importV0").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const errEl = qs("#importError");
    setText(errEl, "");
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      setText(errEl, "That file is not valid JSON.");
      return;
    }
    await pipeline.flushOrCancel(); // settle any pending save before mutating server-side
    try {
      const res = await fetch("/api/import/v0", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ data, baseRev: pipeline.rev() }),
      });
      if (res.ok) {
        location.reload();
        return;
      }
      if (res.status === 409) {
        show(qs("#conflictBanner"), true);
        return;
      }
      const body = await res.json().catch(() => null);
      setText(errEl, body?.errors?.map((er) => er.message).join("; ") || `Import failed (HTTP ${res.status}).`);
    } catch {
      setText(errEl, "Import failed — is the server still running?");
    }
  });

  // flush a pending debounced edit on the way out (sendBeacon can't set the
  // required application/json content-type, so fetch keepalive it is)
  window.addEventListener("pagehide", () => pipeline.flushKeepalive());
  window.addEventListener("beforeunload", () => pipeline.flushKeepalive());
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

buildStaticBindings();
for (const kind of Object.keys(LISTS)) renderList(kind);
syncScalars();
{
  const { errors, warnings } = validate(state);
  renderIssues(errors, warnings);
  if (!errors.length) renderResults(); // verdict is NEVER blank on load
}
if (boot.recovery) {
  renderRecovery(boot.recovery); // placeholder renders underneath — the app stays alive
} else if (!boot.seeded) {
  placeholderBannerLive = true;
  show(qs("#placeholderBanner"), true);
}
