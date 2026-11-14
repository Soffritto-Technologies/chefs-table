/**
 * Things the builder should hear about without asking: a plan waiting for their OK, a clash, a step
 * built without approval or edited in two chats, a step that no longer matches the code, a serious
 * health finding, a journey added or removed. Each has a stable key so it is reported once.
 */

import { sanitizeText } from './model.mjs';
import { FLAGS } from './types.mjs';

const MAX_LISTED = 3;

/**
 * Plain-language name of a journey or step key in a document.
 *
 * @param {object} doc - Journeys document.
 * @param {string} key - "j:<id>" or "s:<journeyId>/<stepId>".
 * @returns {string} The title or label, or the id when it is not in the document.
 */
function nameOf(doc, key) {
  const [journeyId, stepId] = key.slice(2).split('/');
  const journey = doc.journeys.find((j) => j.id === journeyId);
  if (!stepId) return sanitizeText(journey?.title || journeyId);
  const step = journey?.steps.find((s) => s.id === stepId);
  return sanitizeText(step?.label || step?.say || stepId);
}

/**
 * Whether a step key names a step of the saved document (planned steps are not).
 *
 * @param {object} doc - Journeys document.
 * @param {string} key - "s:<journeyId>/<stepId>".
 * @returns {boolean} True when the step exists.
 */
function inDoc(doc, key) {
  const [journeyId, stepId] = key.slice(2).split('/');
  return doc.journeys.some((j) => j.id === journeyId && j.steps.some((s) => s.id === stepId));
}

/**
 * Lists everything important in the current state of a chat.
 *
 * @param {object} input - The state to read.
 * @param {object} input.doc - Saved journeys document.
 * @param {object} input.viewDoc - Document with the pending plan applied (equals doc when none).
 * @param {{ plan: { summary?: string }, planHash: string, conflicts: object[], state: string } | null} input.status - Plan status, or null without a plan.
 * @param {Record<string, string[]>} input.flags - FLAGS by "j:"/"s:" key.
 * @param {Record<string, string>} input.anchors - Anchor results by step key.
 * @param {Array<{ id: string, severity: string, message: string }>} input.findings - Stored health findings.
 * @param {{ states: Record<string, string>, removedJourneys?: object[] }} input.saved - diffDocs(last saved map, saved map).
 * @returns {Array<{ key: string, line: string }>} Items with stable keys and one-line descriptions.
 */
export function collectNotable({ doc, viewDoc, status, flags, anchors, findings, saved }) {
  const items = [];
  if (status?.state === 'pending') {
    items.push({ key: `plan:${status.planHash}`, line: `A plan is waiting for your OK: ${sanitizeText(status.plan.summary || 'unnamed change')}` });
  }
  for (const c of status?.conflicts || []) {
    const others = c.otherJourneys.map((id) => `"${nameOf(viewDoc, `j:${id}`)}"`).join(', ');
    items.push({ key: `conflict:${c.planJourney}:${c.screen}`, line: `"${nameOf(viewDoc, `j:${c.planJourney}`)}" clashes with ${others} on the ${sanitizeText(c.screen)} screen` });
  }
  for (const [key, list] of Object.entries(flags || {})) {
    if (list.includes(FLAGS.UNCONFIRMED)) items.push({ key: `unconfirmed:${key}`, line: `"${nameOf(doc, key)}" was built without your approval` });
    if (list.includes(FLAGS.TWO_CHATS)) items.push({ key: `two-chats:${key}`, line: `"${nameOf(doc, key)}" was edited in two chats` });
  }
  for (const [key, state] of Object.entries(anchors || {})) {
    if (state === 'broken' && inDoc(doc, key)) {
      items.push({ key: `broken:${key}`, line: `The step "${nameOf(doc, key)}" no longer matches the code` });
    }
  }
  for (const f of findings || []) {
    if (f.severity === 'high') items.push({ key: `finding:${f.id}`, line: sanitizeText(f.message) });
  }
  for (const [key, state] of Object.entries(saved?.states || {})) {
    if (!key.startsWith('j:') || (state !== 'new' && state !== 'removed')) continue;
    const gone = (saved.removedJourneys || []).find((j) => `j:${j.id}` === key);
    const title = state === 'removed' ? sanitizeText(gone?.title || key.slice(2)) : nameOf(doc, key);
    items.push({ key: `${state}:${key}`, line: `Journey "${title}" was ${state === 'new' ? 'added' : 'removed'}` });
  }
  return items;
}

/**
 * Splits items into those not reported before and the keys to remember (items still present).
 *
 * @param {Array<{ key: string }>} items - Current items.
 * @param {string[]} reported - Keys reported earlier in this chat.
 * @returns {{ fresh: Array<{ key: string, line: string }>, keys: string[] }} New items and the keys to store.
 */
export function splitFresh(items, reported) {
  const seen = new Set(reported);
  return { fresh: items.filter((i) => !seen.has(i.key)), keys: items.map((i) => i.key) };
}

/**
 * One-line chat notice for new important items.
 *
 * @param {Array<{ line: string }>} fresh - New items.
 * @param {string} viewPath - Path of this chat's map.
 * @returns {string} "Chef's Table: a · b · c and N more. Map: <path>".
 */
export function formatNotice(fresh, viewPath) {
  const listed = fresh.slice(0, MAX_LISTED).map((i) => i.line);
  const more = fresh.length - listed.length;
  return `Chef's Table: ${listed.join(' · ')}${more > 0 ? ` · and ${more} more` : ''}. Map: ${viewPath}`;
}
