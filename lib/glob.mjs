import fs from 'node:fs';
import path from 'node:path';

const ALWAYS_SKIPPED_DIRS = new Set(['.git', 'node_modules']);
const regexCache = new Map();

function findClosingBrace(pattern, open) {
  let depth = 0;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') depth--;
    else if (body[i] === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

// Expands {a,b} groups (nested too) into brace-free patterns. An unbalanced "{" stays and is matched literally.
function expandBraces(pattern) {
  const open = pattern.indexOf('{');
  const close = open === -1 ? -1 : findClosingBrace(pattern, open);
  if (close === -1) return [pattern];
  const suffixes = expandBraces(pattern.slice(close + 1));
  const expanded = [];
  for (const alternative of splitTopLevel(pattern.slice(open + 1, close))) {
    for (const middle of expandBraces(alternative)) {
      for (const suffix of suffixes) expanded.push(pattern.slice(0, open) + middle + suffix);
    }
  }
  return expanded;
}

function toRegexSource(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      let last = i;
      while (pattern[last + 1] === '*') last++;
      if (last === i) {
        source += '[^/]*';
      } else if (pattern[last + 1] === '/') {
        source += '(?:.*/)?'; // "**/" also matches zero directories
        last++;
      } else {
        source += '.*';
      }
      i = last;
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return source;
}

/**
 * Compiles a glob into an anchored RegExp that must match a whole posix path.
 * Supports `**` (any depth, including zero directories), `*` (no slash), `?` and `{a,b}`.
 * Every other character is matched literally.
 *
 * @param {string} pattern Glob such as "src/**" or "**\/*.{ts,tsx}".
 * @returns {RegExp}
 */
export function globToRegExp(pattern) {
  return new RegExp(`^(?:${expandBraces(pattern).map(toRegexSource).join('|')})$`);
}

/**
 * Tests a relative path against several globs. Compiled regexes are cached per pattern.
 *
 * @param {string[]} patterns
 * @param {string} relPath Relative path; backslashes are treated as separators.
 * @returns {boolean} True when any pattern matches.
 */
export function matchAny(patterns, relPath) {
  const posixPath = relPath.replace(/\\/g, '/');
  return patterns.some((pattern) => {
    let regex = regexCache.get(pattern);
    if (!regex) {
      regex = globToRegExp(pattern);
      regexCache.set(pattern, regex);
    }
    return regex.test(posixPath);
  });
}

// Static leading directories of a glob ("src/**" gives ["src"]), one list per brace alternative.
function directoryPrefixes(pattern) {
  return expandBraces(pattern).map((alternative) => {
    const directories = alternative.split('/').slice(0, -1);
    const firstWildcard = directories.findIndex((segment) => /[*?]/.test(segment));
    return firstWildcard === -1 ? directories : directories.slice(0, firstWildcard);
  });
}

// A directory is worth entering when it lies on, or below, some include prefix.
function mayContainMatches(dirRel, prefixes) {
  const dirSegments = dirRel.split('/');
  return prefixes.some((prefix) => {
    const shared = Math.min(prefix.length, dirSegments.length);
    return prefix.slice(0, shared).every((segment, i) => segment === dirSegments[i]);
  });
}

function readEntries(dirAbs) {
  try {
    return fs.readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

// Symlinked directories and broken links are null; symlinked files count as files.
function entryKind(entryAbs, entry) {
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  if (!entry.isSymbolicLink()) return null;
  try {
    return fs.statSync(entryAbs).isFile() ? 'file' : null;
  } catch {
    return null;
  }
}

/**
 * Lists files under a root that match any include glob and no exclude glob.
 * `.git` and `node_modules` are never entered, symlinked directories are not followed,
 * and directories that cannot hold an include match are pruned.
 *
 * @param {string} rootAbs Absolute directory to walk.
 * @param {object} [options]
 * @param {string[]} [options.include] Globs relative to rootAbs. Defaults to everything.
 * @param {string[]} [options.exclude] Globs relative to rootAbs that remove files again.
 * @param {number} [options.maxFiles] Stop after this many matching files.
 * @returns {string[]} Sorted relative paths with "/" separators on every OS.
 */
export function walk(rootAbs, { include = ['**'], exclude = [], maxFiles = 100000 } = {}) {
  const prefixes = include.flatMap(directoryPrefixes);
  const found = [];

  const visit = (dirRel) => {
    for (const entry of readEntries(path.join(rootAbs, dirRel))) {
      if (found.length >= maxFiles) return;
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      const kind = entryKind(path.join(rootAbs, rel), entry);
      if (kind === 'dir') {
        if (!ALWAYS_SKIPPED_DIRS.has(entry.name) && mayContainMatches(rel, prefixes)) visit(rel);
      } else if (kind === 'file' && matchAny(include, rel) && !matchAny(exclude, rel)) {
        found.push(rel);
      }
    }
  };

  visit('');
  return found.sort();
}
