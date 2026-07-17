// A workspace holds several named scenarios (alternative plans) plus a pointer
// to the active one. The engine/solver/model still operate on a single
// RunwayState — the active scenario's state — so all the trust-critical math is
// untouched; this is a layer around it.
//
// PURE: no clock, no I/O, no id generation. The store (which owns side effects)
// injects a `makeId` where a new scenario id is needed, exactly as it injects
// `now()`. That keeps migration and CRUD deterministic under test.
//
// Shape: { workspaceVersion, activeId, scenarios: [{ id, name, state }] }
import { migrate, MissingVersionError, FutureVersionError } from "./migrate.mjs";
import { validate } from "./schema.mjs";

export const WORKSPACE_VERSION = 1;

/**
 * @typedef {Object} Scenario
 * @property {string} id
 * @property {string} name
 * @property {import("./schema.mjs").RunwayState} state
 *
 * @typedef {Object} Workspace
 * @property {number} workspaceVersion
 * @property {string} activeId
 * @property {Scenario[]} scenarios
 */

/** @param {Workspace} ws @returns {Scenario} */
export function activeScenario(ws) {
  return ws.scenarios.find((s) => s.id === ws.activeId) ?? ws.scenarios[0];
}

/** @param {Workspace} ws @returns {import("./schema.mjs").RunwayState} */
export function activeState(ws) {
  return activeScenario(ws).state;
}

/** The lightweight list the client renders as the scenario bar. @param {Workspace} ws */
export function scenarioList(ws) {
  return ws.scenarios.map(({ id, name }) => ({ id, name }));
}

/** Replace the active scenario's state immutably. @param {Workspace} ws @param {import("./schema.mjs").RunwayState} state */
export function withActiveState(ws, state) {
  return { ...ws, scenarios: ws.scenarios.map((s) => (s.id === ws.activeId ? { ...s, state } : s)) };
}

/**
 * Add a scenario and make it active. The caller builds `state` — a deep clone of
 * a source scenario (copy) or a fresh default (from scratch).
 * @param {Workspace} ws @param {{id: string, name: string, state: import("./schema.mjs").RunwayState}} scenario
 */
export function addScenario(ws, { id, name, state }) {
  return { ...ws, activeId: id, scenarios: [...ws.scenarios, { id, name, state }] };
}

/** @param {Workspace} ws @param {string} id @param {string} name */
export function renameScenario(ws, id, name) {
  return { ...ws, scenarios: ws.scenarios.map((s) => (s.id === id ? { ...s, name } : s)) };
}

/** Delete a scenario; refuses the last one. If the active one is removed, the first remaining becomes active. @param {Workspace} ws @param {string} id */
export function deleteScenario(ws, id) {
  if (ws.scenarios.length <= 1) throw new Error("cannot delete the last scenario");
  if (!ws.scenarios.some((s) => s.id === id)) throw new Error("no such scenario");
  const scenarios = ws.scenarios.filter((s) => s.id !== id);
  const activeId = ws.activeId === id ? scenarios[0].id : ws.activeId;
  return { ...ws, activeId, scenarios };
}

/** @param {Workspace} ws @param {string} id */
export function setActive(ws, id) {
  if (!ws.scenarios.some((s) => s.id === id)) throw new Error("no such scenario");
  return { ...ws, activeId: id };
}

/** @param {{id: string, name?: string, state: import("./schema.mjs").RunwayState}} opts @returns {Workspace} */
export function makeWorkspace({ id, name = "Base plan", state }) {
  return { workspaceVersion: WORKSPACE_VERSION, activeId: id, scenarios: [{ id, name, state }] };
}

/** @param {unknown} data @returns {data is {scenarios: unknown[]}} */
function looksLikeWorkspace(data) {
  return !!data && typeof data === "object" && Array.isArray(/** @type {any} */ (data).scenarios);
}

/**
 * Bring raw parsed JSON to a current, valid-shaped workspace. Two inputs:
 *   - a workspace (migrate each scenario's state to the current schema; repair a
 *     dangling activeId; refuse a future workspaceVersion / missing version);
 *   - a bare RunwayState (pre-workspace file) → migrate it and wrap it as the
 *     sole "Base plan" scenario.
 * Garbage (no scenarios and no schemaVersion) throws MissingVersionError, which
 * the store treats as corrupt.
 * @param {any} data
 * @param {{makeId: () => string}} deps
 * @returns {{workspace: Workspace, wrapped: boolean}}
 */
export function migrateWorkspace(data, { makeId }) {
  if (looksLikeWorkspace(data)) {
    const ws = /** @type {any} */ (data);
    if (typeof ws.workspaceVersion !== "number" || !Number.isInteger(ws.workspaceVersion) || ws.workspaceVersion < 1) {
      throw new MissingVersionError();
    }
    if (ws.workspaceVersion > WORKSPACE_VERSION) throw new FutureVersionError(ws.workspaceVersion);
    const scenarios = ws.scenarios.map((/** @type {any} */ sc) => ({ id: sc.id, name: sc.name, state: migrate(sc.state).state }));
    let activeId = ws.activeId;
    if (!scenarios.some((/** @type {any} */ s) => s.id === activeId)) activeId = scenarios[0]?.id;
    return { workspace: { workspaceVersion: WORKSPACE_VERSION, activeId, scenarios }, wrapped: false };
  }
  // Bare state (or garbage) — migrate() enforces schemaVersion and throws on corruption.
  const state = migrate(data).state;
  return { workspace: makeWorkspace({ id: makeId(), state }), wrapped: true };
}

/**
 * Structural validation of the whole workspace, including each scenario's state
 * (errors path-prefixed by scenario). This guards persistence integrity; the API
 * separately runs the per-state validate() on the ACTIVE scenario for the
 * client's field-level errors/warnings.
 * @param {Workspace} ws
 * @returns {{errors: import("./schema.mjs").Issue[]}}
 */
export function validateWorkspace(ws) {
  /** @type {import("./schema.mjs").Issue[]} */ const errors = [];
  if (!ws || typeof ws !== "object") {
    errors.push({ path: "", message: "workspace must be an object" });
    return { errors };
  }
  if (ws.workspaceVersion !== WORKSPACE_VERSION) {
    errors.push({ path: "workspaceVersion", message: `expected ${WORKSPACE_VERSION}, got ${ws.workspaceVersion}` });
  }
  if (!Array.isArray(ws.scenarios) || ws.scenarios.length === 0) {
    errors.push({ path: "scenarios", message: "at least one scenario is required" });
    return { errors };
  }
  const ids = new Set();
  ws.scenarios.forEach((sc, i) => {
    const at = `scenarios[${i}]`;
    if (typeof sc.id !== "string" || !sc.id) errors.push({ path: `${at}.id`, message: "id required" });
    else if (ids.has(sc.id)) errors.push({ path: `${at}.id`, message: `duplicate id ${sc.id}` });
    else ids.add(sc.id);
    if (typeof sc.name !== "string" || !sc.name.trim()) errors.push({ path: `${at}.name`, message: "name required" });
    for (const e of validate(sc.state).errors) errors.push({ path: `${at}.state.${e.path}`, message: e.message });
  });
  if (!ids.has(ws.activeId)) errors.push({ path: "activeId", message: "activeId must reference a scenario" });
  return { errors };
}
