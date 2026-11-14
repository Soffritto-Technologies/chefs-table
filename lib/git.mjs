/**
 * Reads the current commit straight from git's files, without running git.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Reads a small text file, trimmed.
 *
 * @param {string} file - Absolute path.
 * @returns {string | null} The text, or null when it can't be read.
 */
function readTrimmed(file) {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Finds the git directory at or above a folder. A `.git` file (worktree or submodule) points at the real one.
 *
 * @param {string} startDir - Folder to start from.
 * @returns {string | null} The git directory, or null when there is none.
 */
function findGitDir(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    const dot = join(dir, '.git');
    if (existsSync(dot)) {
      if (statSync(dot).isDirectory()) return dot;
      const match = /^gitdir:\s*(.+)$/m.exec(readTrimmed(dot) || '');
      return match ? resolve(dir, match[1].trim()) : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Looks a ref up as a loose file, then in packed-refs, in each of the given git directories.
 *
 * @param {string[]} gitDirs - Own git directory first, then the common one.
 * @param {string} ref - For example "refs/heads/main".
 * @returns {string | null} The commit sha, or null when not found.
 */
function resolveRef(gitDirs, ref) {
  for (const dir of gitDirs) {
    const loose = readTrimmed(join(dir, ref));
    if (loose && SHA_RE.test(loose)) return loose;
  }
  for (const dir of gitDirs) {
    const packed = readTrimmed(join(dir, 'packed-refs'));
    if (!packed) continue;
    for (const line of packed.split(/\r?\n/)) {
      const [sha, name] = line.split(' ');
      if (name === ref && SHA_RE.test(sha)) return sha;
    }
  }
  return null;
}

/**
 * The commit HEAD points at, read from `.git` files only.
 *
 * @param {string} projectDir - A folder inside the repository.
 * @returns {string | null} The commit sha, or null when it can't be told (no repo, unreadable, unborn branch). Never throws.
 */
export function readHeadCommit(projectDir) {
  try {
    const gitDir = findGitDir(projectDir);
    if (!gitDir) return null;
    const head = readTrimmed(join(gitDir, 'HEAD'));
    if (!head) return null;
    if (SHA_RE.test(head)) return head;
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1].trim();
    if (!ref) return null;
    const common = readTrimmed(join(gitDir, 'commondir'));
    return resolveRef(common ? [gitDir, resolve(gitDir, common)] : [gitDir], ref);
  } catch {
    return null;
  }
}
