// HTTP layer: routing plus the local-only security envelope. No framework —
// a plain request handler over the store. This module never opens a socket
// itself; index.mjs owns the process's single server binding.
//
// Guards, in order, on EVERY request before any body is parsed:
//   (1) Host allowlist (localhost/127.0.0.1/[::1]) — DNS-rebinding defense
//   (2) Origin check on mutating methods — cross-origin browser writes
//   (3) never emit any Access-Control-Allow-* header (an invariant, tested)
//   (4) mutating requests must declare Content-Type: application/json —
//       except the template-preview upload, which must declare
//       application/octet-stream (raw .xlsx bytes; route-scoped exception)
//   (5) per-route body-size caps, enforced without buffering past the cap
import { readFileSync, realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { placeholderState } from "../model/placeholder.mjs";
import { defaultState } from "../model/schema.mjs";
import { MissingVersionError, FutureVersionError } from "../model/migrate.mjs";
import {
  applicableTabs,
  applyTabs,
  buildTemplateWorkbook,
  isRejectedFilename,
  parseTemplate,
  previewTemplate,
  TemplateFileError,
} from "../import/template.mjs";
import {
  RevConflictError,
  SnapshotCorruptError,
  SnapshotNotFoundError,
  ValidationError,
} from "./store.mjs";

/** @typedef {import("../model/schema.mjs").RunwayState} RunwayState */
/** @typedef {import("../model/schema.mjs").Issue} Issue */
/** @typedef {import("./store.mjs").SnapshotInfo} SnapshotInfo */
/** @typedef {import("node:http").IncomingMessage} Req */
/** @typedef {import("node:http").ServerResponse} Res */

const MB = 1024 * 1024;
const HOST_OK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'";

/** @type {Record<string, string>} */
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** @param {Res} res @param {number} status @param {unknown} body */
function sendJson(res, status, body) {
  const bytes = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(bytes),
    "X-Content-Type-Options": "nosniff",
  });
  res.end(bytes);
}

/** @param {Res} res */
function notFound(res) {
  sendJson(res, 404, { errors: [{ path: "", message: "not found" }] });
}

/** @param {string} origin @param {number|undefined} localPort */
function allowedOrigin(origin, localPort) {
  const p = String(localPort ?? "");
  return (
    origin === `http://localhost:${p}` ||
    origin === `http://127.0.0.1:${p}` ||
    origin === `http://[::1]:${p}`
  );
}

/**
 * Parse and decode the request path. Returns null (→ 404) when the URL or
 * its percent-encoding is malformed.
 * @param {string} rawUrl @returns {string|null}
 */
function urlPathname(rawUrl) {
  let pathname;
  try {
    pathname = new URL(rawUrl, "http://localhost").pathname;
  } catch {
    return null;
  }
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/** Query params for a request URL (empty on malformed URLs). @param {string} rawUrl */
function urlSearchParams(rawUrl) {
  try {
    return new URL(rawUrl, "http://localhost").searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Separator-aware containment. @param {string} p @param {string} root */
function contained(p, root) {
  return p === root || p.startsWith(root + sep);
}

/**
 * Read a JSON body up to `cap` bytes. Once over the cap, chunks are drained
 * but no longer buffered. Sends 413/400 itself and resolves undefined when
 * the caller should stop.
 * @param {Req} req @param {Res} res @param {number} cap
 * @returns {Promise<any|undefined>}
 */
function readJsonBody(req, res, cap) {
  return new Promise((resolvePromise, rejectPromise) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    let over = false;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (over) return;
      if (total > cap) {
        over = true;
        chunks.length = 0; // never hold more than the cap
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (over) {
        sendJson(res, 413, { errors: [{ path: "", message: `body exceeds ${cap} byte cap` }] });
        return resolvePromise(undefined);
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        sendJson(res, 400, { errors: [{ path: "", message: "body is not valid JSON" }] });
        resolvePromise(undefined);
      }
    });
    req.on("error", rejectPromise);
  });
}

/**
 * Read a raw (binary) body up to `cap` bytes with the same drain-past-the-cap
 * discipline as readJsonBody. Sends 413 itself and resolves undefined when
 * the caller should stop.
 * @param {Req} req @param {Res} res @param {number} cap
 * @returns {Promise<Buffer|undefined>}
 */
function readRawBody(req, res, cap) {
  return new Promise((resolvePromise, rejectPromise) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    let over = false;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (over) return;
      if (total > cap) {
        over = true;
        chunks.length = 0; // never hold more than the cap
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (over) {
        sendJson(res, 413, { errors: [{ path: "", message: `body exceeds ${cap} byte cap` }] });
        return resolvePromise(undefined);
      }
      resolvePromise(Buffer.concat(chunks));
    });
    req.on("error", rejectPromise);
  });
}

/**
 * @param {import("./store.mjs").Store} store an init()ed store
 * @param {{publicDir?: string}} [opts] publicDir is overridable for tests
 * @returns {(req: Req, res: Res) => void}
 */
export function createApi(store, opts = {}) {
  const publicDir = resolve(opts.publicDir ?? fileURLToPath(new URL("../../public", import.meta.url)));
  const engineDir = resolve(fileURLToPath(new URL("../engine", import.meta.url)));
  const modelDir = resolve(fileURLToPath(new URL("../model", import.meta.url)));

  // Session cache: load once (may quarantine, migrate, or throw
  // FutureVersionError — the caller handles startup refusal), then keep it
  // in sync on every successful mutation.
  const loaded = store.load();
  let seeded = loaded.seeded;
  /** @type {RunwayState|null} */
  let state = loaded.state ?? null;
  /** @type {Issue[]} */
  let warnings = loaded.warnings ?? [];
  /** @type {{quarantinedAs: string, snapshots: SnapshotInfo[]}|null} */
  let recovery = loaded.corrupt
    ? { quarantinedAs: loaded.quarantinedAs ?? "", snapshots: loaded.snapshots ?? [] }
    : null;

  // Template-import preview cache (U8): parsed workbooks keyed by a random
  // token, threaded from preview to apply. Single user, so a tiny in-memory
  // LRU is plenty; an evicted or already-used token → 410.
  const MAX_TEMPLATE_PREVIEWS = 4;
  /** @type {Map<string, {parsed: import("../import/template.mjs").ParsedTemplate}>} */
  const templatePreviews = new Map();

  return (req, res) => {
    handle(req, res).catch((e) => {
      process.stderr.write(`runway: request failed: ${e instanceof Error ? e.stack : e}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { errors: [{ path: "", message: "internal error" }] });
      } else {
        try {
          res.end();
        } catch {
          /* socket already gone */
        }
      }
    });
  };

  /** @param {Req} req @param {Res} res */
  async function handle(req, res) {
    const method = req.method ?? "GET";

    // (1) Host allowlist.
    const host = req.headers.host;
    if (!host || !HOST_OK.test(host)) {
      return sendJson(res, 403, { errors: [{ path: "", message: "forbidden host" }] });
    }

    // Parsing the URL is pure (no body is touched) — it has to happen before
    // guard (4) because the content-type requirement is route-aware.
    const pathname = urlPathname(req.url ?? "/");
    if (pathname === null) return notFound(res);

    const mutating = method === "PUT" || method === "POST" || method === "DELETE";
    if (mutating) {
      // (2) Origin check — only loopback origins on the bound port may mutate.
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigin(origin, req.socket.localPort)) {
        return sendJson(res, 403, { errors: [{ path: "", message: "forbidden origin" }] });
      }
      // (4) JSON only for mutations — except the template preview upload,
      // which is raw .xlsx bytes and must declare application/octet-stream.
      const ct = (req.headers["content-type"] ?? "").toLowerCase();
      const wantsOctet = method === "POST" && pathname === "/api/import/template/preview";
      if (wantsOctet ? !ct.startsWith("application/octet-stream") : !ct.startsWith("application/json")) {
        const wanted = wantsOctet ? "application/octet-stream" : "application/json";
        return sendJson(res, 415, { errors: [{ path: "", message: `Content-Type must be ${wanted}` }] });
      }
    }
    // (3) is an invariant, not a step: no Access-Control-Allow-* is ever set.

    if (pathname === "/api/state" && method === "GET") return apiGetState(res);
    if (pathname === "/api/state" && method === "PUT") return apiPutState(req, res);
    if (pathname === "/api/snapshots" && method === "GET") {
      return sendJson(res, 200, { snapshots: store.listSnapshots() });
    }
    if (pathname === "/api/restore" && method === "POST") return apiRestore(req, res);
    if (pathname === "/api/import/v0" && method === "POST") return apiImportV0(req, res);
    if (pathname === "/api/import/template/preview" && method === "POST") return apiTemplatePreview(req, res);
    if (pathname === "/api/import/template/apply" && method === "POST") return apiTemplateApply(req, res);
    if (pathname === "/api/export/template" && method === "GET") return apiTemplateExport(res);
    if (pathname === "/api/reset" && method === "POST") return apiReset(req, res);
    if (pathname === "/api/trends" && method === "GET") {
      return sendJson(res, 200, { rows: store.readTrends() });
    }
    if (pathname === "/health" && method === "GET") {
      // Identity and version only — never the data-dir path.
      return sendJson(res, 200, {
        app: "runway",
        version: store.appVersion(),
        identity: store.identity(),
        rev: store.rev(),
      });
    }

    if (method === "GET") return serveStatic(pathname, res);
    return notFound(res);
  }

  /** @param {Res} res */
  function apiGetState(res) {
    /** @type {Record<string, unknown>} */
    const body = { state: state ?? placeholderState(), rev: store.rev(), seeded, warnings };
    if (recovery) body.recovery = recovery;
    sendJson(res, 200, body);
  }

  /** @param {Req} req @param {Res} res */
  async function apiPutState(req, res) {
    const body = await readJsonBody(req, res, 5 * MB);
    if (body === undefined) return;
    const candidate = body?.state;
    const baseRev = body?.baseRev;
    if (typeof baseRev !== "number") {
      return sendJson(res, 400, { errors: [{ path: "baseRev", message: "baseRev (number) is required" }] });
    }
    if (baseRev !== store.rev()) return sendJson(res, 409, { rev: store.rev() });
    try {
      const result = store.save(candidate);
      state = candidate;
      seeded = true;
      warnings = result.warnings;
      recovery = null;
      return sendJson(res, 200, { rev: result.rev, warnings: result.warnings });
    } catch (e) {
      if (e instanceof ValidationError) return sendJson(res, 400, { errors: e.issues });
      throw e;
    }
  }

  /** @param {Req} req @param {Res} res */
  async function apiRestore(req, res) {
    const body = await readJsonBody(req, res, MB);
    if (body === undefined) return;
    const file = body?.file;
    const baseRev = body?.baseRev;
    // Validate against the actual snapshot listing — no path traversal via
    // file names.
    if (typeof file !== "string" || !store.listSnapshots().some((s) => s.file === file)) {
      return sendJson(res, 404, { errors: [{ path: "file", message: "unknown snapshot" }] });
    }
    try {
      const result = store.restore(file, { baseRev });
      state = result.state;
      seeded = true;
      warnings = result.warnings;
      recovery = null;
      return sendJson(res, 200, { rev: result.rev });
    } catch (e) {
      if (e instanceof RevConflictError) return sendJson(res, 409, { rev: e.rev });
      if (e instanceof SnapshotNotFoundError) {
        return sendJson(res, 404, { errors: [{ path: "file", message: e.message }] });
      }
      if (e instanceof SnapshotCorruptError || e instanceof ValidationError || e instanceof FutureVersionError) {
        return sendJson(res, 400, { errors: [{ path: "file", message: e.message }] });
      }
      throw e;
    }
  }

  /** @param {Req} req @param {Res} res */
  async function apiImportV0(req, res) {
    const body = await readJsonBody(req, res, 10 * MB);
    if (body === undefined) return;
    const data = body?.data;
    const baseRev = body?.baseRev;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return sendJson(res, 400, { errors: [{ path: "data", message: "data must be the raw v0 export object" }] });
    }
    try {
      const result = store.importV0(data, { baseRev });
      state = result.state;
      seeded = true;
      warnings = result.warnings;
      recovery = null;
      return sendJson(res, 200, { rev: result.rev, warnings: result.warnings });
    } catch (e) {
      if (e instanceof RevConflictError) return sendJson(res, 409, { rev: e.rev });
      if (e instanceof ValidationError) return sendJson(res, 400, { errors: e.issues });
      if (e instanceof MissingVersionError || e instanceof FutureVersionError) {
        return sendJson(res, 400, { errors: [{ path: "data", message: e.message }] });
      }
      throw e;
    }
  }

  /**
   * POST /api/import/template/preview — raw .xlsx bytes (20MB cap). Bounds
   * check + parse + per-tab preview against the current state; caches the
   * parsed workbook under a random token for the apply step.
   * @param {Req} req @param {Res} res
   */
  async function apiTemplatePreview(req, res) {
    const filename = urlSearchParams(req.url ?? "").get("filename") ?? "";
    if (isRejectedFilename(filename)) {
      return sendJson(res, 400, {
        errors: [{ path: "filename", message: "macro-enabled workbook files (.xlsm/.xlsb) are not accepted — export a plain .xlsx" }],
      });
    }
    const body = await readRawBody(req, res, 20 * MB);
    if (body === undefined) return;
    let parsed;
    try {
      parsed = parseTemplate(body);
    } catch (e) {
      if (e instanceof TemplateFileError) return sendJson(res, 400, { errors: [{ path: "", message: e.message }] });
      throw e;
    }
    if (parsed.tabsFound.length === 0) {
      return sendJson(res, 400, {
        errors: [{ path: "", message: "no recognized tabs — expected Accounts, Properties, Income, Spending, and/or Assumptions" }],
      });
    }
    const token = randomUUID();
    templatePreviews.set(token, { parsed });
    while (templatePreviews.size > MAX_TEMPLATE_PREVIEWS) {
      const oldest = templatePreviews.keys().next().value;
      if (oldest === undefined) break;
      templatePreviews.delete(oldest);
    }
    // Unseeded dirs import onto the schema defaults, never the placeholder —
    // example rentals must not silently become real data.
    const base = state ?? defaultState();
    return sendJson(res, 200, { preview: previewTemplate(base, parsed), token, rev: store.rev() });
  }

  /**
   * POST /api/import/template/apply — { token, tabs, baseRev }.
   * 409 stale rev | 410 expired token | 400 invalid tabs; else pre-import
   * snapshot → applyTabs → save(source "template-import").
   * @param {Req} req @param {Res} res
   */
  async function apiTemplateApply(req, res) {
    const body = await readJsonBody(req, res, MB);
    if (body === undefined) return;
    const baseRev = body?.baseRev;
    if (typeof baseRev !== "number") {
      return sendJson(res, 400, { errors: [{ path: "baseRev", message: "baseRev (number) is required" }] });
    }
    if (baseRev !== store.rev()) return sendJson(res, 409, { rev: store.rev() });
    const token = body?.token;
    const entry = typeof token === "string" ? templatePreviews.get(token) : undefined;
    if (!entry) {
      return sendJson(res, 410, { errors: [{ path: "token", message: "preview expired — choose the file again" }] });
    }
    const ok = applicableTabs(entry.parsed);
    const tabs = body?.tabs;
    if (
      !Array.isArray(tabs) ||
      tabs.length === 0 ||
      !tabs.every((t) => typeof t === "string" && ok.includes(t)) ||
      new Set(tabs).size !== tabs.length
    ) {
      return sendJson(res, 400, {
        errors: [{ path: "tabs", message: `tabs must be a non-empty subset of the applicable tabs (${ok.join(", ") || "none"})` }],
      });
    }
    if (seeded) store.snapshotNow("template-import"); // preserve what the import replaces
    const next = applyTabs(state ?? defaultState(), entry.parsed, tabs);
    try {
      const result = store.save(next, { source: "template-import" });
      templatePreviews.delete(token);
      state = next;
      seeded = true;
      warnings = result.warnings;
      recovery = null;
      return sendJson(res, 200, { rev: result.rev, warnings: result.warnings });
    } catch (e) {
      if (e instanceof ValidationError) return sendJson(res, 400, { errors: e.issues });
      throw e;
    }
  }

  /**
   * GET /api/export/template — the current state filled into the template
   * shape, as an .xlsx attachment. Text cells are injection-guarded inside
   * buildTemplateWorkbook.
   * @param {Res} res
   */
  function apiTemplateExport(res) {
    const buf = buildTemplateWorkbook(state ?? placeholderState());
    res.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="runway-export.local.xlsx"',
      "Content-Length": buf.length,
      "X-Content-Type-Options": "nosniff",
    });
    res.end(buf);
  }

  /** @param {Req} req @param {Res} res */
  async function apiReset(req, res) {
    const body = await readJsonBody(req, res, MB);
    if (body === undefined) return;
    const baseRev = body?.baseRev;
    if (typeof baseRev !== "number") {
      return sendJson(res, 400, { errors: [{ path: "baseRev", message: "baseRev (number) is required" }] });
    }
    try {
      const result = store.reset({ baseRev });
      state = null;
      seeded = false;
      warnings = [];
      recovery = null;
      return sendJson(res, 200, { rev: result.rev });
    } catch (e) {
      if (e instanceof RevConflictError) return sendJson(res, 409, { rev: e.rev });
      throw e;
    }
  }

  /**
   * Static roots: / → public/, /engine/ → src/engine/, /model/ → src/model/.
   * All share the same containment check: decoded path, lexical resolve
   * against the root, then canonical (realpath) containment. No directory
   * listings; a missing public/ (U6 lands it) 404s gracefully.
   * @param {string} pathname decoded @param {Res} res
   */
  function serveStatic(pathname, res) {
    // Windows-style separator games and NUL bytes are rejected outright.
    if (pathname.includes("\\") || pathname.includes("\0")) return notFound(res);

    let root = publicDir;
    let sub = pathname;
    if (pathname === "/") {
      sub = "/index.html";
    } else if (pathname.startsWith("/engine/")) {
      root = engineDir;
      sub = pathname.slice("/engine".length);
    } else if (pathname.startsWith("/model/")) {
      root = modelDir;
      sub = pathname.slice("/model".length);
    }

    const target = resolve(root, "." + sub);
    if (!contained(target, root)) return notFound(res);

    let real;
    let realRoot;
    try {
      real = realpathSync(target);
      realRoot = realpathSync(root);
    } catch {
      return notFound(res); // missing file, dead symlink, or missing root
    }
    if (!contained(real, realRoot)) return notFound(res);

    let stat;
    try {
      stat = statSync(real);
    } catch {
      return notFound(res);
    }
    if (!stat.isFile()) return notFound(res); // no directory listings

    const type = CONTENT_TYPES[extname(real).toLowerCase()] ?? "application/octet-stream";
    /** @type {Record<string, string>} */
    const headers = { "Content-Type": type, "X-Content-Type-Options": "nosniff" };
    if (type.startsWith("text/html")) headers["Content-Security-Policy"] = CSP;
    res.writeHead(200, headers);
    res.end(readFileSync(real));
  }
}
