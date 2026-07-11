#!/usr/bin/env node
// Process entrypoint: resolve config, warn about cloud-synced data dirs, take
// the lock, and bind the codebase's single server socket — loopback only,
// always. (The egress guard sanctions node:http only under src/server/, and
// it must only ever LISTEN — any outbound request API is a test failure.)
import { createServer } from "node:http";
import { resolveDataDir, resolvePort, detectSyncRoot } from "../config.mjs";
import { createStore, LockHeldError } from "./store.mjs";
import { FutureVersionError } from "../model/migrate.mjs";
import { createApi } from "./api.mjs";

const dataDir = resolveDataDir();
const port = resolvePort();

const syncRoot = detectSyncRoot(dataDir);
if (syncRoot) {
  process.stderr.write(
    `runway: WARNING — data dir ${dataDir} sits inside ${syncRoot}, a cloud-synced folder; your financial data would be uploaded — move it with --data-dir\n`
  );
}

const store = createStore(dataDir);
const api = (() => {
  try {
    store.init();
    return createApi(store);
  } catch (e) {
    if (e instanceof LockHeldError || e instanceof FutureVersionError) {
      process.stderr.write(`runway: ${e.message}\n`);
      store.close();
      process.exit(1);
    }
    throw e;
  }
})();

const server = createServer(api);

server.on("error", (err) => {
  if (/** @type {NodeJS.ErrnoException} */ (err).code === "EADDRINUSE") {
    // No liveness probe on purpose — a loopback HTTP client call here would
    // trip the egress source guard (simplification sanctioned by review).
    process.stderr.write(
      `port ${port} in use — if Runway is already running, open http://localhost:${port}; otherwise pass --port {other}\n`
    );
    store.close();
    process.exit(1);
  }
  throw err;
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`runway: data dir ${dataDir}\n`);
  process.stdout.write(`runway: serving on http://localhost:${port}\n`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    store.appendShutdownTrend();
  } catch (e) {
    process.stderr.write(`runway: shutdown trend failed: ${e instanceof Error ? e.message : e}\n`);
  }
  store.close();
  server.close(() => process.exit(0));
  // Open keep-alive connections must not wedge shutdown.
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
