import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Copies a JSON value with every object's keys in alphabetical order.
 *
 * @param {unknown} value - Any JSON-compatible value.
 * @returns {unknown} Copy with sorted keys (primitives are returned as is).
 */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeysDeep(value[key])]));
}

/**
 * Serializes a JSON value with sorted keys, so equal data always gives equal text.
 *
 * @param {unknown} value - Any JSON-compatible value.
 * @returns {string|undefined} Canonical JSON (undefined only when `value` is undefined).
 */
export function canonicalJson(value) {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * SHA-1 hex digest of a string.
 *
 * @param {string} text - Input.
 * @returns {string} 40-character lowercase hex digest.
 */
export function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

/**
 * Writes text atomically (temp file in the same folder, then rename) so readers never see half a file.
 * The temp file is removed if the rename fails.
 *
 * @param {string} file - Absolute path; parent folders are created.
 * @param {string} text - Contents.
 * @returns {void}
 * @throws {Error} When the file cannot be written or renamed into place.
 */
export function writeTextAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, text, 'utf8');
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
