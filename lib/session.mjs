import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_CONFIG } from './types.mjs';
import { sha1, writeTextAtomic } from './util.mjs';

export { sha1, writeTextAtomic };

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SWEEP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Resolves every journeymap path for a project and (optionally) one chat session.
 *
 * @param {string} projectDir - Absolute project directory (where `.journeys/` lives).
 * @param {string} [sessionId] - Claude Code session id; omit for project-only paths.
 * @returns {Record<string, string>} Named absolute paths.
 * @throws {Error} When the session id contains anything but letters, digits, '-' or '_'.
 */
export function paths(projectDir, sessionId) {
  // The anchor cache is project-wide (shared by every chat) so only the first chat ever pays for a full scan.
  const jdir = join(projectDir, '.journeys');
  const p = {
    projectDir,
    jdir,
    doc: join(jdir, 'journeys.json'),
    config: join(jdir, 'config.json'),
    local: join(jdir, '.local.json'),
    sessions: join(jdir, '.session'),
    anchorCache: join(jdir, '.anchor-cache.json'),
    canonical: join(projectDir, 'journeys.html'),
  };
  if (sessionId === undefined) return p;
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`journeymap: unexpected session id "${sessionId}"`);
  const s = join(p.sessions, sessionId);
  return {
    ...p,
    sessionId,
    session: s,
    start: join(s, 'start.json'),
    last: join(s, 'last.json'),
    routes: join(s, 'routes.json'),
    touched: join(s, 'touched.json'),
    plan: join(s, 'plan.json'),
    approval: join(s, 'approval.json'),
    view: join(s, 'view.html'),
    viewHash: join(s, 'view.hash'),
    published: join(s, 'published'),
    noFlow: join(s, 'no-flow-change'),
    turn: join(s, 'turn.json'),
    flags: join(s, 'flags.json'),
    stepFiles: join(s, 'step-files.json'),
    errors: join(s, 'errors.log'),
  };
}

/**
 * Whether a value is a usable Claude Code session id.
 *
 * @param {unknown} sessionId - Candidate id from a hook payload or the environment.
 * @returns {boolean} True for 1–128 letters, digits, '-' or '_'.
 */
export function isSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId);
}

/**
 * Finds the nearest directory at or above `startDir` that contains `.journeys/journeys.json`.
 *
 * @param {string} startDir - Directory to start from (usually the hook payload's cwd).
 * @returns {string|null} The project directory, or null when journeymap isn't set up.
 */
export function findProjectDir(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, '.journeys', 'journeys.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Reads and parses a JSON file.
 *
 * @param {string} file - Absolute path.
 * @param {*} fallback - Returned when the file is missing or unreadable.
 * @returns {*} Parsed value or the fallback.
 */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Reads a text file.
 *
 * @param {string} file - Absolute path.
 * @param {string|null} fallback - Returned when the file is missing.
 * @returns {string|null} File contents or the fallback.
 */
export function readText(file, fallback = null) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

/**
 * Writes a value as pretty JSON, atomically.
 *
 * @param {string} file - Absolute path.
 * @param {*} value - JSON-serializable value.
 * @returns {void}
 */
export function writeJson(file, value) {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Removes a file if it exists.
 *
 * @param {string} file - Absolute path.
 * @returns {void}
 */
export function removeFile(file) {
  rmSync(file, { force: true });
}

/**
 * Loads `.journeys/config.json` merged over the defaults.
 *
 * @param {string} projectDir - Absolute project directory.
 * @returns {import('./types.mjs').Config} Effective config.
 */
export function loadConfig(projectDir) {
  const user = readJson(paths(projectDir).config, {}) || {};
  return { ...DEFAULT_CONFIG, ...user };
}

/**
 * Converts a path from a tool call into a project-relative posix path.
 *
 * @param {string} projectDir - Absolute project directory.
 * @param {string} file - Absolute or relative path from the tool input.
 * @returns {string|null} Relative posix path, or null when the file is outside the project.
 */
export function toProjectPath(projectDir, file) {
  if (!file) return null;
  const abs = isAbsolute(file) ? file : resolve(projectDir, file);
  const rel = relative(projectDir, abs);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * Starts (or resumes) a chat session's state.
 * A fresh start or /clear resets the baseline; resume and compact keep the chat's original baseline.
 *
 * @param {Record<string, string>} p - Session paths from {@link paths}.
 * @param {{ doc: object, routes: Array<{file: string, route: string}>, source?: string }} state - Current journeys and route files.
 * @returns {{ resumed: boolean }} Whether an existing baseline was kept.
 */
export function initSession(p, { doc, routes, source }) {
  mkdirSync(p.session, { recursive: true });
  const keep = (source === 'resume' || source === 'compact') && existsSync(p.start);
  if (!keep) {
    writeJson(p.start, doc);
    writeJson(p.last, doc);
    writeJson(p.routes, routes);
    writeJson(p.touched, []);
    writeJson(p.turn, { blocked: false, nudged: [] });
  }
  return { resumed: keep };
}

/**
 * Records a file Claude's edit tools touched this turn.
 *
 * @param {Record<string, string>} p - Session paths.
 * @param {string} relPath - Project-relative posix path.
 * @returns {void}
 */
export function recordTouched(p, relPath) {
  const touched = readJson(p.touched, []) || [];
  if (touched.includes(relPath)) return;
  touched.push(relPath);
  writeJson(p.touched, touched);
}

/**
 * Reads this turn's bookkeeping (whether Stop already blocked, which files got a nudge).
 *
 * @param {Record<string, string>} p - Session paths.
 * @returns {{ blocked: boolean, nudged: string[] }} Turn state.
 */
export function readTurn(p) {
  return { blocked: false, nudged: [], ...(readJson(p.turn, {}) || {}) };
}

/**
 * Appends a hook error to the session's errors.log (shown as a chip on the map).
 *
 * @param {Record<string, string>|null} p - Session paths, or null when unknown.
 * @param {string} event - Hook or command name.
 * @param {unknown} err - The error.
 * @returns {void}
 */
export function logError(p, event, err) {
  const line = `${new Date().toISOString()} ${event}: ${err instanceof Error ? err.stack || err.message : String(err)}\n`;
  try {
    if (p?.errors) {
      mkdirSync(dirname(p.errors), { recursive: true });
      appendFileSync(p.errors, line);
    }
  } catch {
    // Logging must never break a session.
  }
  process.stderr.write(`journeymap: ${event} failed (details in .journeys/.session errors.log)\n`);
}

/**
 * Deletes session folders untouched for more than 7 days.
 *
 * @param {string} projectDir - Absolute project directory.
 * @param {number} [now] - Current time in ms (for tests).
 * @returns {number} Number of folders removed.
 */
export function sweepSessions(projectDir, now = Date.now()) {
  const dir = paths(projectDir).sessions;
  let removed = 0;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    try {
      if (now - statSync(full).mtimeMs > SWEEP_AFTER_MS) {
        rmSync(full, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // A concurrent session may be cleaning up too.
    }
  }
  return removed;
}
