/**
 * Comparing journeys documents: what changed between two versions, and which journeys
 * a plan would collide with.
 */

import { applyPlan, canonicalJson, normalizePlan } from './model.mjs';
import { DEFAULT_CONFIG, ROLLUP_ORDER } from './types.mjs';

/** @typedef {import('./types.mjs').JourneysDoc} JourneysDoc */
/** @typedef {import('./types.mjs').Journey} Journey */
/** @typedef {import('./types.mjs').Step} Step */
/** @typedef {import('./types.mjs').Plan} Plan */
/** @typedef {import('./types.mjs').Config} Config */
/** @typedef {import('./types.mjs').Conflict} Conflict */
/** @typedef {import('./types.mjs').DiffResult} DiffResult */
/** @typedef {import('./types.mjs').ChangeState} ChangeState */
/** @typedef {import('./types.mjs').Rollup} Rollup */

/**
 * Compares two versions of the document.
 * Steps of a new (or removed) journey are marked new (or removed) too. Steps removed from a journey that
 * still exists are also listed in `removedSteps`; steps of a removed journey are not.
 *
 * @param {JourneysDoc|null|undefined} base The earlier version; null or undefined means "nothing changed".
 * @param {JourneysDoc} current The later version.
 * @returns {DiffResult} States by "j:<journeyId>" and "s:<journeyId>/<stepId>" (stable keys omitted) plus the removed items.
 */
export function diffDocs(base, current) {
  /** @type {DiffResult} */
  const result = { states: {}, removedJourneys: [], removedSteps: [] };
  if (!base) return result;

  const baseById = indexById(base.journeys);
  const currentIds = new Set(current.journeys.map((journey) => journey.id));
  for (const journey of current.journeys) {
    diffJourney(baseById.get(journey.id), journey, result);
  }
  for (const journey of base.journeys.filter((entry) => !currentIds.has(entry.id))) {
    result.removedJourneys.push(journey);
    result.states[journeyKey(journey.id)] = 'removed';
    for (const step of journey.steps) result.states[stepKey(journey.id, step.id)] = 'removed';
  }
  return result;
}

/**
 * Lists the keys a plan would touch: every new, changed or removed journey and step.
 *
 * @param {JourneysDoc} doc The document before the plan.
 * @param {Plan} plan The pending plan.
 * @returns {Set<string>} "j:" and "s:" keys, for the ghost overlay.
 */
export function planKeys(doc, plan) {
  const { states, removedJourneys, removedSteps } = diffDocs(doc, applyPlan(doc, plan));
  const keys = new Set(Object.keys(states).filter((key) => states[key] !== 'stable'));
  for (const journey of removedJourneys) keys.add(journeyKey(journey.id));
  for (const { journeyId, step } of removedSteps) keys.add(stepKey(journeyId, step.id));
  return keys;
}

/**
 * Finds where a plan collides with journeys that are not part of it. A plan collides when it adds, changes
 * or removes a step on a screen another journey also uses, or lists such a screen in `touches`.
 * Adding a step on a shared screen (config.shared) never collides; changing or removing one does.
 *
 * @param {JourneysDoc} doc The current document.
 * @param {Plan} plan The pending plan.
 * @param {Config} config Project config; only `shared` is read.
 * @returns {Conflict[]} Conflicts without duplicates, sorted by screen, then plan journey, then kind.
 */
export function findConflicts(doc, plan, config) {
  const { upsert, remove, touches } = normalizePlan(plan);
  const shared = new Set(config?.shared ?? DEFAULT_CONFIG.shared);
  const upsertIds = new Set(upsert.map((journey) => journey.id));
  const outsiders = doc.journeys.filter((journey) => !upsertIds.has(journey.id) && !remove.includes(journey.id));

  /** @type {Map<string, Conflict>} */
  const found = new Map();
  const report = (screen, planJourney, kind) => {
    const exemptOnSharedScreen = kind === 'add' || kind === 'touches';
    if (screen === null || (exemptOnSharedScreen && shared.has(screen))) return;
    const otherJourneys = outsiders.filter((journey) => journey.steps.some((step) => step.screen === screen)).map((journey) => journey.id);
    if (otherJourneys.length === 0) return;
    const key = [screen, planJourney, kind].join('\u0000');
    if (!found.has(key)) found.set(key, { screen, planJourney, otherJourneys, kind });
  };

  const currentById = indexById(doc.journeys);
  for (const journey of upsert) {
    for (const { kind, screens } of stepEdits(currentById.get(journey.id), journey)) {
      for (const screen of screens) report(screen, journey.id, kind);
    }
  }
  for (const journey of doc.journeys.filter((entry) => remove.includes(entry.id) && !upsertIds.has(entry.id))) {
    for (const step of journey.steps) report(step.screen, journey.id, 'remove');
  }
  const touchOwner = upsert.length > 0 ? upsert[0].id : '';
  for (const screen of touches) report(screen, touchOwner, 'touches');

  return [...found.values()].sort(compareConflicts);
}

/**
 * Decides whether the builder must approve a plan before it is built.
 *
 * @param {Plan} plan The pending plan.
 * @param {Conflict[]} conflicts The plan's conflicts from findConflicts.
 * @returns {boolean} True when there are conflicts or the plan touches more than one journey.
 */
export function needsApproval(plan, conflicts) {
  const { upsert, remove } = normalizePlan(plan);
  return conflicts.length > 0 || upsert.length + remove.length > 1;
}

/**
 * Picks the strongest state according to ROLLUP_ORDER.
 *
 * @param {Rollup[]} list States to combine.
 * @returns {Rollup} The strongest one, or 'stable' for an empty list.
 */
export function strongestRollup(list) {
  return ROLLUP_ORDER.find((rollup) => list.includes(rollup)) ?? 'stable';
}

/** Records the state of one journey (and its steps) that exists in `current`. */
function diffJourney(before, after, result) {
  if (!before) {
    result.states[journeyKey(after.id)] = 'new';
    for (const step of after.steps) result.states[stepKey(after.id, step.id)] = 'new';
    return;
  }
  const beforeSteps = indexById(before.steps);
  const afterIds = new Set(after.steps.map((step) => step.id));
  let stepsChanged = false;
  for (const step of after.steps) {
    const old = beforeSteps.get(step.id);
    const state = !old ? 'new' : stepChanged(old, step) ? 'changed' : 'stable';
    if (state === 'stable') continue;
    result.states[stepKey(after.id, step.id)] = state;
    stepsChanged = true;
  }
  for (const step of before.steps.filter((entry) => !afterIds.has(entry.id))) {
    result.states[stepKey(after.id, step.id)] = 'removed';
    result.removedSteps.push({ journeyId: after.id, step });
    stepsChanged = true;
  }
  if (stepsChanged || journeyMeta(before) !== journeyMeta(after)) {
    result.states[journeyKey(after.id)] = 'changed';
  }
}

/** Lists how a plan journey edits the steps of its current version. */
function stepEdits(before, after) {
  const beforeSteps = indexById(before?.steps ?? []);
  const afterIds = new Set(after.steps.map((step) => step.id));
  const edits = [];
  for (const step of after.steps) {
    const old = beforeSteps.get(step.id);
    if (!old) edits.push({ kind: 'add', screens: [step.screen] });
    else if (stepChanged(old, step)) edits.push({ kind: 'change', screens: [old.screen, step.screen] });
  }
  for (const step of (before?.steps ?? []).filter((entry) => !afterIds.has(entry.id))) {
    edits.push({ kind: 'remove', screens: [step.screen] });
  }
  return edits;
}

/** True when say, screen, anchor, next, detail or subflow differ. */
function stepChanged(a, b) {
  return stepFingerprint(a) !== stepFingerprint(b);
}

/** Canonical JSON of the fields that make a step "changed". */
function stepFingerprint({ say, screen, anchor, next, detail, subflow }) {
  return canonicalJson({ say, screen, anchor, next, detail, subflow });
}

/** Canonical JSON of the non-step fields that make a journey "changed". */
function journeyMeta({ title, area, who }) {
  return canonicalJson({ title, area, who });
}

/** Items by id. */
function indexById(items) {
  return new Map(items.map((item) => [item.id, item]));
}

/** The "j:" key of a journey. */
function journeyKey(journeyId) {
  return `j:${journeyId}`;
}

/** The "s:" key of a step. */
function stepKey(journeyId, stepId) {
  return `s:${journeyId}/${stepId}`;
}

/** Orders conflicts by screen, then plan journey, then kind (plain string comparison, so no locale effects). */
function compareConflicts(a, b) {
  for (const field of ['screen', 'planJourney', 'kind']) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  return 0;
}
