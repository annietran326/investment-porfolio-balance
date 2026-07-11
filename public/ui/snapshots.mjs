// Snapshots browser (U7): list every snapshot the store has taken (first save
// of each day, pre-import/restore provenance, …) and restore any of them in
// one click. Reuses the recovery panel's snapshot-row markup/CSS pattern.
//
// Restore flow: confirm (naming the snapshot's date AND source) →
// pipeline.flushOrCancel() so a pending debounced edit can't race the restore
// → POST /api/restore → on 200 a full location.reload() re-fetches state
// cleanly (nothing else to render). 409 means another tab moved the rev: the
// list refreshes with an inline notice, and the rev from the 409 body is
// remembered so "try again" can actually succeed. Other errors show inline
// next to the row with a Retry link.
//
// Pure copy helpers live up top (no DOM at module top level — node:test
// imports this file under plain Node); DOM wiring below.
import { el, setText, show } from "./dom.mjs";

/** @typedef {{file: string, ts: string, source: string}} SnapshotInfo */

/** Local-time "YYYY-MM-DD HH:MM" for a snapshot's ISO ts. @param {string} ts */
export function snapshotWhen(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts; // never blank a row over a bad stamp
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** The confirm-dialog copy — names the snapshot's date AND source. @param {SnapshotInfo} snap */
export function restoreConfirmText(snap) {
  return `Restore snapshot from ${snapshotWhen(snap.ts)} (${snap.source})? Current state is snapshotted first.`;
}

export const STALE_LIST_COPY = "State changed since you opened this list — try again.";

// ---------------------------------------------------------------------------
// DOM (browser only — called from app.mjs, never at import time)
// ---------------------------------------------------------------------------

/**
 * Build the snapshots section and load the list. Returns the initial-load
 * promise. fetch/confirm/reload are injectable for tests.
 * @param {HTMLElement} mount
 * @param {{pipeline: {flushOrCancel: () => Promise<any>, rev: () => number},
 *   fetchFn?: (url: string, init?: object) => Promise<{status: number, json: () => Promise<any>}>,
 *   confirmFn?: (msg: string) => boolean,
 *   reload?: () => void}} opts
 */
export function initSnapshots(mount, opts) {
  const pipeline = opts.pipeline;
  const fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
  const confirmFn = opts.confirmFn ?? ((msg) => window.confirm(msg));
  const reload = opts.reload ?? (() => location.reload());
  // Rev learned from a 409 body — another tab moved the store, but a restore
  // is still a deliberate, destructive-safe action (current state is
  // snapshotted first), so the retry may proceed against the fresh rev.
  let revLearned = -1;

  const notice = el("div", { class: "issue" });
  const list = el("div", { class: "snapshot-list snapshot-scroll" });
  mount.append(notice, list);

  async function loadList() {
    list.textContent = "";
    /** @type {SnapshotInfo[]} */
    let snaps = [];
    try {
      const res = await fetchFn("/api/snapshots");
      if (res.status !== 200) {
        setText(notice, `Could not load snapshots (HTTP ${res.status}).`);
        return;
      }
      snaps = (await res.json())?.snapshots ?? [];
    } catch {
      setText(notice, "Could not load snapshots — is the server still running?");
      return;
    }
    if (snaps.length === 0) {
      list.appendChild(el("div", { class: "dim" }, "No snapshots yet — the first save of each day creates one."));
      return;
    }
    for (const snap of snaps) list.appendChild(buildRow(snap));
  }

  /** @param {SnapshotInfo} snap */
  function buildRow(snap) {
    const err = el("span", { class: "issue" });
    const retry = el("button", { type: "button", class: "small linklike hidden" }, "Retry");
    const btn = el("button", { type: "button", class: "small" }, "Restore");

    /** @param {boolean} confirmed Retry skips re-confirming — the user already said yes */
    const restore = async (confirmed) => {
      if (!confirmed && !confirmFn(restoreConfirmText(snap))) return;
      btn.disabled = true;
      retry.disabled = true;
      setText(err, "");
      show(retry, false);
      setText(notice, "");
      try {
        await pipeline.flushOrCancel(); // settle any pending save before mutating server-side
        const res = await fetchFn("/api/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: snap.file, baseRev: Math.max(pipeline.rev(), revLearned) }),
        });
        if (res.status === 200) {
          reload(); // a full reload re-fetches state cleanly — show nothing else
          return;
        }
        if (res.status === 409) {
          const body = await res.json().catch(() => null);
          if (typeof body?.rev === "number") revLearned = body.rev;
          setText(notice, STALE_LIST_COPY);
          await loadList(); // the restore-side snapshot of "current" may have landed rows
          return;
        }
        setText(err, `Restore failed (HTTP ${res.status}).`);
        show(retry, true);
      } catch {
        setText(err, "Restore failed — is the server still running?");
        show(retry, true);
      }
      btn.disabled = false;
      retry.disabled = false;
    };
    btn.addEventListener("click", () => void restore(false));
    retry.addEventListener("click", () => void restore(true));

    return el(
      "div",
      { class: "snapshot-row" },
      el("span", { class: "mono" }, snapshotWhen(snap.ts)),
      el("span", { class: "snapshot-chip" }, snap.source),
      btn,
      retry,
      err
    );
  }

  return loadList();
}
