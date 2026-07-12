// Guard against the class of bug that shipped a blank app in v2: a public/
// (browser) module importing across the public->src boundary. Such a path
// resolves in Node (so unit tests pass) but 404s in the browser — the server
// serves the model/engine at /model/ and /engine/, never /src/ — and a 404 on
// a static ES-module import silently kills the whole module graph, leaving the
// page rendered-but-empty. Node tests never catch it because they run on the
// filesystem, not through the server's routes.
//
// The rule: a browser module may import model/engine only via the served roots
// (/model/, /engine/) or relative siblings (./x, ../ui/x). It may NEVER name
// `src/` in an import specifier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith(".mjs")) yield p;
  }
}

const IMPORT_RE = /(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g;

test("no public/ module imports across the public->src boundary", () => {
  const offenders = [];
  for (const file of walk(PUBLIC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (/(^|\/)src\//.test(spec)) offenders.push(`${file}: imports "${spec}"`);
    }
  }
  assert.deepEqual(offenders, [], `browser modules must import model/engine via /model/ or /engine/, never src/:\n${offenders.join("\n")}`);
});

test("browser absolute imports point only at served roots (/engine/, /model/)", () => {
  const offenders = [];
  for (const file of walk(PUBLIC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (spec.startsWith("/") && !spec.startsWith("/engine/") && !spec.startsWith("/model/")) {
        offenders.push(`${file}: imports "${spec}"`);
      }
    }
  }
  assert.deepEqual(offenders, [], `absolute browser imports must target /engine/ or /model/:\n${offenders.join("\n")}`);
});
