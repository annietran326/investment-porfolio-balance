// End-to-end scenario-bar smoke test in a real browser: boots the server on an
// ephemeral port + temp data dir, loads the app in headless Chrome, and drives
// the workspace layer through CDP —
//   (1) the bar renders with a "Base plan" pill,
//   (2) seeding the plan (an edit) then creating a scenario adds a second pill
//       and makes it active,
//   (3) switching back to the first pill re-renders the whole app (the verdict
//       reflects the switched-to plan) without a page reload.
// Chrome is required; skipped locally when absent, hard failure in CI — same
// discipline as smoke-render.test.mjs, whose CDP client this mirrors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, readFileSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/server/store.mjs";
import { createApi } from "../src/server/api.mjs";

function findChrome() {
  const candidates = [
    process.env.RUNWAY_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      accessSync(/** @type {string} */ (c), constants.X_OK);
      return c;
    } catch {}
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try {
      const p = execFileSync("which", [name], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      if (p) return p;
    } catch {}
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Best-effort recursive remove. Chrome is multi-process: even after the launcher
// exits, its renderer/GPU children keep touching the profile dir, so a single
// rmSync races them and the rmdir throws ENOTEMPTY/EBUSY. Retry through the race,
// then give up quietly — a leftover /tmp dir (the OS reaps it) must never fail a
// test that already made its assertions.
async function rmDirBestEffort(dir) {
  for (let i = 0; i < 15; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(100);
    }
  }
}

/** Minimal zero-dependency CDP client over Node's global WebSocket. */
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d.result);
      pending.delete(d.id);
    } else if (d.method) {
      for (const fn of listeners) fn(d);
    }
  };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  return {
    send: (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }),
    on: (fn) => listeners.push(fn),
    close: () => ws.close(),
  };
}

test("scenario bar: renders, creates a pill, and switching re-renders the app", { timeout: 45_000 }, async (t) => {
  const chrome = findChrome();
  if (!chrome) {
    const msg = "Chrome not found — set RUNWAY_CHROME or install Google Chrome / Chromium.";
    if (process.env.CI) assert.fail(`${msg} (required in CI so the scenario smoke test can't silently skip)`);
    return t.skip(msg);
  }

  const dataDir = mkdtempSync(join(tmpdir(), "runway-scen-"));
  const profileDir = mkdtempSync(join(tmpdir(), "runway-chrome-"));
  const store = createStore(dataDir);
  store.init();
  const server = createServer(createApi(store));
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const port = /** @type {any} */ (server.address()).port;
  const appUrl = `http://127.0.0.1:${port}/`;

  const child = spawn(chrome, [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ], { stdio: "ignore" });

  /** @type {Awaited<ReturnType<typeof cdp>> | null} */
  let client = null;
  try {
    let devtoolsPort = null;
    for (let i = 0; i < 100 && devtoolsPort === null; i++) {
      try {
        devtoolsPort = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0].trim();
      } catch {
        await sleep(100);
      }
    }
    assert.ok(devtoolsPort, "Chrome did not expose a DevTools port");

    const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
    const page = targets.find((x) => x.type === "page");
    assert.ok(page?.webSocketDebuggerUrl, "no page target from Chrome");
    client = await cdp(page.webSocketDebuggerUrl);

    const errors = [];
    client.on((d) => {
      if (d.method === "Log.entryAdded" && d.params.entry.level === "error") errors.push(d.params.entry.text + (d.params.entry.url ? ` @ ${d.params.entry.url}` : ""));
      if (d.method === "Runtime.exceptionThrown") errors.push("EXCEPTION: " + (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text));
    });
    await client.send("Log.enable");
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Page.navigate", { url: appUrl });
    await sleep(4000);

    const ev = async (expr) => (await client.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

    // (1) the bar renders a single "Base plan" pill on boot.
    const bootPills = await ev('document.querySelectorAll("#scenarioBar .scenario-pill-name").length');
    assert.equal(bootPills, 1, "boot shows exactly one scenario pill");
    const baseName = await ev('document.querySelector("#scenarioBar .scenario-pill-name")?.textContent ?? ""');
    assert.equal(baseName, "Base plan", 'the sole boot pill is "Base plan"');

    // (2) Seed the plan by driving an edit through the pipeline, then create a
    //     copy scenario via the API round-trip the bar uses (bypassing prompt()).
    //     We drive fetch directly with the live rev, then call the app's own
    //     re-render path by clicking the newly-added non-active pill later.
    const seededRev = await ev(`(async () => {
      const bal = document.getElementById("f-balance");
      bal.value = "1234567";
      bal.dispatchEvent(new Event("input", { bubbles: true }));
      // wait for the debounced save (1500ms) to land, then read the rev
      await new Promise(r => setTimeout(r, 2200));
      const s = await (await fetch("/api/state")).json();
      return s.rev;
    })()`);
    assert.ok(typeof seededRev === "number" && seededRev >= 1, "an edit seeded the plan and bumped the rev");

    // Create a scenario the way the bar does (copy of active). We POST directly
    // to mirror the button, then reload once so the fresh workspace is the boot
    // state for the switch assertions below — the create itself is exercised in
    // barModel/createPayload unit tests; here we prove the SWITCH re-render.
    const created = await ev(`(async () => {
      const cur = await (await fetch("/api/state")).json();
      const res = await fetch("/api/scenarios/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Aggressive", mode: "scratch", baseRev: cur.rev }),
      });
      return { status: res.status, body: await res.json() };
    })()`);
    assert.equal(created.status, 200, "create returned 200");
    assert.equal(created.body.scenarios.length, 2, "workspace now has two scenarios");

    await client.send("Page.navigate", { url: appUrl });
    await sleep(4000);

    // Two pills now; the newly-created "Aggressive" is active.
    const pillCount = await ev('document.querySelectorAll("#scenarioBar .scenario-pill-name").length');
    assert.equal(pillCount, 2, "the created scenario added a second pill");
    const activeName = await ev('document.querySelector("#scenarioBar .scenario-pill.active .scenario-pill-name")?.textContent ?? ""');
    assert.equal(activeName, "Aggressive", "the created scenario is active");

    // The active plan ("Aggressive", a fresh/empty plan) has a $0 balance,
    // distinct from "Base plan" (which we set to 1,234,567) — proof the switch
    // will actually change what's rendered.
    const activeBalance = await ev('document.getElementById("f-balance")?.value ?? ""');
    assert.notEqual(activeBalance, "1234567", "the fresh scenario is not the seeded base plan");

    // (3) Click the non-active "Base plan" pill → the whole app re-renders for
    //     it WITHOUT a reload. The balance field flips back to the seeded value.
    await ev(`(() => {
      const pills = [...document.querySelectorAll("#scenarioBar .scenario-pill")];
      const base = pills.find(p => p.querySelector(".scenario-pill-name")?.textContent === "Base plan");
      base.querySelector(".scenario-pill-name").click();
    })()`);
    await sleep(1500);

    const afterSwitchBalance = await ev('document.getElementById("f-balance")?.value ?? ""');
    assert.equal(afterSwitchBalance, "1234567", "switching re-rendered the app for the base plan (no reload)");
    const afterSwitchActive = await ev('document.querySelector("#scenarioBar .scenario-pill.active .scenario-pill-name")?.textContent ?? ""');
    assert.equal(afterSwitchActive, "Base plan", "the base pill is now the active one");
    const verdict = await ev('document.getElementById("verdictHeadline")?.textContent ?? ""');
    assert.ok(verdict.length > 0, "the verdict re-rendered non-blank after the switch");

    const realErrors = errors.filter((e) => !/favicon\.ico/.test(e));
    assert.deepEqual(realErrors, [], `browser reported resource/JS errors:\n${realErrors.join("\n")}`);
  } finally {
    client?.close();
    // Wait for Chrome to ACTUALLY exit before deleting its profile dir. kill()
    // only sends the signal; if Chrome is still flushing the profile to disk,
    // rmSync races it (new files appear mid-delete) and the final rmdir throws
    // ENOTEMPTY — the flaky teardown that reddens CI. Arm the exit listener
    // before killing so the event is never missed; skip if already exited.
    const exited = child.exitCode === null && child.signalCode === null ? once(child, "exit") : Promise.resolve();
    child.kill("SIGKILL");
    await exited;
    await new Promise((res) => server.close(res));
    rmSync(dataDir, { recursive: true, force: true });
    await rmDirBestEffort(profileDir);
  }
});
