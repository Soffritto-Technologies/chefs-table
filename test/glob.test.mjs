import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globToRegExp, matchAny, walk } from '../lib/glob.mjs';

/** Creates a temp dir holding the given posix paths (placeholder contents), removed when the test ends. */
function tree(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-glob-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of files) {
    const fileAbs = path.join(dir, ...file.split('/'));
    fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
    fs.writeFileSync(fileAbs, 'x');
  }
  return dir;
}

/** Asserts each [pattern, path, expected] row. */
function check(rows) {
  for (const [pattern, relPath, expected] of rows) {
    assert.equal(globToRegExp(pattern).test(relPath), expected, `${pattern} vs ${relPath}`);
  }
}

describe('globToRegExp', () => {
  test('** matches any depth, including zero directories', () => {
    check([
      ['src/**', 'src/a.ts', true],
      ['src/**', 'src/x/y.ts', true],
      ['src/**', 'lib/a.ts', false],
      ['src/**/a.ts', 'src/a.ts', true],
      ['src/**/a.ts', 'src/x/y/a.ts', true],
      ['**/*.md', 'README.md', true],
      ['**/*.md', 'docs/deep/guide.md', true],
      ['**/*.md', 'docs/guide.mdx', false],
      ['**/node_modules/**', 'node_modules/pkg/i.js', true],
      ['**/node_modules/**', 'a/b/node_modules/pkg/i.js', true],
      ['**/node_modules/**', 'src/modules/i.js', false],
      ['**/node_modules/**', 'my_node_modules/i.js', false],
    ]);
  });

  test('* and ? never cross a slash', () => {
    check([
      ['*.ts', 'a.ts', true],
      ['*.ts', 'src/a.ts', false],
      ['a?.ts', 'ab.ts', true],
      ['a?.ts', 'a.ts', false],
      ['a?b', 'a/b', false],
    ]);
  });

  test('{a,b} expands, nested and repeated groups included', () => {
    check([
      ['src/{a,b}/**', 'src/a/x.ts', true],
      ['src/{a,b}/**', 'src/b/x.ts', true],
      ['src/{a,b}/**', 'src/c/x.ts', false],
      ['*.{ts,tsx}', 'x.tsx', true],
      ['*.{ts,tsx}', 'x.js', false],
      ['{a,{b,c}}.ts', 'c.ts', true],
      ['{a,b}/{x,y}', 'b/y', true],
      ['{a,b}/{x,y}', 'b/z', false],
      ['a{b', 'a{b', true],
      ['a{b', 'ab', false],
    ]);
  });

  test('metacharacters are escaped and the match is anchored', () => {
    check([
      ['a+b(1)[x]^$|.ts', 'a+b(1)[x]^$|.ts', true],
      ['a.ts', 'abts', false],
      ['src/a', 'xsrc/a', false],
      ['src/a', 'src/ab', false],
      ['(a|b)', 'a', false],
    ]);
  });
});

describe('matchAny', () => {
  test('true when any pattern matches; empty list never matches', () => {
    assert.equal(matchAny(['src/**', '*.md'], 'README.md'), true);
    assert.equal(matchAny(['src/**', '*.md'], 'src/a.ts'), true);
    assert.equal(matchAny(['src/**', '*.md'], 'lib/a.ts'), false);
    assert.equal(matchAny([], 'a.ts'), false);
  });

  test('repeated calls agree (cached regex) and backslash paths work', () => {
    assert.equal(matchAny(['*.ts'], 'a.ts'), true);
    assert.equal(matchAny(['*.ts'], 'a.ts'), true);
    assert.equal(matchAny(['src/**'], 'src\\x\\y.ts'), true);
  });
});

describe('walk', () => {
  test('returns sorted relative posix paths matching include and not exclude', (t) => {
    const dir = tree(t, ['src/b.ts', 'src/a.ts', 'src/deep/c.tsx', 'src/a.test.ts', 'README.md', 'lib/d.ts']);
    assert.deepEqual(walk(dir, { include: ['src/**'], exclude: ['**/*.test.*'] }), ['src/a.ts', 'src/b.ts', 'src/deep/c.tsx']);
    assert.deepEqual(walk(dir).length, 6);
  });

  test('never enters .git or node_modules, at any depth', (t) => {
    const dir = tree(t, ['.git/config', 'node_modules/p/i.js', 'src/node_modules/p/i.js', 'src/.git/x', 'src/ok.js']);
    assert.deepEqual(walk(dir), ['src/ok.js']);
  });

  test('does not follow symlinked directories', (t) => {
    const dir = tree(t, ['real/a.txt', 'top.txt']);
    try {
      fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), 'dir');
    } catch {
      t.skip('symlinks are not permitted here');
      return;
    }
    assert.deepEqual(walk(dir), ['real/a.txt', 'top.txt']);
  });

  test('stops at maxFiles deterministically', (t) => {
    const dir = tree(t, ['a/1.txt', 'a/2.txt', 'b/3.txt', 'c/4.txt']);
    assert.deepEqual(walk(dir, { maxFiles: 3 }), ['a/1.txt', 'a/2.txt', 'b/3.txt']);
    assert.deepEqual(walk(dir, { maxFiles: 0 }), []);
  });

  test('pruning directories never loses a match', (t) => {
    const dir = tree(t, ['src/a.ts', 'src/x/b.ts', '.next/cache/c.ts', 'app/page.tsx']);
    assert.deepEqual(walk(dir, { include: ['src/**', 'app/**'] }), ['app/page.tsx', 'src/a.ts', 'src/x/b.ts']);
    assert.deepEqual(walk(dir, { include: ['**/*.ts'] }), ['.next/cache/c.ts', 'src/a.ts', 'src/x/b.ts']);
    assert.deepEqual(walk(dir, { include: ['src/{x,y}/**'] }), ['src/x/b.ts']);
    assert.deepEqual(walk(dir, { include: [] }), []);
  });

  test('a missing root yields no files', () => {
    assert.deepEqual(walk(path.join(os.tmpdir(), 'jm-glob-does-not-exist')), []);
  });
});
