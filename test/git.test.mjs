import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readHeadCommit } from '../lib/git.mjs';

const dirs = [];
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/**
 * Makes an empty temp folder, removed after the tests.
 *
 * @returns {string} Absolute path.
 */
function tmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'jm-git-'));
  dirs.push(dir);
  return dir;
}

/**
 * Writes a file, creating its folders.
 *
 * @param {string} file - Absolute path.
 * @param {string} text - Content.
 * @returns {void}
 */
function put(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('readHeadCommit', () => {
  it('follows HEAD to a loose branch ref', () => {
    const dir = tmp();
    put(path.join(dir, '.git/HEAD'), 'ref: refs/heads/main\n');
    put(path.join(dir, '.git/refs/heads/main'), `${SHA_A}\n`);
    assert.equal(readHeadCommit(dir), SHA_A);
  });

  it('falls back to packed-refs, with CRLF line endings', () => {
    const dir = tmp();
    put(path.join(dir, '.git/HEAD'), 'ref: refs/heads/main\r\n');
    put(path.join(dir, '.git/packed-refs'), `# pack-refs\r\n${SHA_B} refs/heads/other\r\n${SHA_A} refs/heads/main\r\n`);
    assert.equal(readHeadCommit(dir), SHA_A);
  });

  it('reads a detached HEAD directly', () => {
    const dir = tmp();
    put(path.join(dir, '.git/HEAD'), `${SHA_B}\n`);
    assert.equal(readHeadCommit(dir), SHA_B);
  });

  it('finds the repository from a subfolder', () => {
    const dir = tmp();
    put(path.join(dir, '.git/HEAD'), `${SHA_A}\n`);
    mkdirSync(path.join(dir, 'apps/web'), { recursive: true });
    assert.equal(readHeadCommit(path.join(dir, 'apps/web')), SHA_A);
  });

  it('follows a .git file to a worktree and reads shared refs through commondir', () => {
    const main = tmp();
    const tree = tmp();
    put(path.join(main, '.git/refs/heads/feature'), `${SHA_B}\n`);
    put(path.join(main, '.git/worktrees/wt/HEAD'), 'ref: refs/heads/feature\n');
    put(path.join(main, '.git/worktrees/wt/commondir'), '../..\n');
    put(path.join(tree, '.git'), `gitdir: ${path.join(main, '.git/worktrees/wt')}\n`);
    assert.equal(readHeadCommit(tree), SHA_B);
  });

  it('is null when it cannot tell', () => {
    const none = tmp();
    assert.equal(readHeadCommit(path.join(none, 'missing')), null);
    const unborn = tmp();
    put(path.join(unborn, '.git/HEAD'), 'ref: refs/heads/main\n');
    assert.equal(readHeadCommit(unborn), null);
    const junk = tmp();
    put(path.join(junk, '.git/HEAD'), 'nonsense\n');
    assert.equal(readHeadCommit(junk), null);
    const badFile = tmp();
    put(path.join(badFile, '.git'), 'not a pointer\n');
    assert.equal(readHeadCommit(badFile), null);
  });
});
