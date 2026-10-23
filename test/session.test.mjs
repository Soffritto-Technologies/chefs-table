import { after, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as S from '../lib/session.mjs';
import { DEFAULT_CONFIG } from '../lib/types.mjs';
import { cleanupProjects, trackTempDir } from './helpers/project.mjs';

after(cleanupProjects);

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

/**
 * Makes an empty real temp dir that is deleted when the file finishes.
 *
 * @returns {string} Absolute path.
 */
function tempDir() {
  return trackTempDir(realpathSync(mkdtempSync(path.join(tmpdir(), 'jm-session-'))));
}

/**
 * Makes a temp project that already has `.journeys/journeys.json`.
 *
 * @returns {string} Absolute project path.
 */
function journeysProject() {
  const dir = tempDir();
  mkdirSync(path.join(dir, '.journeys'));
  writeFileSync(path.join(dir, '.journeys', 'journeys.json'), '{}');
  return dir;
}

/**
 * Lists a directory's entries, sorted.
 *
 * @param {string} dir - Directory.
 * @returns {string[]} Names.
 */
function names(dir) {
  return readdirSync(dir).sort();
}

describe('paths', () => {
  it('returns project-level paths when no session id is given', () => {
    const p = S.paths('/proj');
    assert.equal(p.doc, path.join('/proj', '.journeys', 'journeys.json'));
    assert.equal(p.canonical, path.join('/proj', 'journeys.html'));
    assert.equal(p.sessions, path.join('/proj', '.journeys', '.session'));
    assert.equal(p.view, undefined);
  });

  it('puts every session file inside .journeys/.session/<id>', () => {
    const p = S.paths('/proj', 'abc-123_XYZ');
    const folder = path.join('/proj', '.journeys', '.session', 'abc-123_XYZ');
    for (const key of ['start', 'last', 'routes', 'touched', 'plan', 'approval', 'view', 'viewHash', 'published', 'noFlow', 'stepFiles', 'turn', 'flags', 'errors']) {
      assert.equal(path.dirname(p[key]), folder, key);
    }
    assert.equal(p.session, folder);
    assert.equal(p.anchorCache, path.join('/proj', '.journeys', '.anchor-cache.json'), 'the anchor cache is shared by every chat');
    assert.equal(p.sessionId, 'abc-123_XYZ');
  });

  it('accepts a 128-character id', () => {
    assert.doesNotThrow(() => S.paths('/proj', 'a'.repeat(128)));
  });

  for (const bad of ['../evil', '../../evil', '..\\evil', 'a/b', '/etc/passwd', '', ' ', 'a b', 'a.b', '..', '.', 'a'.repeat(129), 'ok\n', 'caf\u00e9']) {
    it(`rejects the session id ${JSON.stringify(bad)}`, () => {
      assert.throws(() => S.paths('/proj', bad), /unexpected session id/);
    });
  }

  it('rejects ids that are not strings', () => {
    for (const bad of [null, 123, ['a'], { a: 1 }]) assert.throws(() => S.paths('/proj', bad), Error, String(bad));
  });
});

describe('findProjectDir', () => {
  it('finds the project from a deeply nested folder', () => {
    const root = journeysProject();
    const deep = path.join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    assert.equal(S.findProjectDir(deep), root);
    assert.equal(S.findProjectDir(root), root);
  });

  it('prefers the nearest .journeys/journeys.json', () => {
    const outer = journeysProject();
    const inner = path.join(outer, 'packages', 'web');
    mkdirSync(path.join(inner, '.journeys'), { recursive: true });
    writeFileSync(path.join(inner, '.journeys', 'journeys.json'), '{}');
    assert.equal(S.findProjectDir(path.join(inner, 'src')), inner);
    assert.equal(S.findProjectDir(path.join(outer, 'packages')), outer);
  });

  it('walks past a .journeys folder that has no journeys.json', () => {
    const outer = journeysProject();
    const inner = path.join(outer, 'sub');
    mkdirSync(path.join(inner, '.journeys'), { recursive: true });
    assert.equal(S.findProjectDir(inner), outer);
  });

  it('returns null when journeymap is not set up anywhere above', () => {
    assert.equal(S.findProjectDir(tempDir()), null);
  });

  it('works from a folder that no longer exists', () => {
    const root = journeysProject();
    assert.equal(S.findProjectDir(path.join(root, 'deleted', 'folder')), root);
  });
});

describe('toProjectPath', () => {
  const proj = path.resolve(path.sep, 'work', 'proj');

  it('converts an absolute path inside the project to a relative posix path', () => {
    assert.equal(S.toProjectPath(proj, path.join(proj, 'app', '(shop)', 'checkout', 'page.tsx')), 'app/(shop)/checkout/page.tsx');
  });

  it('resolves a relative path against the project, not the process cwd', () => {
    assert.equal(S.toProjectPath(proj, path.join('src', 'a.ts')), 'src/a.ts');
    assert.equal(S.toProjectPath(proj, `.${path.sep}src${path.sep}a.ts`), 'src/a.ts');
  });

  it('returns null for files outside the project', () => {
    assert.equal(S.toProjectPath(proj, path.resolve(path.sep, 'work', 'other', 'a.ts')), null);
    assert.equal(S.toProjectPath(proj, path.resolve(path.sep, 'work', 'a.ts')), null);
    assert.equal(S.toProjectPath(proj, path.join('..', 'a.ts')), null);
    assert.equal(S.toProjectPath(proj, path.join('src', '..', '..', 'a.ts')), null);
  });

  it('returns null for a sibling folder that shares the project name as a prefix', () => {
    assert.equal(S.toProjectPath(proj, path.resolve(path.sep, 'work', 'proj-evil', 'a.ts')), null);
  });

  it('returns null for the project folder itself and for empty input', () => {
    assert.equal(S.toProjectPath(proj, proj), null);
    for (const empty of ['', undefined, null]) assert.equal(S.toProjectPath(proj, empty), null);
  });

  it('keeps dotfiles and dot-folders inside the project', () => {
    assert.equal(S.toProjectPath(proj, path.join(proj, '.env')), '.env');
    assert.equal(S.toProjectPath(proj, path.join(proj, '.journeys', 'journeys.json')), '.journeys/journeys.json');
  });

  it('always returns "/" separators', () => {
    const rel = S.toProjectPath(proj, ['src', 'deep', 'er', 'file.ts'].join(path.sep));
    assert.equal(rel, 'src/deep/er/file.ts');
    assert.ok(!rel.includes('\\'));
  });

  it('treats a leading ".." in a file name as part of the name, not as leaving the project', () => {
    assert.equal(S.toProjectPath(proj, path.join(proj, '..hidden', 'a.ts')), '..hidden/a.ts');
    assert.equal(S.toProjectPath(proj, path.join(proj, '...rc')), '...rc');
  });

  describe('Windows-style paths', { skip: process.platform !== 'win32' && 'only meaningful on Windows (node:path is platform specific)' }, () => {
    const win = 'C:\\work\\proj';

    it('converts backslash paths, including mixed separators', () => {
      assert.equal(S.toProjectPath(win, 'C:\\work\\proj\\app\\(shop)\\page.tsx'), 'app/(shop)/page.tsx');
      assert.equal(S.toProjectPath(win, 'C:/work/proj/app/page.tsx'), 'app/page.tsx');
      assert.equal(S.toProjectPath(win, 'app\\page.tsx'), 'app/page.tsx');
    });

    it('is case-insensitive about the drive letter and rejects other drives', () => {
      assert.equal(S.toProjectPath(win, 'c:\\work\\proj\\a.ts'), 'a.ts');
      assert.equal(S.toProjectPath(win, 'D:\\work\\proj\\a.ts'), null);
      assert.equal(S.toProjectPath(win, 'C:\\work\\proj-evil\\a.ts'), null);
    });
  });
});

describe('initSession', () => {
  const docA = { version: 1, app: 'A', journeys: [] };
  const docB = { version: 1, app: 'B', journeys: [] };
  const routesA = [{ file: 'app/page.tsx', route: '/' }];

  /**
   * Starts a session in a fresh project, then dirties its state like a working chat would.
   *
   * @returns {Record<string, string>} Session paths.
   */
  function workedSession() {
    const p = S.paths(tempDir(), 'chat-1');
    S.initSession(p, { doc: docA, routes: routesA, source: 'startup' });
    S.writeJson(p.last, { version: 1, app: 'LAST', journeys: [] });
    S.writeJson(p.touched, ['app/page.tsx']);
    S.writeJson(p.turn, { blocked: true, nudged: ['app/page.tsx'] });
    return p;
  }

  it('creates the baseline files on startup', () => {
    const p = S.paths(tempDir(), 'chat-1');
    const result = S.initSession(p, { doc: docA, routes: routesA, source: 'startup' });
    assert.deepEqual(result, { resumed: false });
    assert.deepEqual(S.readJson(p.start), docA);
    assert.deepEqual(S.readJson(p.last), docA);
    assert.deepEqual(S.readJson(p.routes), routesA);
    assert.deepEqual(S.readJson(p.touched), []);
    assert.deepEqual(S.readJson(p.turn), { blocked: false, nudged: [] });
  });

  for (const source of ['resume', 'compact']) {
    it(`keeps start.json and the turn state on source "${source}"`, () => {
      const p = workedSession();
      const result = S.initSession(p, { doc: docB, routes: [], source });
      assert.deepEqual(result, { resumed: true });
      assert.deepEqual(S.readJson(p.start), docA);
      assert.equal(S.readJson(p.last).app, 'LAST');
      assert.deepEqual(S.readJson(p.routes), routesA);
      assert.deepEqual(S.readJson(p.touched), ['app/page.tsx']);
      assert.deepEqual(S.readJson(p.turn), { blocked: true, nudged: ['app/page.tsx'] });
    });
  }

  for (const source of ['startup', 'clear', undefined, 'something-new']) {
    it(`resets everything on source ${JSON.stringify(source)}`, () => {
      const p = workedSession();
      const result = S.initSession(p, { doc: docB, routes: [], source });
      assert.deepEqual(result, { resumed: false });
      assert.deepEqual(S.readJson(p.start), docB);
      assert.deepEqual(S.readJson(p.last), docB);
      assert.deepEqual(S.readJson(p.routes), []);
      assert.deepEqual(S.readJson(p.touched), []);
      assert.deepEqual(S.readJson(p.turn), { blocked: false, nudged: [] });
    });
  }

  it('starts fresh on "resume" when there is no start.json yet', () => {
    const p = S.paths(tempDir(), 'chat-1');
    const result = S.initSession(p, { doc: docB, routes: routesA, source: 'resume' });
    assert.deepEqual(result, { resumed: false });
    assert.deepEqual(S.readJson(p.start), docB);
  });
});

describe('recordTouched', () => {
  it('records a file once, in the order first touched', () => {
    const p = S.paths(tempDir(), 'chat-1');
    S.recordTouched(p, 'app/a.tsx');
    S.recordTouched(p, 'app/b.tsx');
    S.recordTouched(p, 'app/a.tsx');
    S.recordTouched(p, 'app/a.tsx');
    assert.deepEqual(S.readJson(p.touched), ['app/a.tsx', 'app/b.tsx']);
  });

  it('creates the session folder and file when the session never started', () => {
    const p = S.paths(tempDir(), 'chat-1');
    S.recordTouched(p, 'x.ts');
    assert.deepEqual(S.readJson(p.touched), ['x.ts']);
  });

  it('does not rewrite the file for a duplicate', () => {
    const p = S.paths(tempDir(), 'chat-1');
    S.recordTouched(p, 'x.ts');
    const before = readFileSync(p.touched, 'utf8');
    S.writeTextAtomic(p.touched, `${before}\n`);
    S.recordTouched(p, 'x.ts');
    assert.equal(readFileSync(p.touched, 'utf8'), `${before}\n`);
  });
});

describe('sweepSessions', () => {
  /**
   * Makes a session folder whose mtime is `ageMs` before T0.
   *
   * @param {string} dir - Project dir.
   * @param {string} id - Folder name.
   * @param {number} ageMs - Age in ms.
   * @returns {string} The folder path.
   */
  function sessionAged(dir, id, ageMs) {
    const folder = path.join(dir, '.journeys', '.session', id);
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'start.json'), '{}');
    const when = new Date(T0 - ageMs);
    utimesSync(folder, when, when);
    return folder;
  }

  it('removes only folders older than 7 days', () => {
    const dir = tempDir();
    const old = sessionAged(dir, 'old', 8 * DAY);
    const veryOld = sessionAged(dir, 'very-old', 90 * DAY);
    const fresh = sessionAged(dir, 'fresh', 1 * DAY);
    const justUnder = sessionAged(dir, 'just-under', 7 * DAY - 1000);
    const removed = S.sweepSessions(dir, T0);
    assert.equal(removed, 2);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(veryOld), false);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(justUnder), true);
  });

  it('keeps a folder that is exactly 7 days old', () => {
    const dir = tempDir();
    const edge = sessionAged(dir, 'edge', 7 * DAY);
    assert.equal(S.sweepSessions(dir, T0), 0);
    assert.equal(existsSync(edge), true);
    assert.equal(S.sweepSessions(dir, T0 + 1000), 1);
    assert.equal(existsSync(edge), false);
  });

  it('leaves plain files in the sessions folder alone', () => {
    const dir = tempDir();
    sessionAged(dir, 'old', 30 * DAY);
    const stray = path.join(dir, '.journeys', '.session', 'notes.txt');
    writeFileSync(stray, 'keep me');
    const when = new Date(T0 - 30 * DAY);
    utimesSync(stray, when, when);
    assert.equal(S.sweepSessions(dir, T0), 1);
    assert.equal(existsSync(stray), true);
  });

  it('does not touch the rest of .journeys', () => {
    const dir = journeysProject();
    sessionAged(dir, 'old', 30 * DAY);
    S.sweepSessions(dir, T0);
    assert.deepEqual(names(path.join(dir, '.journeys')), ['.session', 'journeys.json']);
  });

  it('returns 0 when there is no sessions folder', () => {
    assert.equal(S.sweepSessions(tempDir(), T0), 0);
  });

  it('uses the current time when `now` is omitted', () => {
    const dir = tempDir();
    const folder = path.join(dir, '.journeys', '.session', 'ancient');
    mkdirSync(folder, { recursive: true });
    utimesSync(folder, new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));
    const recent = path.join(dir, '.journeys', '.session', 'recent');
    mkdirSync(recent, { recursive: true });
    assert.equal(S.sweepSessions(dir), 1);
    assert.equal(existsSync(folder), false);
    assert.equal(existsSync(recent), true);
  });
});

describe('writeTextAtomic', () => {
  it('writes the text and leaves no temp files, even after many writes', () => {
    const dir = tempDir();
    const file = path.join(dir, 'out.txt');
    for (let i = 0; i < 25; i += 1) S.writeTextAtomic(file, `version ${i}`);
    assert.equal(readFileSync(file, 'utf8'), 'version 24');
    assert.deepEqual(names(dir), ['out.txt']);
  });

  it('creates missing parent folders', () => {
    const dir = tempDir();
    const file = path.join(dir, 'a', 'b', 'c.txt');
    S.writeTextAtomic(file, 'hi');
    assert.equal(readFileSync(file, 'utf8'), 'hi');
    assert.deepEqual(names(path.join(dir, 'a', 'b')), ['c.txt']);
  });

  it('replaces an existing file completely', () => {
    const dir = tempDir();
    const file = path.join(dir, 'out.txt');
    S.writeTextAtomic(file, 'a long first version');
    S.writeTextAtomic(file, 'short');
    assert.equal(readFileSync(file, 'utf8'), 'short');
  });

  it('writeJson writes 2-space JSON with a trailing newline', () => {
    const dir = tempDir();
    const file = path.join(dir, 'x.json');
    S.writeJson(file, { a: [1, 2] });
    assert.equal(readFileSync(file, 'utf8'), '{\n  "a": [\n    1,\n    2\n  ]\n}\n');
    assert.deepEqual(names(dir), ['x.json']);
  });

  it('throws and leaves the target untouched when the write cannot complete', () => {
    const dir = tempDir();
    const target = path.join(dir, 'blocked');
    mkdirSync(target);
    assert.throws(() => S.writeTextAtomic(target, 'data'));
    assert.equal(existsSync(target), true);
  });

  it('leaves no temp file behind when the rename fails', () => {
    const dir = tempDir();
    const target = path.join(dir, 'blocked');
    mkdirSync(target);
    assert.throws(() => S.writeTextAtomic(target, 'data'));
    assert.deepEqual(names(dir), ['blocked']);
  });
});

describe('small helpers', () => {
  it('readJson returns the fallback for a missing file and for invalid JSON', () => {
    const dir = tempDir();
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{ nope');
    assert.deepEqual(S.readJson(path.join(dir, 'missing.json'), ['fb']), ['fb']);
    assert.deepEqual(S.readJson(bad, { fb: true }), { fb: true });
    assert.equal(S.readJson(bad), null);
  });

  it('readText returns the fallback for a missing file', () => {
    const dir = tempDir();
    assert.equal(S.readText(path.join(dir, 'missing')), null);
    assert.equal(S.readText(path.join(dir, 'missing'), ''), '');
  });

  it('removeFile deletes a file and ignores a missing one', () => {
    const dir = tempDir();
    const file = path.join(dir, 'x');
    writeFileSync(file, '1');
    S.removeFile(file);
    S.removeFile(file);
    assert.equal(existsSync(file), false);
  });

  it('sha1 matches the known digest', () => {
    assert.equal(S.sha1('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
    assert.equal(S.sha1('').length, 40);
  });

  it('loadConfig returns the defaults without a config file or with a broken one', () => {
    const dir = journeysProject();
    assert.deepEqual(S.loadConfig(dir), DEFAULT_CONFIG);
    writeFileSync(path.join(dir, '.journeys', 'config.json'), 'not json');
    assert.deepEqual(S.loadConfig(dir), DEFAULT_CONFIG);
    writeFileSync(path.join(dir, '.journeys', 'config.json'), 'null');
    assert.deepEqual(S.loadConfig(dir), DEFAULT_CONFIG);
  });

  it('loadConfig lets user keys replace the defaults and keeps the rest', () => {
    const dir = journeysProject();
    writeFileSync(path.join(dir, '.journeys', 'config.json'), JSON.stringify({ root: 'web', shared: ['/home'] }));
    const config = S.loadConfig(dir);
    assert.equal(config.root, 'web');
    assert.deepEqual(config.shared, ['/home']);
    assert.deepEqual(config.routeDirs, DEFAULT_CONFIG.routeDirs);
  });

  it('readTurn fills in missing fields', () => {
    const p = S.paths(tempDir(), 'chat-1');
    assert.deepEqual(S.readTurn(p), { blocked: false, nudged: [] });
    S.writeJson(p.turn, { nudged: ['a.ts'] });
    assert.deepEqual(S.readTurn(p), { blocked: false, nudged: ['a.ts'] });
  });

  describe('logError', () => {
    it('appends a timestamped line to errors.log and warns on stderr', () => {
      const p = S.paths(tempDir(), 'chat-1');
      const write = mock.method(process.stderr, 'write', () => true);
      try {
        S.logError(p, 'Stop', new Error('boom'));
        S.logError(p, 'PreToolUse', 'plain text');
      } finally {
        write.mock.restore();
      }
      const lines = readFileSync(p.errors, 'utf8').trim().split('\n');
      assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z Stop: Error: boom/);
      assert.match(readFileSync(p.errors, 'utf8'), /PreToolUse: plain text\n$/);
      assert.equal(write.mock.callCount(), 2);
      assert.match(String(write.mock.calls[0].arguments[0]), /journeymap: Stop failed/);
    });

    it('does not throw without session paths', () => {
      const write = mock.method(process.stderr, 'write', () => true);
      try {
        assert.doesNotThrow(() => S.logError(null, 'Stop', new Error('x')));
      } finally {
        write.mock.restore();
      }
    });

    it('never throws when the log cannot be written', () => {
      const dir = tempDir();
      const p = S.paths(dir, 'chat-1');
      mkdirSync(p.errors, { recursive: true });
      const write = mock.method(process.stderr, 'write', () => true);
      try {
        assert.doesNotThrow(() => S.logError(p, 'Stop', new Error('x')));
      } finally {
        write.mock.restore();
      }
    });
  });
});
