/**
 * Shared test helpers: throw-away projects, real-shaped Claude Code hook payloads, and runners that
 * spawn the real `bin/journeys.mjs` exactly the way Claude Code does.
 *
 * Each test file runs in its own process, so the module-level list of temp dirs is per file:
 * call `after(cleanupProjects)` once at the top of the file.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BIN = join(ROOT, 'bin', 'journeys.mjs');
export const FIXTURE = join(ROOT, 'test', 'fixtures', 'next-app');
export const DEFAULT_SID = 'sess-aaaa-1111';
export const HOSTILE = '</script><img src=x onerror=alert(1)>';

const tempDirs = [];

/**
 * Builds a step with sensible defaults: a route anchor on its screen, or a file anchor when it has no screen.
 *
 * @param {string} id - Step id.
 * @param {string|null} screen - URL path the user sees, or null.
 * @param {object} [extra] - Fields that override the defaults (`anchor`, `next`, `say`, ...).
 * @returns {object} A journeys.json step.
 */
export function step(id, screen, extra = {}) {
  const anchor = screen ? { type: 'route', value: screen } : { type: 'file', value: 'app/page.tsx' };
  return { id, say: `Step ${id}`, screen, anchor, next: [], ...extra };
}

/**
 * Shorthand for a file anchor.
 *
 * @param {string} value - Project-relative posix path.
 * @returns {{ type: 'file', value: string }} The anchor.
 */
export function fileAnchor(value) {
  return { type: 'file', value };
}

/**
 * Builds a journey.
 *
 * @param {string} id - Journey id.
 * @param {string} title - Plain-language title.
 * @param {object[]} steps - Steps from {@link step}.
 * @param {object} [extra] - Extra journey fields (`area`, `who`).
 * @returns {object} A journeys.json journey.
 */
export function journey(id, title, steps, extra = {}) {
  return { id, title, steps, ...extra };
}

/**
 * Wraps journeys into a document.
 *
 * @param {object[]} journeys - Journeys from {@link journey}.
 * @param {object} [extra] - Extra document fields (`app`, `areas`).
 * @returns {object} A journeys.json document.
 */
export function docOf(journeys, extra = {}) {
  return { version: 1, app: 'next-app-fixture', journeys, ...extra };
}

/**
 * The starting map used by most tests: "browse" (file anchor app/page.tsx) and "pay" (route anchor /checkout,
 * file anchor src/components/Nav.tsx). Every anchor resolves in the next-app fixture.
 *
 * @returns {object} A fresh document each call.
 */
export function baseDoc() {
  return docOf([
    journey('browse', 'Browse the shop', [step('home', '/', { anchor: fileAnchor('app/page.tsx') })]),
    journey('pay', 'Pay for the order', [
      step('checkout', '/checkout', { next: ['receipt'] }),
      step('receipt', null, { anchor: fileAnchor('src/components/Nav.tsx') }),
    ]),
  ]);
}

/**
 * Reads the view model embedded in a rendered map.
 *
 * @param {string} html - Contents of view.html or journeys.html.
 * @returns {object} The parsed view model.
 */
export function extractViewModel(html) {
  const match = /<script type="application\/json" id="jm-data">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, 'rendered map has a jm-data script');
  return JSON.parse(match[1]);
}

/**
 * Finds a step node in a view model.
 *
 * @param {object} vm - View model from {@link extractViewModel}.
 * @param {string} journeyId - Journey id.
 * @param {string} stepId - Step id.
 * @returns {object|undefined} The step node, or undefined when it is not drawn.
 */
export function stepNode(vm, journeyId, stepId) {
  return vm.journeys[journeyId]?.children.find((child) => child.id === `${journeyId}/${stepId}`);
}

/**
 * Hashes every file under a directory, so a test can prove nothing changed.
 *
 * @param {string} dir - Directory to walk.
 * @returns {Record<string, string>} Relative posix path to sha1 of the contents.
 */
export function snapshotTree(dir) {
  const out = {};
  const visit = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(next);
      else out[next] = createHash('sha1').update(readFileSync(join(dir, next))).digest('hex');
    }
  };
  visit('');
  return out;
}

/** A throw-away project directory with convenience accessors. */
export class Project {
  /**
   * @param {string} dir - Absolute (real) path of the project.
   */
  constructor(dir) {
    this.dir = dir;
  }

  /**
   * Absolute path of a project file.
   *
   * @param {string} rel - Posix path relative to the project.
   * @returns {string} Absolute path.
   */
  abs(rel) {
    return join(this.dir, ...rel.split('/'));
  }

  /**
   * Writes a text file (creating folders).
   *
   * @param {string} rel - Posix path relative to the project.
   * @param {string} text - Contents.
   * @returns {string} The absolute path written.
   */
  write(rel, text) {
    const file = this.abs(rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  }

  /**
   * Reads a text file.
   *
   * @param {string} rel - Posix path relative to the project.
   * @returns {string} Contents.
   */
  read(rel) {
    return readFileSync(this.abs(rel), 'utf8');
  }

  /**
   * Reads and parses a JSON file.
   *
   * @param {string} rel - Posix path relative to the project.
   * @returns {any} Parsed value.
   */
  json(rel) {
    return JSON.parse(this.read(rel));
  }

  /**
   * Whether a file or folder exists.
   *
   * @param {string} rel - Posix path relative to the project.
   * @returns {boolean} True when it exists.
   */
  exists(rel) {
    return existsSync(this.abs(rel));
  }

  /**
   * Removes a file or folder if present.
   *
   * @param {string} rel - Posix path relative to the project.
   * @returns {void}
   */
  remove(rel) {
    rmSync(this.abs(rel), { recursive: true, force: true });
  }

  /**
   * Writes `.journeys/journeys.json`.
   *
   * @param {object|string} doc - A document, or raw text (to write invalid files on purpose).
   * @returns {void}
   */
  writeDoc(doc) {
    this.write('.journeys/journeys.json', typeof doc === 'string' ? doc : `${JSON.stringify(doc, null, 2)}\n`);
  }

  /**
   * Writes `.journeys/config.json`.
   *
   * @param {object} config - Config overrides.
   * @returns {void}
   */
  writeConfig(config) {
    this.write('.journeys/config.json', `${JSON.stringify(config, null, 2)}\n`);
  }

  /**
   * Absolute path of a file in a chat's session folder.
   *
   * @param {string} sessionId - Session id.
   * @param {string} name - File name inside the session folder.
   * @returns {string} Absolute path.
   */
  sessionFile(sessionId, name) {
    return join(this.dir, '.journeys', '.session', sessionId, name);
  }
}

/**
 * Creates a fresh project in a real (symlink-free) temp dir.
 *
 * @param {object} [options]
 * @param {object|string|null} [options.doc] - journeys.json to write (default {@link baseDoc}); null writes none.
 * @param {object} [options.config] - Optional `.journeys/config.json`.
 * @param {boolean} [options.fixture] - Copy test/fixtures/next-app first (default true).
 * @returns {Project} The project; it is deleted by {@link cleanupProjects}.
 */
export function makeProject({ doc = baseDoc(), config, fixture = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jm-test-')));
  tempDirs.push(dir);
  if (fixture) cpSync(FIXTURE, dir, { recursive: true });
  const project = new Project(dir);
  if (doc !== null) project.writeDoc(doc);
  if (config) project.writeConfig(config);
  return project;
}

/**
 * Registers an externally created temp dir for cleanup.
 *
 * @param {string} dir - Directory to delete in {@link cleanupProjects}.
 * @returns {string} The same directory.
 */
export function trackTempDir(dir) {
  tempDirs.push(dir);
  return dir;
}

/**
 * Deletes every temp dir this file created. Use as `after(cleanupProjects)`.
 *
 * @returns {void}
 */
export function cleanupProjects() {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Builds the tool_input of an edit tool the way Claude Code sends it.
 *
 * @param {string} tool - Edit, Write, MultiEdit or NotebookEdit.
 * @param {string} file - Path the tool edits.
 * @returns {object} tool_input.
 */
export function toolInput(tool, file) {
  if (tool === 'Write') return { file_path: file, content: 'export default function Page() {\n  return null;\n}\n' };
  if (tool === 'MultiEdit') return { file_path: file, edits: [{ old_string: 'null', new_string: 'undefined' }] };
  if (tool === 'NotebookEdit') return { notebook_path: file, cell_id: 'c1', new_source: 'print(1)', edit_mode: 'replace' };
  return { file_path: file, old_string: 'null', new_string: 'undefined', replace_all: false };
}

/**
 * Builds a hook payload shaped like Claude Code's.
 *
 * @param {string} event - SessionStart, PreToolUse, PostToolUse or Stop.
 * @param {object} fields - cwd, session_id and any event fields (tool_name, tool_input, tool_response, stop_hook_active, source, permission_mode).
 * @returns {object} The payload.
 */
export function hookPayload(event, { cwd, session_id: sessionId = DEFAULT_SID, permission_mode: mode = 'default', ...rest }) {
  return {
    session_id: sessionId,
    transcript_path: join(dirname(cwd), `${sessionId}.jsonl`),
    cwd,
    hook_event_name: event,
    permission_mode: mode,
    ...rest,
  };
}

/**
 * Runs `journeys.mjs hook <Event>` with the payload on stdin, like Claude Code.
 *
 * @param {string} event - Hook event name.
 * @param {object|null} payload - Payload; ignored when `options.raw` is set.
 * @param {object} [options]
 * @param {string} [options.gate] - Value for JOURNEYMAP_GATE; unset when omitted (default behaviour).
 * @param {string} [options.raw] - Exact stdin text (to send garbage).
 * @param {string} [options.cwd] - Working directory of the process (defaults to payload.cwd).
 * @param {Record<string, string>} [options.env] - Extra environment.
 * @returns {{ stdout: any, text: string, stderr: string, status: number|null }} `stdout` is the parsed JSON (null when empty); `text` is the raw output.
 * @throws {Error} When the process can't start or prints non-JSON.
 */
export function runHook(event, payload, { gate, raw, cwd, env = {} } = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.CLAUDE_CODE_SESSION_ID;
  delete childEnv.JOURNEYMAP_GATE;
  if (gate !== undefined) childEnv.JOURNEYMAP_GATE = gate;
  const where = cwd ?? (payload?.cwd && existsSync(payload.cwd) ? payload.cwd : undefined);
  const result = spawnSync(process.execPath, [BIN, 'hook', event], {
    input: raw ?? JSON.stringify(payload), env: childEnv, cwd: where, encoding: 'utf8',
  });
  if (result.error) throw result.error;
  const text = result.stdout;
  let stdout = null;
  if (text.trim() !== '') {
    try {
      stdout = JSON.parse(text);
    } catch {
      throw new Error(`${event} hook printed non-JSON output: ${text.slice(0, 200)}`);
    }
  }
  return { stdout, text, stderr: result.stderr, status: result.status };
}

/**
 * Runs a CLI command (`init`, `check`, `plan`, `build --render`, `render --canonical`) inside a project.
 *
 * @param {Project} project - Working directory.
 * @param {string[]} args - CLI arguments.
 * @param {object} [options]
 * @param {string|null} [options.sessionId] - Value for CLAUDE_CODE_SESSION_ID; null leaves it unset.
 * @param {Record<string, string>} [options.env] - Extra environment.
 * @returns {{ stdout: string, stderr: string, status: number|null }} Raw process result.
 */
export function runCli(project, args, { sessionId = DEFAULT_SID, env = {} } = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.CLAUDE_CODE_SESSION_ID;
  delete childEnv.JOURNEYMAP_GATE;
  if (sessionId) childEnv.CLAUDE_CODE_SESSION_ID = sessionId;
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd: project.dir, env: childEnv, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/** One Claude Code chat in a project: fires hooks in order and exposes the chat's session files. */
export class Chat {
  /**
   * @param {Project} project - The project this chat works in.
   * @param {string} [sessionId] - Session id.
   * @param {object} [options]
   * @param {string} [options.permissionMode] - permission_mode sent with tool and Stop payloads.
   * @param {string} [options.gate] - JOURNEYMAP_GATE for every hook this chat fires.
   */
  constructor(project, sessionId = DEFAULT_SID, { permissionMode = 'default', gate } = {}) {
    this.project = project;
    this.sid = sessionId;
    this.permissionMode = permissionMode;
    this.gate = gate;
  }

  /**
   * Absolute path of a file in this chat's session folder.
   *
   * @param {string} name - File name (start.json, plan.json, view.html, ...).
   * @returns {string} Absolute path.
   */
  file(name) {
    return this.project.sessionFile(this.sid, name);
  }

  /**
   * Whether a session file exists.
   *
   * @param {string} name - File name.
   * @returns {boolean} True when present.
   */
  has(name) {
    return existsSync(this.file(name));
  }

  /**
   * Reads a session file as text.
   *
   * @param {string} name - File name.
   * @returns {string} Contents.
   */
  text(name) {
    return readFileSync(this.file(name), 'utf8');
  }

  /**
   * Reads a session file as JSON.
   *
   * @param {string} name - File name.
   * @returns {any} Parsed value.
   */
  json(name) {
    return JSON.parse(this.text(name));
  }

  /**
   * Writes this chat's plan.json.
   *
   * @param {object} plan - A plan ({ summary, upsert, remove, touches }).
   * @returns {void}
   */
  writePlan(plan) {
    mkdirSync(dirname(this.file('plan.json')), { recursive: true });
    writeFileSync(this.file('plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  }

  /**
   * Fires a hook and checks it behaved: exit 0 and a quiet stderr (a crash would print there).
   *
   * @param {string} event - Hook event.
   * @param {object} fields - Event-specific payload fields.
   * @param {object} [options]
   * @param {string} [options.gate] - Overrides this chat's gate for this call.
   * @returns {{ stdout: any, text: string, stderr: string, status: number|null }} See {@link runHook}.
   */
  fire(event, fields = {}, { gate = this.gate } = {}) {
    const payload = hookPayload(event, { cwd: this.project.dir, session_id: this.sid, permission_mode: this.permissionMode, ...fields });
    const result = runHook(event, payload, { gate });
    assert.equal(result.status, 0, `${event} must exit 0`);
    assert.equal(result.stderr, '', `${event} must not crash: ${result.stderr}`);
    return result;
  }

  /**
   * SessionStart.
   *
   * @param {string} [source] - startup, resume, clear or compact.
   * @returns {ReturnType<Chat['fire']>} Hook result.
   */
  start(source = 'startup') {
    return this.fire('SessionStart', { source, model: 'claude-sonnet-5-5' });
  }

  /**
   * PreToolUse for an edit tool.
   *
   * @param {string} file - Path being edited (absolute, or relative to the project).
   * @param {object} [options]
   * @param {string} [options.tool] - Edit, Write, MultiEdit or NotebookEdit.
   * @param {string} [options.gate] - Overrides the chat's gate.
   * @returns {ReturnType<Chat['fire']>} Hook result.
   */
  pre(file, { tool = 'Edit', gate } = {}) {
    const abs = isAbsolute(file) ? file : this.project.abs(file);
    return this.fire('PreToolUse', { tool_name: tool, tool_input: toolInput(tool, abs), tool_use_id: 'toolu_01' }, { gate });
  }

  /**
   * PostToolUse for an edit tool.
   *
   * @param {string} file - Path that was edited (absolute, or relative to the project).
   * @param {object} [options]
   * @param {string} [options.tool] - Edit, Write, MultiEdit or NotebookEdit.
   * @param {string} [options.mode] - permission_mode for this call (default: the chat's).
   * @param {string} [options.gate] - Overrides the chat's gate.
   * @returns {ReturnType<Chat['fire']>} Hook result.
   */
  post(file, { tool = 'Write', mode = this.permissionMode, gate } = {}) {
    const abs = isAbsolute(file) ? file : this.project.abs(file);
    return this.fire(
      'PostToolUse',
      { tool_name: tool, tool_input: toolInput(tool, abs), tool_response: { filePath: abs, success: true }, tool_use_id: 'toolu_01', permission_mode: mode },
      { gate },
    );
  }

  /**
   * PostToolUse for the Artifact tool.
   *
   * @param {object} [options]
   * @param {string|null} [options.action] - Artifact action (publish, read, ...); null leaves the field out, like a bare publish.
   * @param {string} [options.file] - file_path sent (default: this chat's view.html).
   * @param {string} [options.url] - tool_response.url.
   * @returns {ReturnType<Chat['fire']>} Hook result.
   */
  artifact({ action = 'publish', file = this.file('view.html'), url = 'https://claude.ai/artifact/abc123' } = {}) {
    const input = { file_path: file, icon: 'map' };
    if (action !== null) input.action = action;
    return this.fire('PostToolUse', { tool_name: 'Artifact', tool_input: input, tool_response: { url }, tool_use_id: 'toolu_02' });
  }

  /**
   * Stop.
   *
   * @param {object} [options]
   * @param {boolean} [options.active] - stop_hook_active: true on the pass after a block.
   * @returns {ReturnType<Chat['fire']>} Hook result.
   */
  stop({ active = false } = {}) {
    return this.fire('Stop', { stop_hook_active: active });
  }
}
