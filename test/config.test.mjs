import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { resolveDataDir, resolvePort, detectSyncRoot, expandTilde, DEFAULT_PORT } from "../src/config.mjs";

const HOME = "/Users/testuser";

test("flag beats env beats default", () => {
  assert.equal(
    resolveDataDir({ argv: ["--data-dir", "/flag/dir"], env: { RUNWAY_DATA_DIR: "/env/dir" }, home: HOME }),
    resolve("/flag/dir"),
  );
  assert.equal(
    resolveDataDir({ argv: ["--data-dir=/flag2"], env: { RUNWAY_DATA_DIR: "/env/dir" }, home: HOME }),
    resolve("/flag2"),
  );
  assert.equal(resolveDataDir({ argv: [], env: { RUNWAY_DATA_DIR: "/env/dir" }, home: HOME }), resolve("/env/dir"));
  assert.equal(resolveDataDir({ argv: [], env: {}, home: HOME }), resolve(HOME, "runway-data"));
});

test("tilde expansion", () => {
  assert.equal(expandTilde("~/x", HOME), HOME + "/x");
  assert.equal(expandTilde("~", HOME), HOME);
  assert.equal(expandTilde("/abs/x", HOME), "/abs/x");
  assert.equal(resolveDataDir({ argv: [], env: { RUNWAY_DATA_DIR: "~/mydata" }, home: HOME }), resolve(HOME, "mydata"));
});

test("port resolution with fallback on garbage", () => {
  assert.equal(resolvePort({ argv: [], env: {} }), DEFAULT_PORT);
  assert.equal(resolvePort({ argv: ["--port", "5000"], env: {} }), 5000);
  assert.equal(resolvePort({ argv: [], env: { RUNWAY_PORT: "abc" } }), DEFAULT_PORT);
  assert.equal(resolvePort({ argv: [], env: { RUNWAY_PORT: "-1" } }), DEFAULT_PORT);
});

test("sync-root detection fires on synced paths, silent on plain paths", () => {
  assert.equal(detectSyncRoot(HOME + "/Dropbox/finances", HOME), "Dropbox");
  assert.equal(detectSyncRoot(HOME + "/Library/Mobile Documents/com~apple~CloudDocs/x", HOME), "Mobile Documents");
  assert.equal(detectSyncRoot(HOME + "/Library/CloudStorage/GoogleDrive-x/y", HOME), "CloudStorage");
  assert.equal(detectSyncRoot(HOME + "/runway-data", HOME), null);
  assert.equal(detectSyncRoot("/tmp/runway-data", HOME), null);
  // prefix trap: ~/DropboxArchive is not ~/Dropbox
  assert.equal(detectSyncRoot(HOME + "/DropboxArchive/x", HOME), null);
});
