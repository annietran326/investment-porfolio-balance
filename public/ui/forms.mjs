// Form state transforms + thin row-list DOM builders.
//
// Every transform is PURE and immutable — it returns a new state and never
// mutates its input — so node:test covers them headlessly. The DOM builders
// at the bottom touch `document` only inside function bodies (never at module
// top level), so importing this file under Node is safe.

/** @typedef {import("../../src/model/schema.mjs").RunwayState} RunwayState */
/** @typedef {"properties"|"incomes"|"spending"} ListKind */

/**
 * Blank row per list kind. Income defaults anchor on the plan's currentYear
 * (the engine never reads the clock; neither do we).
 * @param {ListKind} kind @param {RunwayState} state
 */
export function blankRow(kind, state) {
  if (kind === "properties") {
    return {
      name: "new property",
      rentMonthly: 0,
      costsMonthly: 0,
      mortgageMonthly: 0,
      payoffYear: null,
      saleYear: null,
      saleNetProceeds: null,
    };
  }
  if (kind === "incomes") {
    const y = state.profile.currentYear;
    return { name: "new income", annual: 0, fromYear: y, toYear: y + 4 };
  }
  if (kind === "spending") return { name: "new category", monthly: 0 };
  throw new Error(`unknown list kind: ${kind}`);
}

/** @param {RunwayState} state @param {ListKind} kind @returns {RunwayState} */
export function addRow(state, kind) {
  const next = structuredClone(state);
  next[kind].push(/** @type {any} */ (blankRow(kind, state)));
  return next;
}

/** @param {RunwayState} state @param {ListKind} kind @param {number} index @returns {RunwayState} */
export function removeRow(state, kind, index) {
  const next = structuredClone(state);
  next[kind].splice(index, 1);
  return next;
}

/** @param {RunwayState} state @param {ListKind} kind @param {number} index @param {string} key @param {unknown} value */
export function setRowValue(state, kind, index, key, value) {
  const next = structuredClone(state);
  /** @type {any} */ (next[kind][index])[key] = value;
  return next;
}

/**
 * Set a dotted scalar path (e.g. "profile.endAge") immutably.
 * @param {RunwayState} state @param {string} path @param {unknown} value
 */
export function setValueAtPath(state, path, value) {
  const next = structuredClone(state);
  const keys = path.split(".");
  const last = /** @type {string} */ (keys.pop());
  let target = /** @type {any} */ (next);
  for (const k of keys) target = target[k];
  target[last] = value;
  return next;
}

/**
 * Switch the end-state mode. Each mode's amount lives in amounts[mode] and is
 * PRESERVED across switches — switching zero→bequest→floor→bequest round-trips.
 * @param {RunwayState} state @param {import("../../src/model/schema.mjs").EndStateMode} mode
 */
export function setEndStateMode(state, mode) {
  const next = structuredClone(state);
  next.endState.mode = mode;
  return next;
}

/**
 * Set the amount for the CURRENT mode. "zero" has no amount — a no-op.
 * @param {RunwayState} state @param {unknown} amount
 */
export function setEndStateAmount(state, amount) {
  const next = structuredClone(state);
  const mode = next.endState.mode;
  if (mode === "zero") return next;
  /** @type {any} */ (next.endState.amounts)[mode] = amount;
  return next;
}

/** The amount the bound input should show — null when mode is zero (hidden). @param {RunwayState} state */
export function endStateAmountValue(state) {
  const { mode, amounts } = state.endState;
  return mode === "zero" ? null : amounts[mode];
}

/**
 * Number-field parse: empty → null (meaningful for nullable fields like
 * saleYear; a validation error for required ones — never silently 0).
 * @param {unknown} raw
 */
export function parseNumField(raw) {
  const t = String(raw).trim();
  return t === "" ? null : Number(t);
}

// ---------------------------------------------------------------------------
// DOM builders (browser only — called from app.mjs, never at import time)
// ---------------------------------------------------------------------------

/**
 * Rebuild a row list from a <template>. Called only on initial build and on
 * add/remove — never while typing, so field focus is never lost. Inputs carry
 * data-key; values land via .value (user strings never touch innerHTML).
 * @param {Element} container
 * @param {HTMLTemplateElement} template
 * @param {Record<string, any>[]} items
 * @param {{onField: (index: number, key: string, raw: string, isText: boolean) => void,
 *          onRemove: (index: number) => void}} handlers
 */
export function renderRows(container, template, items, handlers) {
  container.textContent = "";
  items.forEach((item, index) => {
    const row = /** @type {Element} */ (
      /** @type {Element} */ (template.content.firstElementChild).cloneNode(true)
    );
    for (const input of row.querySelectorAll("input[data-key]")) {
      const field = /** @type {HTMLInputElement} */ (input);
      const key = /** @type {string} */ (field.dataset.key);
      const v = item[key];
      field.value = v === null || v === undefined ? "" : String(v);
      field.addEventListener("input", () => handlers.onField(index, key, field.value, field.type === "text"));
    }
    const remove = row.querySelector("button.remove");
    if (remove) remove.addEventListener("click", () => handlers.onRemove(index));
    container.appendChild(row);
  });
}
