// API tests: the real handler on a real ephemeral server. Tests run in file
// order and thread rev through GET /health rather than assuming counts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { createStore } from "../src/server/store.mjs";
import { createApi } from "../src/server/api.mjs";
import { placeholderState } from "../src/model/placeholder.mjs";
import { SCHEMA_VERSION } from "../src/model/schema.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let dir;
let store;
let server;
let base;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "runway-api-"));
  store = createStore(dir);
  store.init();
  server = createServer(createApi(store));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function getJson(path) {
  const res = await fetch(base + path);
  return { status: res.status, headers: res.headers, body: await res.json() };
}

async function sendJson(method, path, payload) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function currentRev() {
  return (await getJson("/health")).body.rev;
}

test("GET /api/state unseeded returns the placeholder, seeded:false, rev 0", async () => {
  const { status, headers, body } = await getJson("/api/state");
  assert.equal(status, 200);
  assert.ok(headers.get("content-type").startsWith("application/json"));
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(body.seeded, false);
  assert.equal(body.rev, 0);
  assert.deepEqual(body.state, placeholderState());
  assert.ok(!existsSync(join(dir, "current.json")), "GET never seeds the disk");
});

test("PUT /api/state with baseRev saves and increments rev", async () => {
  const state = placeholderState();
  state.portfolio.balance = 1_234_567;
  const { status, body } = await sendJson("PUT", "/api/state", { state, baseRev: 0 });
  assert.equal(status, 200);
  assert.equal(body.rev, 1);
  assert.deepEqual(body.warnings, []);
  const after1 = await getJson("/api/state");
  assert.equal(after1.body.seeded, true);
  assert.equal(after1.body.state.portfolio.balance, 1_234_567);
});

test("stale baseRev → 409 with current rev; disk unchanged", async () => {
  const state = placeholderState();
  state.portfolio.balance = 55;
  const { status, body } = await sendJson("PUT", "/api/state", { state, baseRev: 0 });
  assert.equal(status, 409);
  assert.equal(body.rev, 1);
  const onDisk = JSON.parse(readFileSync(join(dir, "current.json"), "utf8"));
  assert.equal(onDisk.portfolio.balance, 1_234_567, "stale write never lands");
});

test("PUT with text in a numeric field → 400 naming the path", async () => {
  const state = placeholderState();
  state.properties[0].rentMonthly = "lots";
  const { status, body } = await sendJson("PUT", "/api/state", { state, baseRev: await currentRev() });
  assert.equal(status, 400);
  assert.ok(body.errors.some((e) => e.path === "properties[0].rentMonthly" && /number/.test(e.message)));
});

test("PUT with a malformed JSON body → 400", async () => {
  const res = await fetch(base + "/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
});

test("restore endpoint: 409 on stale rev, 404 on unknown file, 200 round-trip", async () => {
  // Make current differ from the day's first-save snapshot.
  const rev = await currentRev();
  const changed = placeholderState();
  changed.portfolio.balance = 42;
  await sendJson("PUT", "/api/state", { state: changed, baseRev: rev });

  const snaps = (await getJson("/api/snapshots")).body.snapshots;
  assert.ok(snaps.length >= 1);
  const snap = snaps.find((s) => s.source === "edit");
  assert.ok(snap.ts && snap.file, "listing carries file + ts");

  const stale = await sendJson("POST", "/api/restore", { file: snap.file, baseRev: rev + 999 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.rev, rev + 1);

  const unknown = await sendJson("POST", "/api/restore", { file: "nope.json", baseRev: rev + 1 });
  assert.equal(unknown.status, 404);

  const traversal = await sendJson("POST", "/api/restore", { file: "../current.json", baseRev: rev + 1 });
  assert.equal(traversal.status, 404, "file param is validated against the listing");

  const ok = await sendJson("POST", "/api/restore", { file: snap.file, baseRev: rev + 1 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.rev, rev + 2);
  const state = (await getJson("/api/state")).body.state;
  assert.equal(state.portfolio.balance, 1_234_567, "snapshot content restored");
});

test("GET /api/trends parses rows and skips a hand-planted torn line", async () => {
  const beforeRows = (await getJson("/api/trends")).body.rows;
  assert.ok(beforeRows.length >= 1);
  assert.ok(beforeRows.every((r) => r.v === 1 && typeof r.rev === "number"));
  appendFileSync(join(dir, "trends.jsonl"), '{"v":1,"ts":"torn');
  const rows = (await getJson("/api/trends")).body.rows;
  assert.equal(rows.length, beforeRows.length, "torn line skipped");
});

test("GET /health exposes identity UUID and version, never the data-dir path", async () => {
  const { status, body } = await getJson("/health");
  assert.equal(status, 200);
  assert.equal(body.app, "runway");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(body.version, pkg.version);
  assert.match(body.identity, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(typeof body.rev, "number");
  assert.ok(!JSON.stringify(body).includes(dir), "no data-dir path leaks");
});

test("POST /api/import/v0 migrates a v0 export; bad payloads → 400", async () => {
  const v0 = {
    profile: { currentAge: 40, endAge: 92, currentYear: 2026 },
    portfolio: { balance: 900000, realReturnPct: 4.0 },
    incomes: [{ name: "W2", annual: 180000, fromYear: 2026 }],
    spending: [{ name: "living", monthly: 2500 }],
    endState: { mode: "bequest", amount: 500000 },
  };
  const rev = await currentRev();

  const bad = await sendJson("POST", "/api/import/v0", { data: 42, baseRev: rev });
  assert.equal(bad.status, 400);

  const stale = await sendJson("POST", "/api/import/v0", { data: v0, baseRev: rev - 1 });
  assert.equal(stale.status, 409);

  const ok = await sendJson("POST", "/api/import/v0", { data: v0, baseRev: rev });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.rev > rev);
  const state = (await getJson("/api/state")).body.state;
  assert.equal(state.schemaVersion, SCHEMA_VERSION);
  assert.equal(state.endState.amounts.bequest, 500000);
});

test("POST /api/reset snapshots current, returns to unseeded placeholder; 409 on stale rev", async () => {
  const rev = await currentRev();

  const stale = await sendJson("POST", "/api/reset", { baseRev: rev - 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.rev, rev);

  const bad = await sendJson("POST", "/api/reset", {});
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.some((e) => e.path === "baseRev"));

  const snapsBefore = (await getJson("/api/snapshots")).body.snapshots.length;
  const ok = await sendJson("POST", "/api/reset", { baseRev: rev });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.rev, rev + 1);
  assert.ok(!existsSync(join(dir, "current.json")), "current.json deleted");
  const snapsAfter = (await getJson("/api/snapshots")).body.snapshots.length;
  assert.equal(snapsAfter, snapsBefore + 1, "pre-reset state preserved as a snapshot");

  const after = await getJson("/api/state");
  assert.equal(after.body.seeded, false, "unseeded semantics return");
  assert.deepEqual(after.body.state, placeholderState(), "placeholder renders, nothing on disk");
});

function freePort() {
  return new Promise((resolve) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test("index.mjs boots, serves /health, exits 0 on SIGTERM and releases the lock", async () => {
  const childDir = mkdtempSync(join(tmpdir(), "runway-index-"));
  const port = await freePort();
  const child = spawn(
    process.execPath,
    ["src/server/index.mjs", "--port", String(port), "--data-dir", childDir],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  try {
    const deadline = Date.now() + 8000;
    let health = null;
    while (Date.now() < deadline && !health) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) health = await res.json();
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.ok(health, `server never came up; stderr: ${stderr}`);
    assert.equal(health.app, "runway");
    assert.ok(existsSync(join(childDir, "runway.lock")));

    const exited = new Promise((resolve) => child.on("exit", resolve));
    child.kill("SIGTERM");
    assert.equal(await exited, 0, `non-zero exit; stderr: ${stderr}`);
    assert.ok(!existsSync(join(childDir, "runway.lock")), "lock released on shutdown");
  } finally {
    child.kill("SIGKILL");
    rmSync(childDir, { recursive: true, force: true });
  }
});
