/**
 * The journeys document: validation, loading, deterministic saving and plan application.
 * Everything that touches `.journeys/journeys.json` on disk goes through this module.
 */

import { readFileSync, statSync } from 'node:fs';
import { canonicalJson, sha1, sortKeysDeep, writeTextAtomic } from './util.mjs';
import { LIMITS } from './types.mjs';

/** @typedef {import('./types.mjs').JourneysDoc} JourneysDoc */
/** @typedef {import('./types.mjs').Journey} Journey */
/** @typedef {import('./types.mjs').Plan} Plan */

const MAX_ID_LENGTH = 64;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_DETAIL_ITEMS = 20;
const MAX_AREA_DEPTH = 4;
const MAX_SAVE_ATTEMPTS = 5;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const HAS_CONTROL_CHAR = /[\u0000-\u001F\u007F]/;
const WINDOWS_DRIVE = /^[A-Za-z]:/;

const DOC_KEYS = ['version', 'app', 'apps', 'areas', 'journeys'];
const APP_KEYS = ['id', 'title', 'kind', 'root'];
const APP_KINDS = ['web', 'desktop', 'mobile', 'server', 'agent'];
const AREA_KEYS = ['id', 'title', 'say'];
const JOURNEY_KEYS = ['id', 'title', 'area', 'who', 'apps', 'steps'];
const STEP_KEYS = ['id', 'label', 'say', 'kind', 'result', 'trigger', 'screen', 'anchor', 'next', 'continues', 'detail', 'subflow'];
const STEP_KINDS = ['action', 'decision', 'outcome', 'background'];
const STEP_RESULTS = ['success', 'failure', 'abandoned'];
const MAX_WHEN = 40;
const MAX_TRIGGER = 60;
const ANCHOR_KEYS = ['type', 'value'];
const DETAIL_KEYS = ['sees', 'does', 'rules', 'saves', 'files'];

/** An error whose message is written for a non-technical reader. */
export class ModelError extends Error {
  /**
   * @param {string} message Plain-language explanation of what went wrong.
   * @param {string[]} [errors] The individual problems, when there are several.
   */
  constructor(message, errors = []) {
    super(message);
    this.name = 'ModelError';
    this.errors = errors;
  }
}

/**
 * Strips control characters (U+0000-U+001F, U+007F), trims, and caps the text to LIMITS.TEXT characters.
 *
 * @param {unknown} s Text to clean.
 * @returns {string} The cleaned text, or '' when `s` is not a string.
 */
export function sanitizeText(s) {
  if (typeof s !== 'string') return '';
  const capped = s.replace(CONTROL_CHARS, '').trim().slice(0, LIMITS.TEXT);
  const lastUnit = capped.charCodeAt(capped.length - 1);
  const splitPair = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return splitPair ? capped.slice(0, -1) : capped;
}

/**
 * Checks a journeys document and returns a sanitized deep copy of it.
 * `areas` is only enforced when present: an empty list means "no journey may name an area".
 *
 * @param {unknown} doc The parsed contents of journeys.json.
 * @returns {{ ok: true, doc: JourneysDoc } | { ok: false, errors: string[] }} The cleaned copy, or every problem found.
 */
export function validateDoc(doc) {
  const copy = cloneJson(doc);
  if (!isPlainObject(copy)) {
    return { ok: false, errors: ['The journey map must be a JSON object with "version", "app" and "journeys".'] };
  }
  const errors = [];
  if (copy.version !== 1) errors.push('The journey map must have "version": 1.');
  if (typeof copy.app !== 'string') errors.push('The journey map needs an "app" name written in quotes.');
  const appIds = checkApps(copy, errors);
  const areaIds = checkAreas(copy, errors);
  if (Array.isArray(copy.journeys)) {
    const journeyIds = checkJourneyIds(copy.journeys, errors);
    for (const journey of copy.journeys.filter(isPlainObject)) {
      checkJourney(journey, { journeyIds, areaIds, appIds }, errors);
    }
    checkSubflowCycles(copy.journeys, errors);
  } else {
    errors.push('The journey map needs a "journeys" list.');
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, doc: copy };
}

/**
 * Reads, parses and validates a journeys file.
 *
 * @param {string} path Path to journeys.json.
 * @returns {{ doc: JourneysDoc, mtimeMs: number, hash: string }} The sanitized document plus the file's mtime and the sha1 of its raw text.
 * @throws {ModelError} When the file is missing, is not valid JSON, or fails validation.
 */
export function loadDoc(path) {
  const snapshot = readSnapshot(path);
  return { doc: parseSnapshot(snapshot, path), mtimeMs: snapshot.mtimeMs, hash: snapshot.hash };
}

/**
 * Serializes a document with a fixed key order so identical content always produces identical text.
 * Known keys come first in contract order; unknown keys follow alphabetically.
 *
 * @param {JourneysDoc} doc A validated document.
 * @returns {string} 2-space-indented JSON ending with a newline.
 */
export function stableStringify(doc) {
  const orderedDoc = orderKeys(doc, DOC_KEYS, {
    apps: (apps) => apps.map((app) => orderKeys(app, APP_KEYS)),
    areas: (areas) => areas.map((area) => orderKeys(area, AREA_KEYS)),
    journeys: (journeys) => journeys.map(orderJourney),
  });
  return `${JSON.stringify(orderedDoc, null, 2)}\n`;
}

export { canonicalJson };

/**
 * Returns the screens a journey passes through.
 *
 * @param {Journey} journey A journey.
 * @returns {Set<string>} The non-null `screen` values of its steps.
 */
export function screensOf(journey) {
  return new Set(journey.steps.map((step) => step.screen).filter((screen) => screen !== null));
}

/**
 * The ids of the steps a step leads to, whichever shape `next` is written in (an id, or `{ to, when }`).
 *
 * @param {{ next?: Array<string | { to: string }> }} step A step.
 * @returns {string[]} Target step ids in order (entries that name no target are skipped).
 */
export function nextIds(step) {
  return nextEdges(step).map((edge) => edge.to);
}

/**
 * A step's outgoing arrows in one shape: `{ to, when? }`, whether they were written as ids or as pairs.
 *
 * @param {{ next?: Array<string | { to: string, when?: string }> }} step A step.
 * @returns {Array<{ to: string, when?: string }>} The arrows in order; `when` is present only when there is a condition.
 */
export function nextEdges(step) {
  const edges = [];
  for (const entry of Array.isArray(step?.next) ? step.next : []) {
    const to = typeof entry === 'string' ? entry : entry?.to;
    if (typeof to !== 'string') continue;
    edges.push(typeof entry?.when === 'string' && entry.when !== '' ? { to, when: entry.when } : { to });
  }
  return edges;
}

/**
 * Cuts text to `max` characters including a closing "…", at a word boundary when there is one.
 *
 * @param {string} text Text without control characters.
 * @param {number} max Longest allowed result.
 * @returns {string} The text itself when it fits.
 */
export function shortenText(text, max) {
  if (text.length <= max) return text;
  const room = max - 1;
  let cut = text.slice(0, room);
  if (text[room] !== ' ' && cut.includes(' ')) cut = cut.slice(0, cut.lastIndexOf(' '));
  const lastUnit = cut.charCodeAt(cut.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut.replace(/[\s,;:.\-–—]+$/, '')}…`;
}

/**
 * Fills in the optional parts of a plan so callers never check for undefined.
 *
 * @param {Partial<Plan>} plan A plan, possibly missing `upsert`, `remove` or `touches`.
 * @returns {{ summary: string, upsert: Journey[], remove: string[], touches: string[] }} The plan with all lists present.
 */
export function normalizePlan(plan) {
  return {
    summary: plan?.summary ?? '',
    upsert: plan?.upsert ?? [],
    remove: plan?.remove ?? [],
    touches: plan?.touches ?? [],
  };
}

/**
 * Applies a plan without touching the inputs: removes `plan.remove` first, then upserts `plan.upsert`
 * by id (replacing in place, otherwise appending).
 *
 * @param {JourneysDoc} doc The current document.
 * @param {Plan} plan The plan to apply.
 * @returns {JourneysDoc} A new document.
 */
export function applyPlan(doc, plan) {
  const { upsert, remove } = normalizePlan(plan);
  const removed = new Set(remove);
  const next = structuredClone(doc);
  next.journeys = next.journeys.filter((journey) => !removed.has(journey.id));
  for (const incoming of upsert) {
    const journey = structuredClone(incoming);
    const index = next.journeys.findIndex((existing) => existing.id === journey.id);
    if (index === -1) next.journeys.push(journey);
    else next.journeys[index] = journey;
  }
  return next;
}

/**
 * Applies a plan to the file on disk without losing a concurrent writer's work.
 * Reads the file, applies and validates the plan, re-checks the file just before writing and, if it
 * changed meanwhile, re-applies on the newer content. The write itself is atomic (temp file + rename).
 *
 * @param {string} path Path to journeys.json (must already exist).
 * @param {Plan} plan The plan to apply.
 * @param {object} [options]
 * @param {JourneysDoc} [options.lastDoc] What this chat last saw. Journeys in the plan whose on-disk version
 *   differs from it were changed by someone else; with no `lastDoc`, nothing is considered known.
 * @param {() => void} [options._beforeWrite] Test hook, called once between applying and the final check.
 * @returns {{ doc: JourneysDoc, twoChats: string[] }} The saved document and the ids of journeys another chat changed.
 * @throws {ModelError} When the file cannot be read, the result would be invalid, the file keeps changing, or the write fails.
 */
export function savePlanApplied(path, plan, { lastDoc, _beforeWrite } = {}) {
  let snapshot = readSnapshot(path);
  for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt += 1) {
    const current = parseSnapshot(snapshot, path);
    const twoChats = findTwoChats(current, lastDoc, plan);
    const next = validateApplied(current, plan);
    if (attempt === 1 && _beforeWrite) _beforeWrite();
    const latest = readSnapshot(path);
    if (latest.mtimeMs === snapshot.mtimeMs && latest.hash === snapshot.hash) {
      writeAtomically(path, stableStringify(next));
      return { doc: next, twoChats };
    }
    snapshot = latest;
  }
  throw new ModelError('The journey map keeps being changed by another chat, so I could not save safely. Please try again in a moment.');
}

/** Finds the plan's journeys that another chat changed since `lastDoc`. */
function findTwoChats(onDisk, lastDoc, plan) {
  const diskById = new Map(onDisk.journeys.map((journey) => [journey.id, journey]));
  const knownById = new Map((lastDoc?.journeys ?? []).map((journey) => [journey.id, journey]));
  const ids = normalizePlan(plan).upsert.map((journey) => journey.id);
  return [...new Set(ids)].filter((id) => {
    const onDiskVersion = diskById.get(id);
    const knownVersion = knownById.get(id);
    if (!onDiskVersion && !knownVersion) return false;
    return canonicalJson(onDiskVersion) !== canonicalJson(knownVersion);
  });
}

/** Applies the plan and returns the validated result. */
function validateApplied(current, plan) {
  const result = validateDoc(applyPlan(current, plan));
  if (!result.ok) throw problemsError('That change would leave the journey map with problems, so nothing was saved:', result.errors);
  return result.doc;
}

/** Reads the file together with the mtime and hash used to detect concurrent edits. The mtime is read first so a write landing in between is noticed as a change, never missed. */
function readSnapshot(path) {
  try {
    const { mtimeMs } = statSync(path);
    const raw = readFileSync(path, 'utf8');
    return { raw, mtimeMs, hash: sha1(raw) };
  } catch (error) {
    if (error.code === 'ENOENT') throw new ModelError(`I can't find the journey map at ${path}. It may not have been set up yet.`);
    throw new ModelError(`I couldn't read the journey map at ${path}: ${error.message}`);
  }
}

/** Parses and validates a snapshot's text. */
function parseSnapshot({ raw }, path) {
  if (raw.trim() === '') throw new ModelError(`The journey map at ${path} is empty.`);
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new ModelError(`The journey map at ${path} is not valid JSON. ${describeJsonError(error, raw)}`);
  }
  const result = validateDoc(parsed);
  if (!result.ok) throw problemsError(`The journey map at ${path} has problems:`, result.errors);
  return result.doc;
}

/** Explains where a JSON parse failed. */
function describeJsonError(error, raw) {
  const match = /\bposition (\d+)/.exec(error.message);
  if (match) {
    const reason = error.message.replace(/\s+at position \d+.*$/, '');
    return `The problem is at ${locate(raw, Number(match[1]))}: ${reason}.`;
  }
  if (/end of JSON input/i.test(error.message)) {
    return `The file ends too early, at ${locate(raw, raw.length)}.`;
  }
  return `${error.message}.`;
}

/** Converts a character offset into a human-readable place. */
function locate(raw, position) {
  const before = raw.slice(0, position);
  const line = before.split('\n').length;
  const column = position - before.lastIndexOf('\n');
  return `line ${line}, column ${column} (character ${position})`;
}

/** Builds a ModelError that lists several problems. */
function problemsError(header, errors) {
  return new ModelError(`${header}\n- ${errors.join('\n- ')}`, errors);
}

/** Writes a file atomically: temp file in the same folder, then rename. */
function writeAtomically(path, text) {
  try {
    writeTextAtomic(path, text);
  } catch (error) {
    throw new ModelError(`I couldn't save the journey map to ${path}: ${error.message}`);
  }
}

/** Puts a journey, and its steps, in contract key order. */
function orderJourney(journey) {
  return orderKeys(journey, JOURNEY_KEYS, {
    steps: (steps) => steps.map(orderStep),
  });
}

/** Puts a step, and its anchor and detail, in contract key order. */
function orderStep(step) {
  return orderKeys(step, STEP_KEYS, {
    anchor: (anchor) => orderKeys(anchor, ANCHOR_KEYS),
    detail: (detail) => orderKeys(detail, DETAIL_KEYS),
  });
}

/** Copies an object with `knownKeys` first (in the given order) and any other keys after, alphabetically. */
function orderKeys(object, knownKeys, transforms = {}) {
  const ordered = {};
  for (const key of knownKeys) {
    if (object[key] === undefined) continue;
    ordered[key] = transforms[key] ? transforms[key](object[key]) : sortKeysDeep(object[key]);
  }
  const unknownKeys = Object.keys(object).filter((key) => !knownKeys.includes(key)).sort();
  for (const key of unknownKeys) {
    if (object[key] !== undefined) ordered[key] = sortKeysDeep(object[key]);
  }
  return ordered;
}

/** True for a non-null, non-array object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON round-trip copy, or undefined when the value is not plain JSON. */
function cloneJson(doc) {
  try {
    return JSON.parse(JSON.stringify(doc));
  } catch {
    return undefined;
  }
}

/** Short quoted form of a value for error messages. */
function quote(value) {
  const text = String(value).replace(CONTROL_CHARS, '');
  return `"${text.length > 40 ? `${text.slice(0, 40)}...` : text}"`;
}

/** Sanitizes a text field in place. */
function cleanText(object, key, label, errors, required) {
  if (object[key] === undefined) {
    if (required) errors.push(`${label} needs a "${key}" written in quotes.`);
    return;
  }
  if (typeof object[key] !== 'string') {
    errors.push(`${label}: "${key}" must be text.`);
    return;
  }
  object[key] = sanitizeText(object[key]);
}

/** Cleans a short optional text (`label`, `trigger`): control characters out, blank dropped, over-long ones cut at a word boundary with "…". */
function cleanShort(object, key, max, label, errors) {
  if (object[key] === undefined) return;
  if (typeof object[key] !== 'string') {
    errors.push(`${label}: "${key}" must be text.`);
    return;
  }
  const text = sanitizeText(object[key]).replace(/\s+/g, ' ');
  if (text === '') delete object[key];
  else object[key] = shortenText(text, max);
}

/** Sanitizes a list of strings in place, dropping blanks and capping the length. */
function cleanTextList(object, key, label, errors) {
  if (object[key] === undefined) return;
  if (!Array.isArray(object[key])) {
    errors.push(`${label}: "${key}" must be a list.`);
    return;
  }
  object[key] = object[key].map(sanitizeText).filter((item) => item !== '').slice(0, MAX_DETAIL_ITEMS);
}

/** True for a non-empty string. */
function isNonEmptyString(id) {
  return typeof id === 'string' && id !== '';
}

/** Checks the optional `apps` list (unique ids, a kind from APP_KINDS, a safe repo-relative root) and cleans it in place. */
function checkApps(doc, errors) {
  if (doc.apps === undefined) return null;
  if (!Array.isArray(doc.apps)) {
    errors.push('"apps" must be a list.');
    return null;
  }
  const ids = new Set();
  for (const app of doc.apps) {
    if (!isPlainObject(app) || !isNonEmptyString(app.id)) {
      errors.push('Every app needs an "id".');
      continue;
    }
    const label = `App ${quote(app.id)}`;
    const idProblem = idFormatProblem(app.id, 'app');
    if (idProblem) errors.push(idProblem);
    if (ids.has(app.id)) errors.push(`${label} appears more than once.`);
    ids.add(app.id);
    cleanText(app, 'title', label, errors, true);
    if (!APP_KINDS.includes(app.kind)) errors.push(`${label}: "kind" must be one of ${APP_KINDS.map((kind) => `"${kind}"`).join(', ')}.`);
    checkAppRoot(app, label, errors);
  }
  return ids;
}

/** Checks an app's `root` (a folder inside the project, "." for the whole project) and writes it with forward slashes and no trailing slash. */
function checkAppRoot(app, label, errors) {
  if (!isNonEmptyString(app.root)) {
    errors.push(`${label} needs a "root": the folder it lives in, like "packages/desktop" ("." for the whole project).`);
    return;
  }
  app.root = app.root.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/(?<=.)\/+$/, '') || '.';
  const problem = filePathProblem(app.root);
  if (problem) errors.push(`${label}: the root ${quote(app.root)} ${problem.replace('must be relative to the project folder, not a full path', 'must be a folder inside the project, not a full path')}.`);
}

/** Checks a journey's optional `apps`: ids of apps listed in the document's `apps` (when it has any); duplicates are dropped and an empty list is removed. */
function checkJourneyApps(journey, appIds, label, errors) {
  if (journey.apps === undefined) return;
  if (!Array.isArray(journey.apps) || journey.apps.some((id) => !isNonEmptyString(id))) {
    errors.push(`${label}: "apps" must be a list of app ids.`);
    return;
  }
  journey.apps = [...new Set(journey.apps)];
  if (appIds) {
    for (const id of journey.apps.filter((candidate) => !appIds.has(candidate))) errors.push(`${label} happens in app ${quote(id)}, which is not listed in "apps".`);
  }
  if (journey.apps.length === 0) delete journey.apps;
}

/** Checks the optional `areas` list and cleans it in place. */
function checkAreas(doc, errors) {
  if (doc.areas === undefined) return null;
  if (!Array.isArray(doc.areas)) {
    errors.push('"areas" must be a list.');
    return null;
  }
  const ids = new Set();
  for (const area of doc.areas) {
    if (!isPlainObject(area) || !isNonEmptyString(area.id)) {
      errors.push('Every area needs an "id".');
      continue;
    }
    const label = `Area ${quote(area.id)}`;
    const idProblem = idFormatProblem(area.id, 'area');
    if (idProblem) errors.push(idProblem);
    if (ids.has(area.id)) errors.push(`${label} appears more than once.`);
    ids.add(area.id);
    cleanText(area, 'title', label, errors, true);
    cleanText(area, 'say', label, errors, false);
  }
  checkAreaParents(doc.areas, ids, errors);
  return ids;
}

/** Checks each area's optional `parent`: an existing other area, no circles, at most MAX_AREA_DEPTH levels. */
function checkAreaParents(areas, ids, errors) {
  const parentOf = new Map();
  for (const area of areas) {
    if (!isPlainObject(area) || !isNonEmptyString(area.id) || area.parent === undefined) continue;
    const label = `Area ${quote(area.id)}`;
    if (!isNonEmptyString(area.parent)) errors.push(`${label}: "parent" must be the id of the area it sits inside.`);
    else if (area.parent === area.id) errors.push(`${label} cannot sit inside itself.`);
    else if (!ids.has(area.parent)) errors.push(`${label} sits inside area ${quote(area.parent)}, which is not listed in "areas".`);
    else parentOf.set(area.id, area.parent);
  }
  const reported = new Set();
  for (const id of parentOf.keys()) {
    const chain = [id];
    while (parentOf.has(chain.at(-1)) && !chain.includes(parentOf.get(chain.at(-1)))) chain.push(parentOf.get(chain.at(-1)));
    const next = parentOf.get(chain.at(-1));
    if (next !== undefined) {
      const loop = chain.slice(chain.indexOf(next));
      const key = [...loop].sort().join();
      if (!reported.has(key)) errors.push(`Areas sit inside each other in a circle: ${[...loop, next].map(quote).join(' -> ')}.`);
      reported.add(key);
    } else if (chain.length > MAX_AREA_DEPTH) {
      errors.push(`Area ${quote(id)} is nested ${chain.length} levels deep; areas can be at most ${MAX_AREA_DEPTH} levels deep.`);
    }
  }
}

/** Checks journey ids: present, short enough, unique. */
function checkJourneyIds(journeys, errors) {
  const ids = new Set();
  for (const journey of journeys) {
    if (!isPlainObject(journey)) {
      errors.push('Every entry in "journeys" must be an object.');
    } else if (!isNonEmptyString(journey.id)) {
      errors.push('Every journey needs an "id".');
    } else {
      const idProblem = idFormatProblem(journey.id, 'journey');
      if (idProblem) errors.push(idProblem);
      if (ids.has(journey.id)) errors.push(`Journey id ${quote(journey.id)} is used more than once.`);
      ids.add(journey.id);
    }
  }
  return ids;
}

/** Why an id (a non-empty string) is not allowed, or null when it is fine. */
function idFormatProblem(id, noun) {
  if (id.length > MAX_ID_LENGTH) return `The ${noun} id ${quote(id)} is longer than ${MAX_ID_LENGTH} characters.`;
  if (!ID_PATTERN.test(id)) {
    return `The ${noun} id ${quote(id)} can only use letters, numbers, "-" and "_", and must start with a letter or number.`;
  }
  return null;
}

/** Checks one journey and cleans it in place. */
function checkJourney(journey, context, errors) {
  const label = `Journey ${quote(journey.id)}`;
  cleanText(journey, 'title', label, errors, true);
  cleanText(journey, 'who', label, errors, false);
  checkArea(journey, context.areaIds, label, errors);
  checkJourneyApps(journey, context.appIds, label, errors);
  if (!Array.isArray(journey.steps)) {
    errors.push(`${label} needs a "steps" list.`);
    return;
  }
  const stepIds = checkStepIds(journey.steps, label, errors);
  for (const step of journey.steps.filter(isPlainObject)) {
    checkStep(step, { journey, stepIds, journeyIds: context.journeyIds }, `${label}, step ${quote(step.id)}`, errors);
  }
}

/** Checks that a journey's area is listed in `areas` (when `areas` exists). */
function checkArea(journey, areaIds, label, errors) {
  if (journey.area === undefined) return;
  if (!isNonEmptyString(journey.area)) {
    errors.push(`${label}: "area" must be the id of an area.`);
  } else if (areaIds && !areaIds.has(journey.area)) {
    errors.push(`${label} is in area ${quote(journey.area)}, which is not listed in "areas".`);
  }
}

/** Checks step ids within one journey: present and unique. */
function checkStepIds(steps, label, errors) {
  const ids = new Set();
  for (const step of steps) {
    if (!isPlainObject(step)) {
      errors.push(`${label}: every step must be an object.`);
    } else if (!isNonEmptyString(step.id)) {
      errors.push(`${label} has a step without an "id".`);
    } else {
      const idProblem = idFormatProblem(step.id, 'step');
      if (idProblem) errors.push(`${label}: ${idProblem}`);
      if (ids.has(step.id)) errors.push(`${label} uses step id ${quote(step.id)} more than once.`);
      ids.add(step.id);
    }
  }
  return ids;
}

/** Checks one step and cleans it in place. */
function checkStep(step, context, label, errors) {
  cleanShort(step, 'label', LIMITS.LABEL, label, errors);
  cleanText(step, 'say', label, errors, true);
  checkKind(step, label, errors);
  cleanShort(step, 'trigger', MAX_TRIGGER, label, errors);
  checkScreen(step, label, errors);
  checkAnchor(step, label, errors);
  checkNext(step, context.stepIds, label, errors);
  checkContinues(step, context, label, errors);
  checkDetail(step, label, errors);
  checkSubflow(step, context, label, errors);
}

/** Checks `screen`; a missing screen becomes null. */
function checkScreen(step, label, errors) {
  if (step.screen === undefined) step.screen = null;
  const isPath = typeof step.screen === 'string' && step.screen.startsWith('/') && !/[\u0000-\u001F\u007F]/.test(step.screen);
  if (step.screen !== null && !isPath) {
    errors.push(`${label}: "screen" must be null or a page address starting with "/", like "/checkout".`);
  }
}

/** Checks the anchor and normalizes file paths to forward slashes in place. */
function checkAnchor(step, label, errors) {
  const anchor = step.anchor;
  if (!isPlainObject(anchor)) {
    errors.push(`${label} needs an "anchor" saying where it lives in the code.`);
  } else if (anchor.type !== 'file' && anchor.type !== 'route') {
    errors.push(`${label}: the anchor "type" must be "file" or "route".`);
  } else if (!isNonEmptyString(anchor.value) || HAS_CONTROL_CHAR.test(anchor.value)) {
    errors.push(`${label}: the anchor needs a plain-text "value".`);
  } else if (anchor.type === 'route') {
    if (!anchor.value.startsWith('/')) errors.push(`${label}: a route anchor must start with "/", like "/checkout".`);
  } else {
    anchor.value = anchor.value.replace(/\\/g, '/');
    const problem = filePathProblem(anchor.value);
    if (problem) errors.push(`${label}: the file anchor ${quote(anchor.value)} ${problem}.`);
  }
}

/** Why a file path cannot be used as an anchor, or null when it is fine. */
function filePathProblem(path) {
  if (HAS_CONTROL_CHAR.test(path)) return 'contains hidden characters';
  if (path.startsWith('/') || WINDOWS_DRIVE.test(path)) return 'must be relative to the project folder, not a full path';
  if (path.split('/').includes('..')) return 'must stay inside the project folder (no "..")';
  return null;
}

/** Checks `kind` (action, decision, outcome or background) and `result` (outcomes only). */
function checkKind(step, label, errors) {
  if (step.kind !== undefined && !STEP_KINDS.includes(step.kind)) {
    errors.push(`${label}: "kind" must be one of ${STEP_KINDS.map((kind) => `"${kind}"`).join(', ')}.`);
  }
  if (step.result === undefined) return;
  if (!STEP_RESULTS.includes(step.result)) errors.push(`${label}: "result" must be one of ${STEP_RESULTS.map((result) => `"${result}"`).join(', ')}.`);
  else if (step.kind !== 'outcome') errors.push(`${label}: only an outcome step ("kind": "outcome") can have a "result".`);
}

/** Checks `next`: a list of step ids and/or { to, when } pairs naming steps of this journey. A bare id stays an id; repeated targets are dropped. */
function checkNext(step, stepIds, label, errors) {
  if (step.next === undefined) step.next = [];
  if (!Array.isArray(step.next)) {
    errors.push(`${label}: "next" must be a list of step ids, or of { "to": step id, "when": condition } pairs.`);
    return;
  }
  const seen = new Set();
  const cleaned = [];
  for (const entry of step.next) {
    const to = typeof entry === 'string' ? entry : isPlainObject(entry) ? entry.to : undefined;
    if (!isNonEmptyString(to)) {
      errors.push(`${label}: every entry in "next" must be a step id or a { "to": step id, "when": condition } pair.`);
      continue;
    }
    if (!stepIds.has(to)) errors.push(`${label} leads to step ${quote(to)}, which does not exist in this journey.`);
    if (seen.has(to)) continue;
    seen.add(to);
    cleaned.push(typeof entry === 'string' ? entry : cleanArrow(entry, label, errors));
  }
  step.next = cleaned;
}

/** Cleans a { to, when } arrow: only those two keys survive, and `when` is a short condition in plain words. */
function cleanArrow(entry, label, errors) {
  const arrow = { to: entry.to };
  if (entry.when !== undefined) cleanShort(entry, 'when', MAX_WHEN, `${label}, arrow to ${quote(entry.to)}`, errors);
  if (entry.when !== undefined) arrow.when = entry.when;
  return arrow;
}

/** Checks that `continues` names another existing journey. */
function checkContinues(step, { journey, journeyIds }, label, errors) {
  if (step.continues === undefined) return;
  if (!isNonEmptyString(step.continues)) errors.push(`${label}: "continues" must be the id of the journey this step hands over to.`);
  else if (step.continues === journey.id) errors.push(`${label} cannot continue into its own journey.`);
  else if (!journeyIds.has(step.continues)) errors.push(`${label} continues in journey ${quote(step.continues)}, which does not exist.`);
}

/** Checks the step detail and sanitizes its text in place. */
function checkDetail(step, label, errors) {
  if (step.detail === undefined) return;
  if (!isPlainObject(step.detail)) {
    errors.push(`${label}: "detail" must be an object.`);
    return;
  }
  const detailLabel = `${label} detail`;
  for (const key of ['sees', 'does']) cleanText(step.detail, key, detailLabel, errors, false);
  for (const key of ['rules', 'saves']) cleanTextList(step.detail, key, detailLabel, errors);
  cleanFileList(step.detail, detailLabel, errors);
}

/** Checks `detail.files` entries with the same rules as file anchors; blanks are dropped and the list is capped. */
function cleanFileList(detail, label, errors) {
  if (detail.files === undefined) return;
  if (!Array.isArray(detail.files)) {
    errors.push(`${label}: "files" must be a list.`);
    return;
  }
  const kept = [];
  for (const entry of detail.files) {
    if (typeof entry !== 'string') {
      errors.push(`${label}: every entry in "files" must be text.`);
      continue;
    }
    const path = entry.replace(/\\/g, '/').replace(/^ +| +$/g, '');
    if (path === '') continue;
    const problem = filePathProblem(path);
    if (problem) errors.push(`${label}: the file ${quote(path)} ${problem}.`);
    else kept.push(path);
  }
  detail.files = kept.slice(0, MAX_DETAIL_ITEMS);
}

/** Checks that `subflow` names another existing journey. */
function checkSubflow(step, { journey, journeyIds }, label, errors) {
  if (step.subflow === undefined) return;
  if (step.subflow === journey.id) {
    errors.push(`${label} cannot zoom into its own journey.`);
  } else if (!journeyIds.has(step.subflow)) {
    errors.push(`${label} zooms into journey ${quote(step.subflow)}, which does not exist.`);
  }
}

/** Reports journeys that zoom into each other in a circle (A's step zooms into B, B's into A). */
function checkSubflowCycles(journeys, errors) {
  const edges = new Map();
  for (const journey of journeys.filter(isPlainObject)) {
    if (isNonEmptyString(journey.id)) edges.set(journey.id, subflowTargets(journey));
  }
  const visiting = [];
  const done = new Set();
  const visit = (id) => {
    visiting.push(id);
    for (const target of edges.get(id)) {
      if (!edges.has(target)) continue;
      if (visiting.includes(target)) {
        const loop = [...visiting.slice(visiting.indexOf(target)), target].map(quote).join(' -> ');
        errors.push(`Journeys zoom into each other in a circle: ${loop}.`);
      } else if (!done.has(target)) {
        visit(target);
      }
    }
    visiting.pop();
    done.add(id);
  };
  for (const id of edges.keys()) {
    if (!done.has(id)) visit(id);
  }
}

/** Ids of other journeys a journey's steps zoom into. */
function subflowTargets(journey) {
  const steps = Array.isArray(journey.steps) ? journey.steps.filter(isPlainObject) : [];
  const targets = steps.map((step) => step.subflow).filter((target) => isNonEmptyString(target) && target !== journey.id);
  return [...new Set(targets)];
}
