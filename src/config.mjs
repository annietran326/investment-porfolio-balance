// Data-directory resolution. Precedence: --data-dir flag > RUNWAY_DATA_DIR env > default.
// The override is never persisted anywhere (a persisted override would have to live in
// the data dir it points at — chicken and egg).
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

export const DEFAULT_DATA_DIR = "~/runway-data";
export const DEFAULT_PORT = 4207;

/**
 * Expand a leading `~` to the user's home directory.
 * @param {string} p
 * @param {string} [home]
 */
export function expandTilde(p, home = homedir()) {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return home + p.slice(1);
  return p;
}

/**
 * Resolve the data directory from argv/env. Pure given its inputs so tests
 * can exercise precedence without touching the process.
 * @param {{argv?: string[], env?: Record<string, string|undefined>, home?: string}} opts
 */
export function resolveDataDir({ argv = process.argv.slice(2), env = process.env, home = homedir() } = {}) {
  let fromFlag = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--data-dir" && argv[i + 1]) fromFlag = argv[i + 1];
    else if (argv[i].startsWith("--data-dir=")) fromFlag = argv[i].slice("--data-dir=".length);
  }
  const raw = fromFlag ?? env.RUNWAY_DATA_DIR ?? DEFAULT_DATA_DIR;
  return resolve(expandTilde(raw, home));
}

/** @param {{argv?: string[], env?: Record<string, string|undefined>}} opts */
export function resolvePort({ argv = process.argv.slice(2), env = process.env } = {}) {
  let fromFlag = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) fromFlag = argv[i + 1];
    else if (argv[i].startsWith("--port=")) fromFlag = argv[i].slice("--port=".length);
  }
  const raw = fromFlag ?? env.RUNWAY_PORT;
  const n = raw == null ? DEFAULT_PORT : Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

// Known cloud-sync roots, relative to home. Detection is a warning, never a block:
// financial data inside a synced folder gets uploaded to that provider.
const SYNC_ROOT_PATTERNS = [
  ["Library", "Mobile Documents"], // iCloud Drive (macOS)
  ["Dropbox"],
  ["OneDrive"],
  ["Google Drive"],
  ["Library", "CloudStorage"], // macOS provider mounts (Dropbox/GDrive/OneDrive via File Provider)
];

/**
 * Return the name of the cloud-sync provider the path sits under, or null.
 * @param {string} dataDir resolved absolute path
 */
export function detectSyncRoot(dataDir, home = homedir()) {
  const norm = resolve(dataDir) + sep;
  for (const parts of SYNC_ROOT_PATTERNS) {
    const root = resolve(home, ...parts) + sep;
    if (norm.startsWith(root)) return parts[parts.length - 1];
  }
  return null;
}
