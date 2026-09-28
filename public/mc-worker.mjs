// Background worker: runs the Monte Carlo simulation off the main thread so
// typing stays smooth. One job at a time; app.mjs sends only the latest state.
import { monteCarlo } from "/engine/montecarlo.mjs";
import { SCENARIOS } from "/engine/scenarios.mjs";

self.onmessage = (/** @type {MessageEvent} */ e) => {
  const { id, state } = e.data;
  try {
    const results = SCENARIOS.map((sc) => ({ key: sc.key, label: sc.label, ...monteCarlo(state, sc.overlay) }));
    self.postMessage({ id, results });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
