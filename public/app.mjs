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
import { requiredIncome, requiredSavings } from "/engine/solver.mjs";
import { BUCKET_KEYS } from "/engine/buckets.mjs";
import { SCENARIOS } from "/engine/scenarios.mjs";
import { validate, PLAN_TO_AGE_PRESETS, totalBalance } from "/model/schema.mjs";
import { qs, el, setText, show } from "./ui/dom.mjs";
import { verdictCopy, fmtCompact, fmtMoney, fmtPct, requiredCell, gapCell, runwayCell, errorsText } from "./ui/verdict.mjs";
import { createSavePipeline } from "./ui/save.mjs";
import { createBalanceChart, createCashflowTable } from "./ui/charts.mjs";
import { initTrends } from "./ui/trends.mjs";
import { initSnapshots } from "./ui/snapshots.mjs";
import { initImports } from "./ui/imports.mjs";
import { initScenarioBar } from "./ui/scenarios.mjs";
import {
  addRow,
  removeRow,
  setRowValue,
  setValueAtPath,
  setEndStateMode,
  setEndStateAmount,
  endStateAmountValue,
  parseNumField,
  parseRowField,
  gainShareOf,
  renderRows,
  addPerson,
  removePerson,
  setPersonField,
  renderPeople,
} from "./ui/forms.mjs";

const JSON_HEADERS = { "Content-Type": "application/json" };

const boot = await (await fetch("/api/state")).json();
let state = boot.state;
const seededAtLoad = boot.seeded === true;
let seeded = seededAtLoad; // mutable: create/import seed on the server; the bar reads this
let scenarios = boot.scenarios ?? [];
let activeId = boot.activeId ?? "";
let placeholderBannerLive = false;

const pipeline = createSavePipeline({
  fetchFn: (url, init) => fetch(url, init),
  initialRev: boot.rev,
  debounceMs: 1500,
  onState: renderBadge,
});

const LISTS = {
  accounts: { container: qs("#accountList"), template: qs("#tpl-account"), addBtn: qs("#addAccount") },
  properties: { container: qs("#propList"), template: qs("#tpl-property"), addBtn: qs("#addProp") },
  incomes: { container: qs("#incomeList"), template: qs("#tpl-income"), addBtn: qs("#addIncome") },
  spending: { container: qs("#spendList"), template: qs("#tpl-spend"), addBtn: qs("#addSpend") },
};

const PEOPLE = {
  container: qs("#peopleList"),
  templates: { spouse: qs("#tpl-person-spouse"), dependent: qs("#tpl-person-dependent") },
};

// U7 chart controllers — built once; renderResults() feeds them on every
// valid change, so legend toggles and the hover readout survive re-renders.
const balanceChart = createBalanceChart(qs("#balanceChart"));
const cashflow = createCashflowTable(qs("#cashflowTable"));

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
    if (input.type === "checkbox") input.checked = !!getPath(state, input.dataset.path);
    else setValueIfIdle(input, getPath(state, input.dataset.path));
  }
  syncDerivedNotes();
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
      commit(setRowValue(state, kind, index, key, parseRowField(kind, key, raw, isText)));
    },
    onRemove: (index) => commit(removeRow(state, kind, index), kind),
  });
  if (kind === "accounts") syncAccountRows();
}

/**
 * Per-account display touches that depend on the row's values: which fields
 * show for its type, and the live "taxable gain today" readout. Runs on every
 * commit, updating in place (never rebuilding, so typing keeps focus).
 */
function syncAccountRows() {
  const rows = LISTS.accounts.container.children;
  state.accounts.forEach((a, i) => {
    const row = rows[i];
    if (!row) return;
    row.dataset.type = a.type;
    row.dataset.invest = a.invest;
    const readout = row.querySelector('[data-readout="gainShare"]');
    if (readout) {
      const g = gainShareOf(a);
      readout.textContent = g === null ? "—" : `${fmtPct(g)} of the balance`;
    }
  });
}

/** Small helper notes derived from the inputs (after-inflation returns, the bucket rule). */
function syncDerivedNotes() {
  const b = state.buckets;
  const inf = state.economy.inflationPct;
  const nums = [b.preservationReturnPct, b.incomeReturnPct, b.equitiesReturnPct, inf];
  if (nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
    const real = (/** @type {number} */ r) => (((1 + r / 100) / (1 + inf / 100) - 1) * 100).toFixed(1);
    setText(qs("#realReturnsNote"), `After ${inf}% inflation: ${real(b.preservationReturnPct)}% / ${real(b.incomeReturnPct)}% / ${real(b.equitiesReturnPct)}%.`);
  } else setText(qs("#realReturnsNote"), "");
  if (typeof b.preservationYears === "number" && typeof b.incomeThroughYear === "number") {
    setText(
      qs("#bucketRuleNote"),
      `Withdrawals in years 1–${b.preservationYears} sit in capital preservation, years ${b.preservationYears + 1}–${b.incomeThroughYear} in high income, and everything after year ${b.incomeThroughYear} in global equities. Money you need soonest is kept safe, so a market drop never forces you to sell stocks.`
    );
  }
}

// Household field parse: name (text) passes through; every numeric field —
// nullable currentAge and the required SS/health numbers alike — goes through
// parseNumField, so empty → null (meaningful for age, a validate() error for
// the required ones) and is never silently coerced to 0.
function renderPeopleList() {
  renderPeople(
    PEOPLE.container,
    /** @type {any} */ (PEOPLE.templates),
    state.household.people,
    {
      onField: (index, field, raw, isText) => {
        commit(setPersonField(state, index, field, isText ? raw : parseNumField(raw)));
      },
      onRemove: (index) => commit(removePerson(state, index), "people"),
    }
  );
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
  const m = /^(accounts|properties|incomes|spending)\[(\d+)\]\.(\w+)$/.exec(path);
  if (m) {
    const row = LISTS[m[1]].container.children[Number(m[2])];
    const input = row?.querySelector(`[data-key="${m[3]}"]`);
    return input ? issueSlotNear(input) : null;
  }
  // household.people[i].name | .currentAge | .social.startAge | .health.postMedicareAnnual
  const hp = /^household\.people\[(\d+)\]\.(.+)$/.exec(path);
  if (hp) {
    const row = PEOPLE.container.children[Number(hp[1])];
    if (!row) return null;
    const input = row.querySelector(`[data-field="${CSS.escape(hp[2])}"]`);
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
    key: sc.key,
    label: sc.label,
    sim: simulate(state, sc.overlay, 0),
    gap: requiredSavings(state, sc.overlay),
    req: requiredIncome(state, sc.overlay),
  }));
  const base = results[0];

  // Verdict: do I have enough, and if not, the gap.
  const copy = verdictCopy(base.gap, base.req, state, base.sim.endBal);
  const verdict = qs("#verdict");
  verdict.classList.toggle("good", copy.tone === "good");
  verdict.classList.toggle("bad", copy.tone === "bad");
  setText(qs("#verdictHeadline"), copy.headline);
  setText(qs("#verdictDetail"), copy.detail);

  renderSplit(base);

  // Headline numbers.
  const gc = gapCell(base.gap);
  setKpi("#kpiGap", gc.text, gc.cls);
  setText(qs("#kpiGapLabel"), base.gap.kind === "met" ? "gap today (you have enough)" : "gap today (more needed now)");
  setKpi("#kpiTotal", fmtCompact(totalBalance(state)), "");
  setKpi("#kpiEndBal", fmtCompact(base.sim.endBal), base.sim.endBal >= 0 ? "pos" : "neg");
  setText(qs("#kpiEndBalLabel"), `balance at ${state.profile.endAge} (today's $)`);
  const run = runwayCell(base.sim);
  const runAge = base.sim.firstBreachYear === null ? null : base.sim.firstBreachYear - state.profile.currentYear + state.profile.currentAge;
  setKpi("#kpiRunway", runAge === null ? "never runs out" : `age ${runAge} (${base.sim.firstBreachYear})`, run.cls === "neg" ? "warn" : run.cls);

  renderFlags(base.sim);
  renderGlide(base.sim);

  setText(qs("#thRequired"), `Or earn $/yr to age ${state.work.untilAge}`);
  const tbody = qs("#scenarioRows");
  tbody.textContent = "";
  for (const r of results) {
    const rc = runwayCell(r.sim);
    const gcell = gapCell(r.gap);
    const qc = requiredCell(r.req);
    tbody.appendChild(
      el(
        "tr",
        {},
        el("td", { class: "name" }, r.label),
        el("td", { class: rc.cls }, rc.text),
        el("td", { class: `num ${gcell.cls}` }, gcell.text),
        el("td", { class: `num ${qc.cls}` }, qc.text)
      )
    );
  }

  balanceChart.update(results.map((r) => ({ key: r.key, label: r.label, path: r.sim.path })));
  cashflow.update(base.sim.rows);
}

/**
 * The recommended split: shares and dollars for the money you have today. When
 * there's a gap, also say what each bucket would hold with the gap closed.
 * @param {{sim: any, gap: any}} base
 */
function renderSplit(base) {
  const dollars = base.sim.startMix;
  const total = dollars.preservation + dollars.income + dollars.equities;
  /** @type {Record<string, [string, string]>} */
  const ids = { preservation: ["#kpiPres", "#kpiPresAmt"], income: ["#kpiInc", "#kpiIncAmt"], equities: ["#kpiEq", "#kpiEqAmt"] };
  const bar = qs("#splitBar");
  bar.textContent = "";
  for (const k of BUCKET_KEYS) {
    const share = total > 0 ? dollars[k] / total : 0;
    setKpi(ids[k][0], total > 0 ? fmtPct(share) : "—", "");
    setText(qs(ids[k][1]), total > 0 ? fmtMoney(dollars[k]) : "");
    const seg = el("span", { class: `seg bucket-${k}` });
    seg.style.width = `${share * 100}%`;
    bar.appendChild(seg);
  }
  const own = base.sim.startOwn;
  setText(qs("#splitHint"), own > 0 ? `of the ${fmtCompact(total)} in your three-bucket plan` : `of the ${fmtCompact(total)} you have today`);

  let note = "";
  if (!(total > 0)) {
    note = "Add your accounts to see a recommended split.";
  } else if (base.gap.kind === "value") {
    const funded = simulate(state, {}, 0, base.gap.amount).startMix;
    note = `You're short, so every bucket holds less than the plan needs. With the gap closed you'd hold ${fmtMoney(funded.preservation)} in capital preservation, ${fmtMoney(funded.income)} in high income, and ${fmtMoney(funded.equities)} in global equities.`;
  } else if (dollars.preservation === 0 && dollars.income === 0) {
    note = "The plan doesn't need to withdraw anything in the years the safe buckets cover, so everything can sit in equities for now. That changes as withdrawals get closer.";
  } else {
    note = "Capital preservation and high income hold exactly what your withdrawals in their years need. Everything beyond that is long-term money and sits in global equities.";
  }
  if (own > 0) {
    note += ` Not included: ${fmtMoney(own)} in accounts held in their own fund. That money is counted as long-term money, so it lowers how much the plan needs in equities.`;
  }
  setText(qs("#splitNote"), note);
}

/** Warnings about early withdrawals from retirement accounts. @param {any} sim */
function renderFlags(sim) {
  const box = qs("#flags");
  box.textContent = "";
  const span = (/** @type {number[]} */ ys) => (ys.length === 1 ? `${ys[0]}` : `${ys[0]}–${ys[ys.length - 1]}`);
  const lines = [];
  if (sim.earlyDeferredYears.length) {
    lines.push(`The plan has to take money from a traditional IRA or 401(k) before age 59½ (${span(sim.earlyDeferredYears)}), so a 10% penalty is included. More money in a taxable account for those years would avoid it.`);
  }
  if (sim.earlyRothYears.length) {
    lines.push(`The plan taps the Roth IRA before age 59½ (${span(sim.earlyRothYears)}). Your contributions can come out tax-free anytime, but earnings may be taxed and penalized, which isn't modeled.`);
  }
  for (const line of lines) box.appendChild(el("div", {}, line));
  show(box, lines.length > 0);
}

/** How the split changes as you age: every 5 years plus the final year. @param {any} sim */
function renderGlide(sim) {
  const tbody = qs("#glideRows");
  tbody.textContent = "";
  const rows = sim.rows.filter((/** @type {any} */ _r, /** @type {number} */ i) => i % 5 === 0 || i === sim.rows.length - 1);
  for (const r of rows) {
    const empty = !(r.mix.preservation + r.mix.income + r.mix.equities > 0);
    const pct = (/** @type {number} */ x) => el("td", { class: "num" }, empty ? "—" : fmtPct(x));
    tbody.appendChild(
      el(
        "tr",
        {},
        el("td", {}, `${r.age} (${r.year})`),
        pct(r.mix.preservation),
        pct(r.mix.income),
        pct(r.mix.equities),
        el("td", { class: "num" }, r.ownBal > 0 ? fmtCompact(r.ownBal) : "—"),
        el("td", { class: "num dim" }, `${r.returnPct.toFixed(1)}%`),
        el("td", { class: r.bal < 0 ? "num neg" : "num" }, fmtCompact(r.bal))
      )
    );
  }
}

/**
 * Render the WHOLE app for the current `state` — the boot sequence, factored so
 * a scenario switch/create/delete can re-render a freshly-active plan without a
 * page reload. Rebuilds the row lists + people, syncs scalars, then validates
 * and (if clean) re-renders results. Focus/scroll resetting here is acceptable
 * — a switch is a deliberate whole-plan swap, not an in-place edit.
 */
function renderAll() {
  for (const kind of Object.keys(LISTS)) renderList(kind);
  renderPeopleList();
  syncScalars();
  const { errors, warnings } = validate(state);
  renderIssues(errors, warnings);
  if (!errors.length) renderResults();
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
  if (rebuildKind === "people") renderPeopleList();
  else if (rebuildKind) renderList(rebuildKind);
  syncScalars();
  syncAccountRows();
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

// ---------------------------------------------------------------------------
// scenario bar (workspace layer) — switch/create/rename/delete
// ---------------------------------------------------------------------------

// Built in buildStaticBindings(); the boot block renders it once state is live.
/** @type {{render: (src: {scenarios: {id:string,name:string}[], activeId: string}) => void} | null} */
let scenarioBar = null;

/**
 * Apply a scenario-mutation response. Threads the new rev into the save
 * pipeline, updates the workspace view, and re-renders. A switch/create/delete
 * returns a fresh active `state` → full re-render; a rename only moves labels.
 * @param {{rev: number, activeId?: string, state?: object, scenarios: {id:string,name:string}[], warnings?: any[]}} resp
 * @param {"switch"|"create"|"rename"|"delete"} kind
 */
function applyWorkspaceResponse(resp, kind) {
  pipeline.setRev(resp.rev);
  seeded = true; // any successful scenario mutation means the dir is now seeded
  scenarios = resp.scenarios ?? scenarios;
  if (resp.activeId) activeId = resp.activeId;
  if (kind !== "rename" && resp.state) {
    state = resp.state;
    // a fresh plan is loaded — a debounced edit for the OLD plan is meaningless
    pipeline.cancel();
    if (placeholderBannerLive) {
      show(qs("#placeholderBanner"), false);
      placeholderBannerLive = false;
    }
    renderAll();
  }
  scenarioBar?.render({ scenarios, activeId });
}

function buildStaticBindings() {
  scenarioBar = initScenarioBar(qs("#scenarioBar"), {
    pipeline,
    getSeeded: () => seeded,
    onWorkspace: applyWorkspaceResponse,
    onConflict: () => show(qs("#conflictBanner"), true),
  });

  // scalar fields (number inputs + range sliders share data-path; syncScalars links them).
  // Checkboxes commit a boolean on change, not a parsed number.
  for (const input of document.querySelectorAll("[data-path]")) {
    const isCheckbox = input.type === "checkbox";
    input.addEventListener(isCheckbox ? "change" : "input", () => {
      commit(setValueAtPath(state, input.dataset.path, isCheckbox ? input.checked : parseNumField(input.value)));
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

  // household people — spouse (seeds SS + healthcare) and dependent
  qs("#addSpouse").addEventListener("click", () => commit(addPerson(state, "spouse"), "people"));
  qs("#addDependent").addEventListener("click", () => commit(addPerson(state, "dependent"), "people"));

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
      setText(errEl, errorsText(body, `Import failed (HTTP ${res.status}).`));
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
renderPeopleList();
syncScalars();
{
  const { errors, warnings } = validate(state);
  renderIssues(errors, warnings);
  if (!errors.length) renderResults(); // verdict is NEVER blank on load
}
scenarioBar?.render({ scenarios, activeId }); // the workspace bar reflects the boot state
if (boot.recovery) {
  renderRecovery(boot.recovery); // placeholder renders underneath — the app stays alive
} else if (!boot.seeded) {
  placeholderBannerLive = true;
  show(qs("#placeholderBanner"), true);
}
// U7: trends + snapshots load once per page load (a trend row lands at most
// once per day, and restore ends in location.reload() — nothing to keep live).
void initTrends(qs("#trendsBody"));
void initSnapshots(qs("#snapshotsBody"), { pipeline });
// U8: spreadsheet export + template import (apply ends in location.reload()).
initImports(qs("#importsBody"), { pipeline });
