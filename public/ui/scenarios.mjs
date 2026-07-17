// Scenario switcher (workspace layer): a compact pill bar of the saved
// scenarios (alternative plans), the active one highlighted, plus create /
// rename / delete affordances. Switching a scenario re-renders the WHOLE app
// for the newly active plan without a page reload — the app.mjs controller
// owns that full re-render; this module owns the bar's markup and the fetch
// round-trips.
//
// Pure copy/model helpers live up top (no DOM at module top level — node:test
// imports this file under plain Node); the DOM controller is below. Like
// forms.mjs, this module is self-contained: it NEVER imports across the
// public->src boundary (test/browser-imports.test.mjs forbids it), so the
// scenario-name cap is inlined here rather than shared with the server.
import { el, setText, show } from "./dom.mjs";

/** Server caps a scenario name at 80 chars (see api.mjs scenarioName). */
export const SCENARIO_NAME_MAX = 80;

/**
 * Trim + cap a scenario name the way the server does. Returns "" when the
 * input is blank/whitespace (the caller treats that as "no name given").
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeScenarioName(raw) {
  const t = typeof raw === "string" ? raw.trim() : "";
  return t.slice(0, SCENARIO_NAME_MAX);
}

/**
 * A rename is worth sending only when it's non-empty AND actually changes the
 * name (after normalization). Keeps a no-op rename off the wire.
 * @param {string} current @param {unknown} raw
 * @returns {{ok: true, name: string} | {ok: false}}
 */
export function validateRename(current, raw) {
  const name = normalizeScenarioName(raw);
  if (!name || name === current) return { ok: false };
  return { ok: true, name };
}

/**
 * The view-model the bar renders from the GET/mutation response fields.
 * `seeded` gates management: before the first save the dir is unseeded and only
 * a single "Base plan" pill shows, with create enabled (create seeds on the
 * server) but rename/delete suppressed. Delete is additionally suppressed when
 * only one scenario exists (the API refuses the last with 400).
 * @param {{scenarios: {id: string, name: string}[], activeId: string, seeded?: boolean}} src
 */
export function barModel({ scenarios, activeId, seeded = true }) {
  const pills = (scenarios ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    active: s.id === activeId,
  }));
  const multiple = pills.length > 1;
  return {
    pills,
    canCreate: seeded || pills.length <= 1, // unseeded still offers create (it seeds)
    canManage: seeded, // rename/delete need a real (seeded) workspace
    canDelete: seeded && multiple, // never offer to delete the last one
  };
}

/**
 * The POST /api/scenarios/create payload. `copy` duplicates a source scenario
 * (defaults to the active one); `scratch` is a fresh empty plan. Either way the
 * new scenario becomes active server-side.
 * @param {{mode: "copy"|"scratch", name?: string, fromId?: string, baseRev: number}} o
 */
export function createPayload({ mode, name, fromId, baseRev }) {
  /** @type {{name: string, mode: "copy"|"scratch", baseRev: number, fromId?: string}} */
  const payload = { name: normalizeScenarioName(name) || "Scenario", mode, baseRev };
  if (mode === "copy" && fromId) payload.fromId = fromId;
  return payload;
}

// ---------------------------------------------------------------------------
// DOM controller (browser only — called from app.mjs, never at import time)
// ---------------------------------------------------------------------------

/**
 * Wire the scenario bar. The controller keeps no state of its own beyond the
 * latest bar model; app.mjs calls render() after every mutation with the fresh
 * {scenarios, activeId, seeded}. fetch/prompt/confirm are injectable for tests.
 *
 * @param {HTMLElement} mount the #scenarioBar container (its skeleton lives in index.html)
 * @param {{
 *   pipeline: {rev: () => number, flushOrCancel: () => Promise<any>},
 *   onWorkspace: (resp: {rev: number, activeId?: string, state?: object, scenarios: {id:string,name:string}[], warnings?: any[]}, kind: "switch"|"create"|"rename"|"delete") => void,
 *   onConflict?: () => void,
 *   getSeeded: () => boolean,
 *   fetchFn?: (url: string, init?: object) => Promise<{status: number, json: () => Promise<any>}>,
 *   promptFn?: (msg: string, def: string) => string|null,
 *   confirmFn?: (msg: string) => boolean,
 * }} opts
 */
export function initScenarioBar(mount, opts) {
  const pipeline = opts.pipeline;
  const fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
  const promptFn = opts.promptFn ?? ((msg, def) => window.prompt(msg, def));
  const confirmFn = opts.confirmFn ?? ((msg) => window.confirm(msg));
  const onConflict = opts.onConflict ?? (() => {});

  const JSON_HEADERS = { "Content-Type": "application/json" };

  // Structure: a row of pills + a "+ new" control that reveals two buttons.
  const pillRow = el("div", { class: "scenario-pills" });
  const newBtn = /** @type {HTMLButtonElement} */ (
    el("button", { type: "button", class: "small scenario-new-btn", "aria-haspopup": "true", "aria-expanded": "false" }, "＋ new")
  );
  const dupBtn = el("button", { type: "button", class: "small" }, "Duplicate current");
  const scratchBtn = el("button", { type: "button", class: "small" }, "From scratch");
  const newMenu = el("div", { class: "scenario-new-menu hidden", role: "menu" }, dupBtn, scratchBtn);
  const newWrap = el("div", { class: "scenario-new" }, newBtn, newMenu);
  const label = el("span", { class: "scenario-bar-label dim" }, "Scenarios");
  mount.append(label, pillRow, newWrap);

  let menuOpen = false;
  function setMenu(open) {
    menuOpen = open;
    show(newMenu, open);
    newBtn.setAttribute("aria-expanded", String(open));
  }
  newBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setMenu(!menuOpen);
  });
  // Click anywhere else closes the menu (CSP-safe: a real listener, no inline handler).
  document.addEventListener("click", () => {
    if (menuOpen) setMenu(false);
  });
  newMenu.addEventListener("click", (e) => e.stopPropagation());

  dupBtn.addEventListener("click", () => {
    setMenu(false);
    void create("copy");
  });
  scratchBtn.addEventListener("click", () => {
    setMenu(false);
    void create("scratch");
  });

  /** Disable every control while a mutation is in flight (avoid double-fire). */
  let busy = false;
  function setBusy(on) {
    busy = on;
    for (const b of mount.querySelectorAll("button")) /** @type {HTMLButtonElement} */ (b).disabled = on;
  }

  /**
   * POST a scenario mutation, threading the pipeline rev in and the response
   * out. Settles any pending debounced edit first (same discipline as the
   * import/restore flows). 409 → the app's conflict banner; other non-200s are
   * surfaced to the console only (the bar is best-effort — the app is still usable).
   * @param {string} url @param {object} payload
   * @param {"switch"|"create"|"rename"|"delete"} kind
   */
  async function mutate(url, payload, kind) {
    if (busy) return;
    setBusy(true);
    try {
      await pipeline.flushOrCancel(); // settle any in-flight edit before mutating server-side
      const res = await fetchFn(url, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...payload, baseRev: pipeline.rev() }),
      });
      if (res.status === 200) {
        const body = await res.json();
        opts.onWorkspace(body, kind); // app.mjs threads rev + re-renders
        return;
      }
      if (res.status === 409) {
        onConflict();
        return;
      }
      // 400 (e.g. refused last scenario) / 404 (unknown) — bar guards against
      // both client-side, so reaching here is a lost race; log and move on.
      const body = await res.json().catch(() => null);
      const msg = body?.errors?.[0]?.message ?? `HTTP ${res.status}`;
      console.warn(`scenario ${kind} failed: ${msg}`);
    } catch {
      console.warn(`scenario ${kind} failed — is the server still running?`);
    } finally {
      setBusy(false);
    }
  }

  /** @param {string} id */
  function switchTo(id) {
    return mutate("/api/scenarios/switch", { id }, "switch");
  }
  /** @param {"copy"|"scratch"} mode */
  function create(mode) {
    const defName = mode === "copy" ? "Copy of current" : "New plan";
    const name = promptFn(mode === "copy" ? "Name the duplicated scenario:" : "Name the new scenario:", defName);
    if (name === null) return Promise.resolve(); // cancelled
    return mutate("/api/scenarios/create", createPayload({ mode, name: name || defName, fromId: activeIdNow, baseRev: 0 }), "create");
  }
  /** @param {string} id @param {string} current */
  function rename(id, current) {
    const raw = promptFn("Rename scenario:", current);
    if (raw === null) return Promise.resolve(); // cancelled
    const v = validateRename(current, raw);
    if (!v.ok) return Promise.resolve(); // blank or unchanged — nothing to send
    return mutate("/api/scenarios/rename", { id, name: v.name }, "rename");
  }
  /** @param {string} id @param {string} name */
  function del(id, name) {
    if (!confirmFn(`Delete scenario "${name}"? This can't be undone.`)) return Promise.resolve();
    return mutate("/api/scenarios/delete", { id }, "delete");
  }

  let activeIdNow = "";

  /**
   * Rebuild the bar from the current workspace view. Called at boot and after
   * every mutation. Rebuild (not patch) is fine here — the bar holds no focus
   * a user could be typing into.
   * @param {{scenarios: {id: string, name: string}[], activeId: string}} src
   */
  function render(src) {
    activeIdNow = src.activeId;
    const model = barModel({ scenarios: src.scenarios, activeId: src.activeId, seeded: opts.getSeeded() });

    pillRow.textContent = "";
    for (const p of model.pills) {
      const pill = el("span", { class: p.active ? "scenario-pill active" : "scenario-pill" });
      const nameBtn = /** @type {HTMLButtonElement} */ (
        el("button", { type: "button", class: "scenario-pill-name" }, p.name)
      );
      if (!p.active) nameBtn.addEventListener("click", () => void switchTo(p.id));
      else nameBtn.setAttribute("aria-current", "true");
      pill.appendChild(nameBtn);

      // Rename/delete affordances ride on the ACTIVE pill only (keeps the bar
      // compact and unambiguous about which plan the action targets).
      if (p.active && model.canManage) {
        const editBtn = /** @type {HTMLButtonElement} */ (
          el("button", { type: "button", class: "scenario-pill-act", title: "Rename", "aria-label": `rename ${p.name}` }, "✎")
        );
        editBtn.addEventListener("click", () => void rename(p.id, p.name));
        pill.appendChild(editBtn);
        if (model.canDelete) {
          const delBtn = /** @type {HTMLButtonElement} */ (
            el("button", { type: "button", class: "scenario-pill-act danger", title: "Delete", "aria-label": `delete ${p.name}` }, "✕")
          );
          delBtn.addEventListener("click", () => void del(p.id, p.name));
          pill.appendChild(delBtn);
        }
      }
      pillRow.appendChild(pill);
    }

    show(newWrap, model.canCreate);
    if (busy) setBusy(false); // a render always ends the in-flight state
  }

  return { render };
}
