// Security-envelope tests: host/origin guards, no-CORS invariant, content-type
// and body-size enforcement, path traversal, and response-header hygiene.
// Uses a raw node:http client because fetch strips forbidden headers (Host)
// and normalizes some traversal paths client-side.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { createStore } from "../src/server/store.mjs";
import { createApi } from "../src/server/api.mjs";
import { placeholderState } from "../src/model/placeholder.mjs";
import { makeWorkspace } from "../src/model/workspace.mjs";

let dir;
let publicDir;
let store;
let server; // with a public/ containing index.html
let bareServer; // nonexistent public/ root — a missing UI must 404, never crash
let port;
let barePort;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "runway-sec-"));
  publicDir = mkdtempSync(join(tmpdir(), "runway-sec-public-"));
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, "index.html"), "<!doctype html><html><body>runway</body></html>");

  store = createStore(dir);
  store.init();
  store.save(makeWorkspace({ id: "s1", state: placeholderState() })); // seeded, rev 1

  server = createServer(createApi(store, { publicDir }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;

  bareServer = createServer(createApi(store, { publicDir: join(publicDir, "does-not-exist") }));
  await new Promise((resolve) => bareServer.listen(0, "127.0.0.1", resolve));
  barePort = bareServer.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => bareServer.close(resolve));
  store.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(publicDir, { recursive: true, force: true });
});

/** Raw HTTP client: full control over Host/Origin/path (fetch interferes). */
function raw({ method = "GET", path = "/", headers = {}, body = null, toPort = null }) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: toPort ?? port, method, path, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function currentBytes() {
  return readFileSync(join(dir, "current.json"), "utf8");
}

async function healthRev() {
  const res = await raw({ path: "/health" });
  return JSON.parse(res.body).rev;
}

function putBody(balance, baseRev) {
  const state = placeholderState();
  state.portfolio.balance = balance;
  return JSON.stringify({ state, baseRev });
}

test("Host: evil.com → 403 on GET and PUT; nothing written", async () => {
  const beforeBytes = currentBytes();
  const get = await raw({ path: "/api/state", headers: { Host: "evil.com" } });
  assert.equal(get.status, 403);

  const put = await raw({
    method: "PUT",
    path: "/api/state",
    headers: { Host: "evil.com", "Content-Type": "application/json" },
    body: putBody(1, await healthRev()),
  });
  assert.equal(put.status, 403);
  assert.equal(currentBytes(), beforeBytes, "rebinding host never writes");
});

test("allowed hosts: localhost and [::1] variants pass the host guard", async () => {
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, "localhost"]) {
    const res = await raw({ path: "/health", headers: { Host: host } });
    assert.equal(res.status, 200, `host ${host} should be allowed`);
  }
});

test("Origin: https://evil.com on PUT → 403 before parse; state unchanged", async () => {
  const beforeBytes = currentBytes();
  const res = await raw({
    method: "PUT",
    path: "/api/state",
    headers: { Origin: "https://evil.com", "Content-Type": "application/json" },
    body: putBody(2, await healthRev()), // valid JSON, correct rev — guard must fire first
  });
  assert.equal(res.status, 403);
  assert.equal(currentBytes(), beforeBytes);
});

test("loopback Origin on the bound port is allowed to mutate", async () => {
  const rev = await healthRev();
  const res = await raw({
    method: "PUT",
    path: "/api/state",
    headers: { Origin: `http://localhost:${port}`, "Content-Type": "application/json" },
    body: putBody(3_000_000, rev),
  });
  assert.equal(res.status, 200);
});

test("Origin-absent invariant: no-Origin mutations pass the origin gate ONLY for non-CORS-simple content types", async () => {
  // The origin guard deliberately lets Origin-less requests through — safe
  // only while every accepted content type is non-CORS-simple. Pin both halves:
  // (1) a no-Origin application/json mutation is never 403'd by the guard…
  const rev = await healthRev();
  const ok = await raw({
    method: "PUT",
    path: "/api/state",
    headers: { "Content-Type": "application/json" }, // NO Origin header
    body: putBody(4_000_000, rev),
  });
  assert.notEqual(ok.status, 403, "no-Origin JSON must not be rejected by the origin guard");
  assert.equal(ok.status, 200);

  // …(2) and a no-Origin CORS-simple content type (text/plain) is refused by
  // the content-type gate — the invariant the allowance depends on.
  const plain = await raw({
    method: "POST",
    path: "/api/restore",
    headers: { "Content-Type": "text/plain" }, // NO Origin header
    body: "{}",
  });
  assert.equal(plain.status, 415, "CORS-simple content types stay locked out of mutations");
});

test("no Access-Control-Allow-* header, ever (OPTIONS and normal responses)", async () => {
  for (const opts of [
    { method: "OPTIONS", path: "/api/state", headers: { Origin: "https://evil.com" } },
    { path: "/api/state" },
    { path: "/health" },
    { path: "/engine/simulate.mjs" },
  ]) {
    const res = await raw(opts);
    const acao = Object.keys(res.headers).filter((h) => h.toLowerCase().startsWith("access-control-allow"));
    assert.deepEqual(acao, [], `${opts.method ?? "GET"} ${opts.path} must not emit ${acao}`);
  }
});

test("POST /api/restore with Content-Type text/plain → 415, nothing restored", async () => {
  const rev = await healthRev();
  const snaps = JSON.parse((await raw({ path: "/api/snapshots" })).body).snapshots;
  const res = await raw({
    method: "POST",
    path: "/api/restore",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ file: snaps[0].file, baseRev: rev }),
  });
  assert.equal(res.status, 415);
  assert.equal(await healthRev(), rev, "no restore happened");
});

test("PUT body over 5MB → 413, state unchanged", async () => {
  const beforeBytes = currentBytes();
  const rev = await healthRev();
  const res = await raw({
    method: "PUT",
    path: "/api/state",
    headers: { "Content-Type": "application/json" },
    body: `{"baseRev":${rev},"filler":"${"a".repeat(5 * 1024 * 1024)}"}`,
  });
  assert.equal(res.status, 413);
  assert.equal(currentBytes(), beforeBytes);
  assert.equal(await healthRev(), rev);
});

test("path traversal variants all 404", async () => {
  const paths = [
    "/../src/server/store.mjs",
    "/%2e%2e%2fsrc%2fserver%2fstore.mjs",
    "/engine/../server/store.mjs",
    "/engine/..%2f..%2fpackage.json",
    "/model/../../config.mjs",
    "/engine/..%5C..%5Csrc%5Cconfig.mjs", // encoded ..\ Windows variant
    "/engine/..\\..\\src\\config.mjs", // raw ..\ Windows variant
    "/%2e%2e/%2e%2e/etc/passwd",
    "/engine/%00simulate.mjs",
  ];
  for (const p of paths) {
    const res = await raw({ path: p });
    assert.equal(res.status, 404, `${p} must 404, got ${res.status}`);
  }
});

test("static serving: engine/model modules served, no directory listings", async () => {
  const sim = await raw({ path: "/engine/simulate.mjs" });
  assert.equal(sim.status, 200);
  assert.ok(sim.headers["content-type"].startsWith("text/javascript"));
  assert.equal(sim.headers["x-content-type-options"], "nosniff");
  assert.ok(sim.body.includes("export function simulate"));

  const schema = await raw({ path: "/model/schema.mjs" });
  assert.equal(schema.status, 200);

  for (const p of ["/engine/", "/model/", "/engine"]) {
    const res = await raw({ path: p });
    assert.equal(res.status, 404, `${p} must not list or serve a directory`);
  }
});

test("HTML responses carry the CSP header; missing public/ 404s gracefully", async () => {
  const html = await raw({ path: "/" });
  assert.equal(html.status, 200);
  assert.ok(html.headers["content-type"].startsWith("text/html"));
  assert.equal(
    html.headers["content-security-policy"],
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
  assert.ok(html.headers["content-security-policy"].includes("frame-ancestors 'none'"), "clickjacking defense pinned");

  // The bare server's public/ root doesn't exist: / must 404, not crash —
  // and the HTML-less check: engine module still serves fine.
  const bare = await raw({ path: "/", toPort: barePort });
  assert.equal(bare.status, 404);
  const bareEngine = await raw({ path: "/engine/simulate.mjs", toPort: barePort });
  assert.equal(bareEngine.status, 200);
  assert.equal(bareEngine.headers["content-security-policy"], undefined, "CSP is for HTML responses");
});

test("X-Content-Type-Options: nosniff on everything, including 404s", async () => {
  for (const p of ["/api/state", "/health", "/nope", "/engine/simulate.mjs", "/api/trends"]) {
    const res = await raw({ path: p });
    assert.equal(res.headers["x-content-type-options"], "nosniff", `missing nosniff on ${p}`);
  }
});
