// The save pipeline: debounce + serialized PUTs + the badge state machine.
// Pure logic — fetch and timers are injected, nothing touches the DOM — so
// node:test drives the whole machine with fake clocks and a fake server.
//
// Invariants (pinned by test/ui-state.test.mjs):
//   - A burst of edits collapses to ONE queued payload (the latest).
//   - At most one PUT in flight; each response's rev threads into the next
//     PUT, so a burst can never 409 against itself.
//   - Fetch failure → "error"; retry() re-fires the LATEST payload, not the
//     failed one, and a debounce armed by a newer edit stays armed.
//   - 409 → "conflict": the queue is cancelled and the pipeline goes inert
//     (the app shows a persistent reload banner; only a reload recovers).
import { errorsText } from "./verdict.mjs";

/**
 * Debounce with injectable timers.
 * @param {number} ms
 * @param {() => void} fire
 * @param {{setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (h: any) => void}} [opts]
 */
export function createDebouncer(ms, fire, opts = {}) {
  const setTimer = opts.setTimer ?? ((fn, t) => setTimeout(fn, t));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
  /** @type {any} */
  let handle = null;
  return {
    /** (re)start the timer — every new edit pushes the flush out */
    arm() {
      if (handle !== null) clearTimer(handle);
      handle = setTimer(() => {
        handle = null;
        fire();
      }, ms);
    },
    cancel() {
      if (handle !== null) {
        clearTimer(handle);
        handle = null;
      }
    },
    pending() {
      return handle !== null;
    },
    /** fire now if armed (and disarm) */
    flush() {
      if (handle !== null) {
        clearTimer(handle);
        handle = null;
        fire();
      }
    },
  };
}

/**
 * Thin PUT /api/state wrapper: classifies the outcome, never throws.
 * @param {(url: string, init: object) => Promise<{status: number, json: () => Promise<any>}>} fetchFn
 * @param {object} state
 * @param {number} baseRev
 * @param {{keepalive?: boolean}} [opts]
 * @returns {Promise<{kind:"ok", rev:number, warnings:any[]} | {kind:"conflict", rev?:number} | {kind:"error", message:string}>}
 */
export async function putState(fetchFn, state, baseRev, opts = {}) {
  let res;
  try {
    res = await fetchFn("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, baseRev }),
      keepalive: opts.keepalive === true,
    });
  } catch {
    return { kind: "error", message: "network error" };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body — classified by status below */
  }
  if (res.status === 200) {
    if (body && typeof body.rev === "number") return { kind: "ok", rev: body.rev, warnings: body.warnings ?? [] };
    return { kind: "error", message: "malformed save response" };
  }
  if (res.status === 409) return { kind: "conflict", rev: body?.rev };
  return { kind: "error", message: errorsText(body, `HTTP ${res.status}`) };
}

/**
 * @typedef {"idle"|"pending"|"saving"|"saved"|"invalid"|"error"|"conflict"} SaveStatus
 * @typedef {{status: SaveStatus, message: string, rev: number, everSaved: boolean, dirty: boolean}} SaveSnapshot
 *
 * @param {Object} opts
 * @param {(url: string, init: object) => Promise<{status: number, json: () => Promise<any>}>} opts.fetchFn
 * @param {number} [opts.initialRev]
 * @param {number} [opts.debounceMs]
 * @param {(snap: SaveSnapshot) => void} [opts.onState] called on every transition
 * @param {(fn: () => void, ms: number) => any} [opts.setTimer]
 * @param {(h: any) => void} [opts.clearTimer]
 */
export function createSavePipeline(opts) {
  const fetchFn = opts.fetchFn;
  const onState = opts.onState ?? (() => {});
  let rev = opts.initialRev ?? 0;
  /** @type {object|null} latest payload — the single source of "what to save" */
  let latest = null;
  let editSeq = 0; // bumped on every edit (and on markInvalid, to stay dirty)
  let savedSeq = 0; // editSeq captured by the last successful PUT
  let invalid = false; // validation errors block ALL sends until a valid edit
  /** @type {SaveStatus} */
  let status = "idle";
  let message = "";
  let everSaved = false;
  let pumping = false;
  /** @type {Promise<void>} */
  let pumpPromise = Promise.resolve();

  const debouncer = createDebouncer(opts.debounceMs ?? 1500, () => void pump(), opts);

  function snapshot() {
    return { status, message, rev, everSaved, dirty: editSeq > savedSeq };
  }

  /** @param {SaveStatus} s @param {string} [msg] */
  function setStatus(s, msg = "") {
    status = s;
    message = msg;
    onState(snapshot());
  }

  /**
   * Serialized send loop: one PUT in flight, latest payload wins, response
   * rev threads into any follow-up PUT. Concurrent callers share the promise.
   * @param {{keepalive?: boolean}} [pumpOpts]
   */
  function pump(pumpOpts = {}) {
    if (pumping) return pumpPromise;
    pumping = true;
    pumpPromise = (async () => {
      let keepalive = pumpOpts.keepalive === true;
      for (;;) {
        if (latest === null || invalid || status === "conflict") return;
        if (editSeq === savedSeq) return; // nothing new to save
        const seq = editSeq;
        setStatus("saving");
        const out = await putState(fetchFn, latest, rev, { keepalive });
        keepalive = false;
        if (out.kind === "ok") {
          rev = out.rev;
          savedSeq = seq;
          everSaved = true;
          if (editSeq > seq && !invalid) continue; // newer payload queued mid-flight
          setStatus("saved");
          return;
        }
        if (out.kind === "conflict") {
          if (typeof out.rev === "number") rev = out.rev;
          debouncer.cancel(); // the queue is dead — only a reload recovers
          setStatus("conflict");
          return;
        }
        // NOTE: a debounce armed by a newer edit stays armed — it will retry.
        setStatus("error", out.message);
        return;
      }
    })().finally(() => {
      pumping = false;
    });
    return pumpPromise;
  }

  return {
    /** A valid edited state. Debounced; supersedes any queued payload. @param {object} state */
    edit(state) {
      if (status === "conflict") return;
      invalid = false;
      latest = state;
      editSeq += 1;
      // keep an error badge (and its Retry) visible while the debounce re-arms
      if (status !== "error") setStatus("pending");
      else onState(snapshot());
      debouncer.arm();
    },

    /** Validation errors block the PUT; the badge shows the message. @param {string} msg */
    markInvalid(msg) {
      if (status === "conflict") return;
      invalid = true;
      editSeq += 1; // dirty: the on-server state no longer matches the screen
      debouncer.cancel(); // never send a stale payload around an invalid edit
      setStatus("invalid", msg);
    },

    /** Re-fire the LATEST payload now (error recovery). */
    retry() {
      return pump();
    },

    /** Flush any pending debounced edit immediately; resolves when quiescent. */
    flushOrCancel() {
      debouncer.cancel();
      return pump().then(snapshot);
    },

    /** pagehide/beforeunload: fire-and-forget flush with fetch keepalive. */
    flushKeepalive() {
      debouncer.cancel();
      void pump({ keepalive: true });
    },

    /** Drop all pending work (used before reset — the state is being discarded). */
    cancel() {
      debouncer.cancel();
      editSeq = savedSeq;
      latest = null;
      invalid = false;
    },

    rev() {
      return rev;
    },
    snapshot,
  };
}
