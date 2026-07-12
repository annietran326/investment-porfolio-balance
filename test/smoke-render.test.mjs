// End-to-end render smoke test — the guard that would have caught the v2
// blank-app bug. Every other test runs in Node against the filesystem, so none
// of them exercise the browser's module resolution (a public/ module importing
// a path the server doesn't serve 404s only in a browser). This test boots the
// real server, loads the app in real headless Chrome, and asserts it actually
// paints: the boot ran, the verdict is non-blank, rows rendered, and NO
// resource failed to load (the 404 that silently killed the module graph).
//
// Chrome is required. Locally it's skipped when Chrome isn't found; in CI a
// missing Chrome is a hard failure (a silently-skipped smoke test is worse than
// none). Point RUNWAY_CHROME at a binary to override discovery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
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

test("the app renders in a real browser (boot runs, verdict + rows paint, no failed loads)", { timeout: 45_000 }, async (t) => {
  const chrome = findChrome();
  if (!chrome) {
    const msg = "Chrome not found — set RUNWAY_CHROME or install Google Chrome / Chromium.";
    if (process.env.CI) assert.fail(`${msg} (required in CI so the render smoke test can't silently skip)`);
    return t.skip(msg);
  }

  const dataDir = mkdtempSync(join(tmpdir(), "runway-smoke-"));
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
    "--no-sandbox", // required when CI runs as root
    "--disable-dev-shm-usage",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ], { stdio: "ignore" });

  /** @type {Awaited<ReturnType<typeof cdp>> | null} */
  let client = null;
  try {
    // Chrome writes DevToolsActivePort once the debugging endpoint is up.
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
    await sleep(4000); // let the module graph load, fetch /api/state, and render

    const ev = async (expr) => (await client.send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value;

    const presetButtons = await ev('document.querySelectorAll("#agePresets button").length');
    const verdict = await ev('document.getElementById("verdictHeadline")?.textContent ?? ""');
    const scenarioRows = await ev('document.querySelectorAll("#scenarioRows > tr").length');
    const balance = await ev('document.getElementById("f-balance")?.value ?? ""');

    // favicon 404 is benign (not part of the module graph) — everything else must load.
    const realErrors = errors.filter((e) => !/favicon\.ico/.test(e));

    assert.deepEqual(realErrors, [], `browser reported resource/JS errors:\n${realErrors.join("\n")}`);
    assert.equal(presetButtons, 3, "boot did not run (age-preset buttons never appended)");
    assert.ok(verdict.length > 0, "verdict headline is blank — results never rendered");
    assert.equal(scenarioRows, 5, "scenario table did not populate");
    assert.ok(balance.length > 0, "balance field never populated from state");
  } finally {
    client?.close();
    child.kill("SIGKILL");
    await new Promise((res) => server.close(res));
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
  }
});
