/**
 * The order of the map at every level: which area, journey or step follows which. Pure functions over the map; no AI, no file access.
 * Areas and journeys carry `next` (like steps do); journeys are also linked by a step's `continues`.
 */
import { nextEdges } from './model.mjs';
import { OTHER_AREA_ID } from './types.mjs';

/** @typedef {import('./types.mjs').JourneysDoc} JourneysDoc */

const CONTINUES_WHEN = { failure: 'if it fails', abandoned: 'if they stop' };
const ANYTIME = /\b(settings|preferences|profile|account|help|support|privacy|security|notifications?|admin|faq|about|legal|terms)\b/i;
const START = /\b(sign(?:ing)? ?up|sign(?:ing)? ?in|log(?:ging)? ?in|register|onboard(?:ing)?|welcome|get(?:ting)? started|install|invite|join|first run|landing|create (?:an |your )?account)\b/i;
const PAY = /\b(billing|payments?|pay|pricing|plans?|subscription|checkout|upgrade|trial|invoices?)\b/i;

/**
 * Links between members of one kind (areas or journeys) written as `next`: only existing ids, no self-links, first link per from→to wins.
 *
 * @param {Array<{ id: string, next?: Array<string | { to: string, when?: string }> }>} owners - Areas or journeys, in document order.
 * @returns {Array<{ from: string, to: string, when: string }>} Links in document order.
 */
function nextLinks(owners) {
  const ids = new Set(owners.map((owner) => owner.id));
  const seen = new Set();
  const links = [];
  for (const owner of owners) {
    for (const { to, when } of nextEdges(owner)) {
      if (!ids.has(to) || to === owner.id || seen.has(`${owner.id}>${to}`)) continue;
      seen.add(`${owner.id}>${to}`);
      links.push({ from: owner.id, to, when: when ?? '' });
    }
  }
  return links;
}

/**
 * Journey-to-journey links: `Journey.next` (source 'next'), then every step's `continues` (source 'continues').
 * Only existing journey ids, no self-links, and the first link per from→to wins (so `next` beats `continues`).
 *
 * @param {JourneysDoc} doc - The map.
 * @returns {Array<{ from: string, to: string, when: string, source: 'next'|'continues' }>} Links in document order, `next` links first.
 */
export function journeyLinks(doc) {
  const journeys = (Array.isArray(doc?.journeys) ? doc.journeys : []).filter((journey) => journey && typeof journey === 'object');
  const links = nextLinks(journeys).map((link) => ({ ...link, source: 'next' }));
  const ids = new Set(journeys.map((journey) => journey.id));
  const seen = new Set(links.map((link) => `${link.from}>${link.to}`));
  for (const journey of journeys) {
    for (const step of Array.isArray(journey.steps) ? journey.steps : []) {
      const to = step?.continues;
      if (typeof to !== 'string' || !ids.has(to) || to === journey.id || seen.has(`${journey.id}>${to}`)) continue;
      seen.add(`${journey.id}>${to}`);
      links.push({ from: journey.id, to, when: CONTINUES_WHEN[step.result] ?? '', source: 'continues' });
    }
  }
  return links;
}

/**
 * Area-to-area links from `Area.next`: only existing area ids, no self-links, deduplicated.
 *
 * @param {JourneysDoc} doc - The map.
 * @returns {Array<{ from: string, to: string, when: string }>} Links in document order.
 */
export function areaLinks(doc) {
  return nextLinks((Array.isArray(doc?.areas) ? doc.areas : []).filter((area) => area && typeof area === 'object'));
}

/**
 * Which bucket an item falls in, by word-boundary match on its title and sentence.
 *
 * @param {{ title: string, say?: string }} item - A child of a container.
 * @returns {'anytime'|'start'|'pay'|'core'} The first matching bucket, checked in the order start, anytime, pay, core.
 */
export function bucketOf(item) {
  const text = `${item.title ?? ''} ${item.say ?? ''}`;
  if (START.test(text)) return 'start';
  if (ANYTIME.test(text)) return 'anytime';
  if (PAY.test(text)) return 'pay';
  return 'core';
}

/**
 * No-AI fallback order for a container whose children have no known links: sign-up style items first (chained),
 * then everything else after the last of them; settings and help style items are "anytime". Shown as "order guessed".
 *
 * @param {Array<{ key: string, title: string, say?: string }>} items - The children, in display order.
 * @returns {{ edges: Array<{ from: string, to: string }>, anytime: string[] }} Guessed links (none without a start item) and the keys that are reachable from anywhere.
 */
export function guessOrder(items) {
  const bucket = new Map(items.map((item) => [item.key, bucketOf(item)]));
  const keysIn = (...names) => items.map((item) => item.key).filter((key) => names.includes(bucket.get(key)));
  const starts = keysIn('start');
  const edges = [];
  for (let i = 1; i < starts.length; i += 1) edges.push({ from: starts[i - 1], to: starts[i] });
  if (starts.length) for (const to of keysIn('core', 'pay')) edges.push({ from: starts.at(-1), to });
  return { edges, anytime: keysIn('anytime') };
}

/**
 * The map's containers and what is known about the order of their children: the top level (top-level areas) and every area
 * (its sub-areas, then its own journeys). Journey links and area links are lifted onto the children, so a link between two
 * journeys deep inside two sibling areas becomes a link between those areas. Journeys with no known area (sub-flow-only
 * ones aside) form one more container, "other", as the map draws them; it is not a child of the top level.
 *
 * @param {JourneysDoc} doc - The map.
 * @returns {Array<{ id: string|null, children: Array<{ key: string, kind: 'area'|'journey', id: string, title: string, say: string, anytime: boolean }>, links: Array<{ from: string, to: string, when: string }> }>} One entry per container (`id` null for the top level); child keys are "a:<areaId>" or "j:<journeyId>"; links are between child keys.
 */
export function orderContainers(doc) {
  const areas = (Array.isArray(doc?.areas) ? doc.areas : []).filter((area) => area && typeof area === 'object');
  const areaIds = new Set(areas.map((area) => area.id));
  const subflows = new Set((Array.isArray(doc?.journeys) ? doc.journeys : []).flatMap((journey) => (Array.isArray(journey?.steps) ? journey.steps : []).map((step) => step?.subflow)));
  const isLoose = (journey) => !areaIds.has(journey.area) && !(journey.area == null && subflows.has(journey.id));
  const journeys = (Array.isArray(doc?.journeys) ? doc.journeys : [])
    .filter((journey) => journey && typeof journey === 'object')
    .map((journey) => (isLoose(journey) ? { ...journey, area: OTHER_AREA_ID } : journey));
  const parentOf = new Map(areas.map((area) => [area.id, area.parent ?? null]));
  const childOf = (areaId, container) => {
    let id = areaId;
    for (let hops = 0; id != null && hops <= areas.length; hops += 1) {
      if ((parentOf.get(id) ?? null) === container) return id;
      id = parentOf.get(id);
    }
    return null;
  };
  const keyIn = (journey, container) => {
    if (journey.area != null && journey.area === container) return `j:${journey.id}`;
    const area = journey.area == null ? null : childOf(journey.area, container);
    return area === null ? null : `a:${area}`;
  };
  const lifted = [
    ...journeyLinks(doc).map(({ from, to, when }) => ({ from: journeyById(journeys, from), to: journeyById(journeys, to), when })),
    ...areaLinks(doc).map(({ from, to, when }) => ({ from: { areaId: from }, to: { areaId: to }, when })),
  ];
  const loose = journeys.some((journey) => journey.area === OTHER_AREA_ID) && !areaIds.has(OTHER_AREA_ID) ? [OTHER_AREA_ID] : [];
  return [null, ...areas.map((area) => area.id), ...loose].map((container) => {
    const children = [
      ...areas.filter((area) => (area.parent ?? null) === container).map((area) => ({ key: `a:${area.id}`, kind: 'area', id: area.id, title: area.title ?? area.id, say: area.say ?? '', anytime: area.anytime === true })),
      ...(container === null ? [] : journeys.filter((journey) => journey.area === container).map((journey) => ({ key: `j:${journey.id}`, kind: 'journey', id: journey.id, title: journey.title ?? journey.id, say: '', anytime: journey.anytime === true }))),
    ];
    const keys = new Set(children.map((child) => child.key));
    const seen = new Set();
    const links = [];
    for (const { from, to, when } of lifted) {
      const a = from.areaId !== undefined ? `a:${from.areaId}` : keyIn(from, container);
      const b = to.areaId !== undefined ? `a:${to.areaId}` : keyIn(to, container);
      if (!keys.has(a) || !keys.has(b) || a === b || seen.has(`${a}>${b}`)) continue;
      seen.add(`${a}>${b}`);
      links.push({ from: a, to: b, when });
    }
    return { id: container, children, links };
  });
}

/** A journey by id, or an empty object when it is missing (it then lifts to no child). */
function journeyById(journeys, id) {
  return journeys.find((journey) => journey.id === id) ?? {};
}
