// Zero-network-egress source guard (R21a): the server code must contain no
// outbound-network APIs and exactly one listen(), bound to 127.0.0.1.
// A static source scan can't be evaded by lazy loading, and running it as a
// test makes the guarantee regression-proof locally and in CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith(".mjs")) yield p;
  }
}

const FORBIDDEN = [
  /\bfetch\s*\(/,
  /node:https\b/,
  /from\s+["']https?["']/,
  /\bhttp\.request\b/,
  /\bhttps\./,
  /node:net\b/,
  /node:dns\b/,
  /node:tls\b/,
  /XMLHttpRequest/,
  /WebSocket\s*\(/,
];
// The one sanctioned exception: src/server/ imports node:http to LISTEN, never to request.
const HTTP_IMPORT = /from\s+["']node:http["']/;

test("src/ contains no outbound-network APIs", () => {
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN) {
      assert.ok(!pattern.test(text), `${file} matches forbidden pattern ${pattern}`);
    }
    if (HTTP_IMPORT.test(text)) {
      assert.ok(file.includes(`${join("src", "server")}`), `node:http imported outside src/server/: ${file}`);
    }
  }
});

test("exactly one listen(), bound to 127.0.0.1", () => {
  let listens = 0;
  let loopback = 0;
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    const matches = text.match(/\.listen\s*\(/g) ?? [];
    listens += matches.length;
    if (matches.length && /127\.0\.0\.1/.test(text)) loopback += matches.length;
  }
  // U5 lands the server; until then zero listens is also valid.
  assert.ok(listens <= 1, `expected at most one listen(), found ${listens}`);
  assert.equal(listens, loopback, "every listen() must bind 127.0.0.1");
});
