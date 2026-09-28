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

test("GET /api/state unseeded returns the placeholder, seeded:false, rev 0, one Base-plan scenario", async () => {
  const { status, headers, body } = await getJson("/api/state");
  assert.equal(status, 200);
  assert.ok(headers.get("content-type").startsWith("application/json"));
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(body.seeded, false);
  assert.equal(body.rev, 0);
  // Placeholder is re-anchored to the real current year; in 2026 that's identity.
  assert.deepEqual(body.state, placeholderState());
  // The unseeded view still surfaces the scenario bar: one "Base plan".
  assert.equal(body.scenarios.length, 1);
  assert.equal(body.scenarios[0].name, "Base plan");
  assert.equal(body.activeId, body.scenarios[0].id, "activeId points at the sole scenario");
  assert.ok(!existsSync(join(dir, "current.json")), "GET never seeds the disk");
});

test("PUT /api/state with baseRev saves and increments rev", async () => {
  const state = placeholderState();
  state.accounts[0].balance = 1_234_567;
  const { status, body } = await sendJson("PUT", "/api/state", { state, baseRev: 0 });
  assert.equal(status, 200);
  assert.equal(body.rev, 1);
  assert.deepEqual(body.warnings, []);
  const after1 = await getJson("/api/state");
  assert.equal(after1.body.seeded, true);
  assert.equal(after1.body.state.accounts[0].balance, 1_234_567);
});

test("stale baseRev → 409 with current rev; disk unchanged", async () => {
  const state = placeholderState();
  state.accounts[0].balance = 55;
  const { status, body } = await sendJson("PUT", "/api/state", { state, baseRev: 0 });
  assert.equal(status, 409);
  assert.equal(body.rev, 1);
  // current.json is a workspace — read the active scenario's state.
  const onDisk = JSON.parse(readFileSync(join(dir, "current.json"), "utf8"));
  const onDiskState = onDisk.scenarios.find((s) => s.id === onDisk.activeId).state;
  assert.equal(onDiskState.accounts[0].balance, 1_234_567, "stale write never lands");
});

test("PUT with text in a numeric field → 400 naming the path", async () => {
  const state = placeholderState();
  state.spending[0].monthly = "lots";
  const { status, body } = await sendJson("PUT", "/api/state", { state, baseRev: await currentRev() });
  assert.equal(status, 400);
  assert.ok(body.errors.some((e) => e.path === "spending[0].monthly" && /number/.test(e.message)));
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
  changed.accounts[0].balance = 42;
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
  assert.equal(state.accounts[0].balance, 1_234_567, "snapshot content restored");
});

test("GET /api/trends parses rows and skips a hand-planted torn line", async () => {
  const beforeRows = (await getJson("/api/trends")).body.rows;
  assert.ok(beforeRows.length >= 1);
  assert.ok(beforeRows.every((r) => r.v === 4 && typeof r.rev === "number"));
  appendFileSync(join(dir, "trends.jsonl"), '{"v":4,"ts":"torn');
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

// --- Scenario endpoints -----------------------------------------------------
// The store is unseeded again after the reset test above. Seed it with a known
// active state, then exercise create / switch / rename / delete. Tests run in
// file order and thread rev via /health, so each step reads the live rev.

test("POST /api/scenarios/create mode:copy duplicates the active scenario's state and makes it active", async () => {
  // Re-seed the active scenario with a recognizable balance.
  const seed = placeholderState();
  seed.accounts[0].balance = 2_222_222;
  const seeded = await sendJson("PUT", "/api/state", { state: seed, baseRev: await currentRev() });
  assert.equal(seeded.status, 200);

  const before = await getJson("/api/state");
  assert.equal(before.body.scenarios.length, 1, "one scenario before create");

  const rev = await currentRev();
  const res = await sendJson("POST", "/api/scenarios/create", { name: "Copy plan", mode: "copy", baseRev: rev });
  assert.equal(res.status, 200);
  assert.equal(res.body.rev, rev + 1, "create bumps the rev");
  assert.equal(res.body.scenarios.length, 2, "scenario list grows");
  assert.equal(res.body.scenarios[1].name, "Copy plan");
  assert.equal(res.body.activeId, res.body.scenarios[1].id, "the new scenario becomes active");
  assert.equal(res.body.state.accounts[0].balance, 2_222_222, "copy duplicates the active state");

  // GET reflects the new active scenario and the two-entry bar.
  const state = await getJson("/api/state");
  assert.equal(state.body.activeId, res.body.activeId);
  assert.equal(state.body.scenarios.length, 2);
  assert.equal(state.body.state.accounts[0].balance, 2_222_222);
});

test("POST /api/scenarios/create mode:scratch adds a fresh empty-default plan (not a copy), made active", async () => {
  const rev = await currentRev();
  const res = await sendJson("POST", "/api/scenarios/create", { name: "Scratch plan", mode: "scratch", baseRev: rev });
  assert.equal(res.status, 200);
  assert.equal(res.body.scenarios.length, 3, "list grows again");
  assert.equal(res.body.scenarios[2].name, "Scratch plan");
  assert.equal(res.body.activeId, res.body.scenarios[2].id, "scratch scenario becomes active");
  // Fresh default is an empty plan (no accounts, no spending), NOT a copy of
  // the 2,222,222 active state.
  assert.equal(res.body.state.accounts.length, 0, "scratch is a fresh default (no accounts), not a copy");
  assert.equal(res.body.state.spending.length, 0);
});

test("POST /api/scenarios/switch changes the active state; 404 unknown; 409 stale", async () => {
  const list = (await getJson("/api/state")).body.scenarios;
  const copyId = list[1].id; // the 2,222,222 "Copy plan"

  // 409 on a stale baseRev — nothing switches.
  const stale = await sendJson("POST", "/api/scenarios/switch", { id: copyId, baseRev: (await currentRev()) - 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.rev, await currentRev());

  // 404 on an unknown id.
  const unknown = await sendJson("POST", "/api/scenarios/switch", { id: "does-not-exist", baseRev: await currentRev() });
  assert.equal(unknown.status, 404);

  // 200: switching back to the copy makes its state active again.
  const rev = await currentRev();
  const ok = await sendJson("POST", "/api/scenarios/switch", { id: copyId, baseRev: rev });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.rev, rev + 1);
  assert.equal(ok.body.activeId, copyId);
  assert.equal(ok.body.state.accounts[0].balance, 2_222_222, "active state follows the pointer");
  assert.equal((await getJson("/api/state")).body.activeId, copyId);
});

test("POST /api/scenarios/rename renames a scenario; 404 unknown", async () => {
  const list = (await getJson("/api/state")).body.scenarios;
  const targetId = list[2].id; // the "Scratch plan"

  const unknown = await sendJson("POST", "/api/scenarios/rename", { id: "ghost", name: "X", baseRev: await currentRev() });
  assert.equal(unknown.status, 404);

  const rev = await currentRev();
  const ok = await sendJson("POST", "/api/scenarios/rename", { id: targetId, name: "Renamed plan", baseRev: rev });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.rev, rev + 1);
  assert.equal(ok.body.scenarios.find((s) => s.id === targetId).name, "Renamed plan");
  assert.equal((await getJson("/api/state")).body.scenarios.find((s) => s.id === targetId).name, "Renamed plan");
});

test("POST /api/scenarios/delete removes a scenario; deleting the active one reassigns active", async () => {
  const before = (await getJson("/api/state")).body;
  const activeId = before.activeId; // the "Copy plan" is active (from the switch test)
  assert.equal(before.scenarios.length, 3, "three scenarios before delete");

  const rev = await currentRev();
  const ok = await sendJson("POST", "/api/scenarios/delete", { id: activeId, baseRev: rev });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.rev, rev + 1);
  assert.equal(ok.body.scenarios.length, 2, "one fewer scenario");
  assert.ok(!ok.body.scenarios.some((s) => s.id === activeId), "the deleted scenario is gone");
  assert.notEqual(ok.body.activeId, activeId, "active reassigned off the deleted scenario");
  assert.equal(ok.body.activeId, ok.body.scenarios[0].id, "active reassigned to the first remaining");
  // The returned state is the newly-active scenario's state.
  const state = (await getJson("/api/state")).body;
  assert.equal(state.activeId, ok.body.activeId);
  assert.deepEqual(state.state, ok.body.state);
});

test("POST /api/scenarios/delete refuses the LAST scenario with 400", async () => {
  // Delete down to one, then the last delete is refused.
  let list = (await getJson("/api/state")).body.scenarios;
  while (list.length > 1) {
    const nonActive = list.find((s) => s.id !== list[0].id) ?? list[list.length - 1];
    const del = await sendJson("POST", "/api/scenarios/delete", { id: nonActive.id, baseRev: await currentRev() });
    assert.equal(del.status, 200);
    list = del.body.scenarios;
  }
  assert.equal(list.length, 1, "down to a single scenario");

  const refuse = await sendJson("POST", "/api/scenarios/delete", { id: list[0].id, baseRev: await currentRev() });
  assert.equal(refuse.status, 400, "the last scenario cannot be deleted");
  assert.ok(refuse.body.errors.some((e) => /cannot delete the last scenario/.test(e.message)));
  assert.equal((await getJson("/api/state")).body.scenarios.length, 1, "still one scenario");
});

test("scenario endpoints reject a non-JSON content type with 415", async () => {
  const res = await fetch(base + "/api/scenarios/create", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ name: "X", baseRev: 0 }),
  });
  assert.equal(res.status, 415, "mutations must declare application/json");
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
