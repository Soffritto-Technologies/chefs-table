import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FLAGS, OTHER_AREA_ID, ROLLUP_ORDER } from './types.mjs';
import { canonicalJson, sha1 } from './util.mjs';

/** @typedef {import('./types.mjs').RenderInput} RenderInput */
/** @typedef {import('./types.mjs').ViewModel} ViewModel */
/** @typedef {import('./types.mjs').ViewNode} ViewNode */
/** @typedef {import('./types.mjs').Journey} Journey */
/** @typedef {import('./types.mjs').Step} Step */
/** @typedef {import('./types.mjs').StepDetail} StepDetail */
/** @typedef {import('./types.mjs').DiffResult} DiffResult */
/** @typedef {import('./types.mjs').ChangeState} ChangeState */
/** @typedef {import('./types.mjs').AnchorState} AnchorState */
/** @typedef {import('./types.mjs').Rollup} Rollup */

const DEFAULT_TEMPLATE_PATH = fileURLToPath(new URL('../templates/journeys.html', import.meta.url));
const DATA_SLOT = /(<script type="application\/json" id="jm-data">)([\s\S]*?)(<\/script>)/;
const OTHER_AREA = Object.freeze({ id: OTHER_AREA_ID, title: 'Other', say: 'Journeys that are not in an area yet' });
const FLAG_ORDER = Object.freeze(Object.values(FLAGS));
const CHANGE_STATES = Object.freeze(['stable', 'new', 'changed', 'removed']);
const ANCHOR_STATES = Object.freeze(['ok', 'broken', 'unverified']);
const DETAIL_TEXT_KEYS = Object.freeze(['sees', 'does']);
const DETAIL_LIST_KEYS = Object.freeze(['rules', 'saves', 'files']);
const RING_MAX = 24;

/**
 * Builds the zoomable view model the template draws: app → areas → (sections →) journeys → steps.
 * Areas nest through `Area.parent`; an area node lists its sections first, then its own journeys.
 * In session mode every node carries its change state, latest-turn ring, plan overlay,
 * flags and (for steps) anchor state; in canonical mode the map is clean.
 * A step's rollup also includes the rollup of the sub-flow journey it opens, so a change
 * inside a sub-flow lights up the route down to it from the top.
 * The app and every area get `layout`: 'ring' for up to 24 children, otherwise 'grid', with the
 * children sorted sections first, then strongest rollup, then title.
 *
 * @param {RenderInput} input - Document plus precomputed diffs, plan keys, conflicts and anchors.
 * @returns {ViewModel} The view model, with no undefined-valued keys so its JSON is stable.
 */
export function buildViewModel(input) {
  const doc = input?.doc ?? {};
  const mode = input?.mode === 'session' ? 'session' : 'canonical';
  const ctx = mode === 'session' ? sessionContext(input) : null;

  const journeys = collectJourneys(doc, ctx);
  const journeyNodes = new Map(journeys.map(({ journey, removed }) => [journey.id, buildJourneyNode(journey, removed, ctx)]));
  resolveRollups(journeyNodes);

  const areaOf = new Map(journeys.map(({ journey }) => [journey.id, journey.area]));
  const root = containerNode({ kind: 'app', id: 'app', title: text(doc.app) }, buildAreaNodes(doc, areaOf, journeyNodes));

  const vm = {
    mode,
    app: text(doc.app),
    root,
    journeys: Object.fromEntries(journeyNodes),
    banners: ctx ? strings(input.banners) : [],
    chips: ctx ? strings(input.chips) : [],
  };
  if (ctx && typeof input.planSummary === 'string' && input.planSummary) vm.planSummary = input.planSummary;
  if (ctx && typeof input.approval === 'string' && input.approval) vm.approval = input.approval;
  return vm;
}

/**
 * Serialises a value as JSON that is safe to embed inside an HTML <script> element.
 * Escapes <, >, &, U+2028 and U+2029 as \uXXXX so the data can never close the script tag.
 *
 * @param {unknown} value - Any JSON-serialisable value.
 * @returns {string} Escaped JSON text ("null" when the value serialises to nothing).
 *
 * @example
 * escapeJsonForHtml({ t: '</script>' }); // '{"t":"\\u003c/script\\u003e"}'
 */
export function escapeJsonForHtml(value) {
  const json = JSON.stringify(value) ?? 'null';
  return json.replace(/[<>&\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Renders the self-contained HTML map: the template with the view model embedded in
 * <script type="application/json" id="jm-data">. Output is deterministic for a given view model.
 *
 * @param {ViewModel} vm - View model from buildViewModel.
 * @param {{ templatePath?: string }} [options] - templatePath defaults to templates/journeys.html.
 * @returns {string} The full HTML document.
 * @throws {Error} When the template has no jm-data script element.
 */
export function renderHtml(vm, { templatePath = DEFAULT_TEMPLATE_PATH } = {}) {
  const template = readFileSync(templatePath, 'utf8');
  if (!DATA_SLOT.test(template)) {
    throw new Error(`Template has no <script type="application/json" id="jm-data"> element: ${templatePath}`);
  }
  const data = escapeJsonForHtml(vm);
  const title = escapeHtmlText(vm.app ? `${vm.app} · Journey map` : 'Journey map');
  return template
    .replace(DATA_SLOT, (_match, open, _old, close) => open + data + close)
    .replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`);
}

/**
 * Escapes text for use inside an HTML element such as <title>.
 *
 * @param {string} text - Plain text.
 * @returns {string} Text with &, <, >, " and ' escaped.
 */
function escapeHtmlText(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/**
 * Hashes a view model so callers can skip rewriting an unchanged map.
 * Object keys are sorted first, so the hash ignores key order.
 *
 * @param {ViewModel} vm - View model from buildViewModel.
 * @returns {string} 40-character lowercase sha1 hex digest.
 */
export function viewModelHash(vm) {
  return sha1(canonicalJson(vm) ?? 'null');
}

/**
 * Indexes the session-only inputs once so node builders can look keys up cheaply.
 *
 * @param {RenderInput} input - Render input in session mode.
 * @returns {object} Lookup helpers for states, latest, plan, flags and anchors.
 */
function sessionContext(input) {
  const anchors = input.anchors ?? {};
  return {
    start: diffLookup(input.sinceStart),
    last: diffLookup(input.sinceLast),
    planned: new Set(input.plannedKeys ?? []),
    flags: explicitFlags(input.flags),
    conflicts: Array.isArray(input.conflicts) ? input.conflicts : [],
    anchor: (key) => (Object.hasOwn(anchors, key) && ANCHOR_STATES.includes(anchors[key]) ? anchors[key] : undefined),
    removedJourneys: input.sinceStart?.removedJourneys ?? [],
    removedSteps: input.sinceStart?.removedSteps ?? [],
  };
}

/**
 * Turns a DiffResult into a key → ChangeState lookup. Keys listed only in the removed
 * lists count as 'removed'; anything else missing is 'stable'.
 *
 * @param {DiffResult} [diff] - Diff to index.
 * @returns {(key: string) => ChangeState} State lookup.
 */
function diffLookup(diff) {
  const states = diff?.states ?? {};
  const removed = new Set();
  for (const journey of diff?.removedJourneys ?? []) {
    if (!journey) continue;
    removed.add(journeyKey(journey.id));
    for (const step of journey.steps ?? []) if (step) removed.add(stepKey(journey.id, step.id));
  }
  for (const entry of diff?.removedSteps ?? []) {
    if (entry?.step) removed.add(stepKey(entry.journeyId, entry.step.id));
  }
  return (key) => {
    if (Object.hasOwn(states, key) && CHANGE_STATES.includes(states[key])) return states[key];
    return removed.has(key) ? 'removed' : 'stable';
  };
}

/**
 * Collects caller-supplied flags by key, keeping only known FLAGS values.
 *
 * @param {Record<string, string[]>} [flags] - Extra flags by "j:"/"s:" key.
 * @returns {Map<string, Set<string>>} Flags by key.
 */
function explicitFlags(flags) {
  const byKey = new Map();
  for (const [key, list] of Object.entries(flags ?? {})) {
    for (const flag of Array.isArray(list) ? list : []) {
      if (!FLAG_ORDER.includes(flag)) continue;
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key).add(flag);
    }
  }
  return byKey;
}

/**
 * Lists the journeys to draw: the current document's, then journeys removed since the
 * chat started (session mode only). The first journey with a given id wins.
 *
 * @param {object} doc - JourneysDoc.
 * @param {object|null} ctx - Session context, or null in canonical mode.
 * @returns {Array<{ journey: Journey, removed: boolean }>} Journeys in drawing order.
 */
function collectJourneys(doc, ctx) {
  const seen = new Set();
  const out = [];
  const add = (journey, removed) => {
    if (!journey || typeof journey.id !== 'string' || seen.has(journey.id)) return;
    seen.add(journey.id);
    out.push({ journey, removed });
  };
  for (const journey of doc.journeys ?? []) add(journey, false);
  for (const journey of ctx?.removedJourneys ?? []) add(journey, true);
  return out;
}

/**
 * Lists a journey's steps: its own, then steps removed from it since the chat started.
 * Every step of a removed journey is itself removed.
 *
 * @param {Journey} journey - The journey.
 * @param {boolean} journeyRemoved - Whether the whole journey was removed.
 * @param {object|null} ctx - Session context, or null in canonical mode.
 * @returns {Array<{ step: Step, removed: boolean }>} Steps in drawing order.
 */
function collectSteps(journey, journeyRemoved, ctx) {
  const seen = new Set();
  const out = [];
  const add = (step, removed) => {
    if (!step || typeof step.id !== 'string' || seen.has(step.id)) return;
    seen.add(step.id);
    out.push({ step, removed });
  };
  for (const step of journey.steps ?? []) add(step, journeyRemoved);
  if (!journeyRemoved) {
    for (const entry of ctx?.removedSteps ?? []) {
      if (entry?.journeyId === journey.id) add(entry.step, true);
    }
  }
  return out;
}

/**
 * Builds a journey node with its step children, edges and step depths.
 *
 * @param {Journey} journey - The journey.
 * @param {boolean} removed - Whether it was removed since the chat started.
 * @param {object|null} ctx - Session context, or null in canonical mode.
 * @returns {ViewNode} Journey node (rollups are filled in later by resolveRollups).
 */
function buildJourneyNode(journey, removed, ctx) {
  const entries = collectSteps(journey, removed, ctx);
  const graph = stepGraph(entries.map(({ step }) => step));
  const depths = computeDepths(graph);
  const screens = conflictScreens(ctx, journey.id);
  const node = {
    kind: 'journey',
    id: journey.id,
    title: text(journey.title) || journey.id,
  };
  if (typeof journey.who === 'string' && journey.who) node.say = journey.who;
  Object.assign(node, nodeFields(ctx, journeyKey(journey.id), removed, screens.size > 0));
  node.rollup = 'stable';
  node.children = entries.map(({ step, removed: stepRemoved }) =>
    buildStepNode(journey.id, step, stepRemoved, depths.get(step.id), ctx, screens),
  );
  node.edges = graph.ids.flatMap((from) =>
    graph.next.get(from).map((to) => [nodeId(journey.id, from), nodeId(journey.id, to)]),
  );
  return node;
}

/**
 * Builds a step node.
 *
 * @param {string} journeyId - Owning journey id.
 * @param {Step} step - The step.
 * @param {boolean} removed - Whether it was removed since the chat started.
 * @param {number} depth - Column index from computeDepths.
 * @param {object|null} ctx - Session context, or null in canonical mode.
 * @param {Set<string>} screens - Conflict screens that apply to this journey.
 * @returns {ViewNode} Step node.
 */
function buildStepNode(journeyId, step, removed, depth, ctx, screens) {
  const key = stepKey(journeyId, step.id);
  const screen = typeof step.screen === 'string' ? step.screen : null;
  const onConflictScreen = screen !== null && screens.has(screen);
  const node = {
    kind: 'step',
    id: nodeId(journeyId, step.id),
    title: text(step.say) || step.id,
    ...nodeFields(ctx, key, removed, onConflictScreen),
  };
  const anchor = ctx?.anchor(key);
  if (anchor) node.anchor = anchor;
  node.rollup = 'stable';
  node.children = [];
  node.depth = depth ?? 0;
  const detail = pickDetail(step.detail);
  if (detail) node.detail = detail;
  node.screen = screen;
  if (typeof step.subflow === 'string' && step.subflow) node.subflow = step.subflow;
  return node;
}

/**
 * Session-dependent fields shared by journey and step nodes.
 *
 * @param {object|null} ctx - Session context, or null in canonical mode.
 * @param {string} key - "j:" or "s:" key.
 * @param {boolean} removed - Forces state 'removed'.
 * @param {boolean} [conflict] - Adds the conflict flag.
 * @returns {{ state: ChangeState, latest: boolean, planned: boolean, flags: string[] }} Fields in contract order.
 */
function nodeFields(ctx, key, removed, conflict = false) {
  if (!ctx) return neutralFields();
  const flags = new Set(ctx.flags.get(key) ?? []);
  if (conflict) flags.add(FLAGS.CONFLICT);
  return {
    state: removed ? 'removed' : ctx.start(key),
    latest: ctx.last(key) !== 'stable',
    planned: ctx.planned.has(key),
    flags: FLAG_ORDER.filter((flag) => flags.has(flag)),
  };
}

/**
 * Fields of a node with no session state (areas, the app, and everything in canonical mode).
 *
 * @returns {{ state: 'stable', latest: false, planned: false, flags: string[] }} Neutral fields.
 */
function neutralFields() {
  return { state: 'stable', latest: false, planned: false, flags: [] };
}

/**
 * Screens in conflict for a journey: those of conflicts where it is the plan journey or
 * one of the other journeys. Steps on these screens get the conflict flag.
 *
 * @param {object|null} ctx - Session context, or null in canonical mode.
 * @param {string} journeyId - Journey id.
 * @returns {Set<string>} Conflict screens.
 */
function conflictScreens(ctx, journeyId) {
  const screens = new Set();
  for (const conflict of ctx?.conflicts ?? []) {
    if (conflict?.planJourney === journeyId || (conflict?.otherJourneys ?? []).includes(journeyId)) {
      screens.add(conflict.screen);
    }
  }
  return screens;
}

/**
 * Adjacency of a journey's steps: unique `next` targets that exist in the journey.
 *
 * @param {Step[]} steps - Steps in order.
 * @returns {{ ids: string[], next: Map<string, string[]> }} Step ids and their successors.
 */
function stepGraph(steps) {
  const ids = steps.map((step) => step.id);
  const known = new Set(ids);
  const next = new Map(
    steps.map((step) => [step.id, [...new Set(Array.isArray(step.next) ? step.next : [])].filter((id) => known.has(id))]),
  );
  return { ids, next };
}

/**
 * Column index of every step: the longest path from a step with no incoming edge.
 * Back edges found by a depth-first walk are ignored, so loops such as "card declined →
 * try again" cannot recurse forever. The walk starts at the journey's first step, then the
 * other entry steps, so a loop back to the authored entry is the edge that gets dropped.
 *
 * @param {{ ids: string[], next: Map<string, string[]> }} graph - From stepGraph.
 * @returns {Map<string, number>} Depth by step id.
 */
function computeDepths({ ids, next }) {
  const incoming = new Map(ids.map((id) => [id, 0]));
  for (const id of ids) for (const to of next.get(id)) incoming.set(to, incoming.get(to) + 1);
  const entries = ids.filter((id) => incoming.get(id) === 0);

  const status = new Map();
  const back = new Set();
  const visit = (id) => {
    status.set(id, 'active');
    for (const to of next.get(id)) {
      if (status.get(to) === 'active') back.add(edgeKey(id, to));
      else if (!status.has(to)) visit(to);
    }
    status.set(id, 'done');
  };
  for (const id of [...ids.slice(0, 1), ...entries, ...ids]) if (!status.has(id)) visit(id);

  const forward = (id) => next.get(id).filter((to) => !back.has(edgeKey(id, to)));
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const id of ids) for (const to of forward(id)) indegree.set(to, indegree.get(to) + 1);
  const depth = new Map(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indegree.get(id) === 0);
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i];
    for (const to of forward(id)) {
      depth.set(to, Math.max(depth.get(to), depth.get(id) + 1));
      indegree.set(to, indegree.get(to) - 1);
      if (indegree.get(to) === 0) queue.push(to);
    }
  }
  return depth;
}

/**
 * Own rollup of a node, before looking at anything inside it.
 *
 * @param {ViewNode} node - Any node.
 * @returns {Rollup} Own rollup.
 */
function ownRollup(node) {
  if (node.flags.includes(FLAGS.CONFLICT)) return 'conflict';
  if (node.state === 'changed' || node.state === 'removed') return 'changed';
  if (node.state === 'new') return 'new';
  if (node.anchor === 'broken') return 'broken';
  return 'stable';
}

/**
 * Fills in rollups for every journey and step. A step with a sub-flow takes the
 * sub-flow journey's rollup too; sub-flow cycles fall back to the journey's own rollup.
 *
 * @param {Map<string, ViewNode>} journeys - Journey nodes by id (mutated).
 * @returns {void}
 */
function resolveRollups(journeys) {
  const done = new Set();
  const active = new Set();
  const resolve = (id) => {
    const journey = journeys.get(id);
    if (!journey) return 'stable';
    if (done.has(id)) return journey.rollup;
    if (active.has(id)) return ownRollup(journey);
    active.add(id);
    let rollup = ownRollup(journey);
    for (const step of journey.children) {
      step.rollup = step.subflow ? strongest(ownRollup(step), resolve(step.subflow)) : ownRollup(step);
      rollup = strongest(rollup, step.rollup);
    }
    journey.rollup = rollup;
    active.delete(id);
    done.add(id);
    return rollup;
  };
  for (const id of journeys.keys()) resolve(id);
}

/**
 * Builds the top-level area nodes, each holding its sections (child areas) and then its own
 * journeys, in doc.areas order. "Other" comes last and takes journeys with no (or an unknown)
 * area. Sub-flow-only journeys (no area, opened from another journey's step) stay off the map's
 * rings. Areas with no journeys anywhere beneath them are skipped.
 *
 * @param {object} doc - JourneysDoc.
 * @param {Map<string, string|undefined>} areaOf - Area id of every journey, current and removed.
 * @param {Map<string, ViewNode>} journeyNodes - Built journey nodes by id.
 * @returns {ViewNode[]} Top-level area nodes.
 */
function buildAreaNodes(doc, areaOf, journeyNodes) {
  const defs = new Map();
  for (const area of doc.areas ?? []) {
    if (area && typeof area.id === 'string' && !defs.has(area.id)) defs.set(area.id, area);
  }
  if (!defs.has(OTHER_AREA_ID)) defs.set(OTHER_AREA_ID, OTHER_AREA);

  const journeysIn = new Map([...defs.keys()].map((id) => [id, []]));
  const subflowTargets = new Set();
  for (const journey of journeyNodes.values()) {
    for (const step of journey.children) if (step.subflow && step.subflow !== journey.id) subflowTargets.add(step.subflow);
  }
  for (const [id, node] of journeyNodes) {
    const area = areaOf.get(id);
    const hasArea = typeof area === 'string' && area !== '';
    if (!hasArea && subflowTargets.has(id)) continue;
    journeysIn.get(hasArea && defs.has(area) ? area : OTHER_AREA_ID).push(node);
  }

  const sectionsIn = new Map([...defs.keys()].map((id) => [id, []]));
  const topLevel = [];
  for (const id of defs.keys()) {
    const parent = parentArea(defs, id);
    (parent ? sectionsIn.get(parent) : topLevel).push(id);
  }

  const build = (id) => {
    const children = [...sectionsIn.get(id).map(build).filter(Boolean), ...journeysIn.get(id)];
    if (!children.length) return null;
    const area = defs.get(id);
    const head = { kind: 'area', id, title: text(area.title) || id };
    if (typeof area.say === 'string' && area.say) head.say = area.say;
    return containerNode(head, children);
  };
  return topLevel.map(build).filter(Boolean);
}

/**
 * The parent of an area, or null when it is top-level. A parent that is unknown, or a chain of
 * parents that loops back on itself, makes the area top-level so the tree is always finite.
 *
 * @param {Map<string, object>} defs - Area definitions by id.
 * @param {string} id - Area id.
 * @returns {string|null} Parent area id.
 */
function parentArea(defs, id) {
  const parent = defs.get(id).parent;
  if (typeof parent !== 'string' || parent === id || !defs.has(parent)) return null;
  const seen = new Set([id]);
  for (let at = parent; typeof at === 'string' && defs.has(at); at = defs.get(at).parent) {
    if (seen.has(at)) return null;
    seen.add(at);
  }
  return parent;
}

/**
 * Finishes the app node or an area node: neutral session fields, rollup over its children, and
 * `layout` ('ring' up to RING_MAX children, else 'grid' with children in grid order).
 *
 * @param {{ kind: string, id: string, title: string, say?: string }} head - Leading fields.
 * @param {ViewNode[]} children - Sections and journeys (or top-level areas for the app).
 * @returns {ViewNode} The node.
 */
function containerNode(head, children) {
  const grid = children.length > RING_MAX;
  return {
    ...head,
    ...neutralFields(),
    rollup: children.reduce((acc, child) => strongest(acc, child.rollup), 'stable'),
    layout: grid ? 'grid' : 'ring',
    children: grid ? [...children].sort(gridOrder) : children,
  };
}

/**
 * Grid order: sections before journeys, then strongest rollup first, then title, then id.
 *
 * @param {ViewNode} a - First node.
 * @param {ViewNode} b - Second node.
 * @returns {number} Sort comparison.
 */
function gridOrder(a, b) {
  return (
    Number(a.kind !== 'area') - Number(b.kind !== 'area') ||
    ROLLUP_ORDER.indexOf(a.rollup) - ROLLUP_ORDER.indexOf(b.rollup) ||
    compareText(a.title.toLowerCase(), b.title.toLowerCase()) ||
    compareText(a.id, b.id)
  );
}

/**
 * Locale-independent string comparison, so the order is the same on every machine.
 *
 * @param {string} a - First string.
 * @param {string} b - Second string.
 * @returns {number} -1, 0 or 1.
 */
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Copies the known StepDetail fields, dropping anything else.
 *
 * @param {StepDetail} [detail] - Raw step detail.
 * @returns {StepDetail|undefined} Clean detail, or undefined when nothing is left.
 */
function pickDetail(detail) {
  if (!detail || typeof detail !== 'object') return undefined;
  const out = {};
  for (const key of DETAIL_TEXT_KEYS) if (typeof detail[key] === 'string' && detail[key]) out[key] = detail[key];
  for (const key of DETAIL_LIST_KEYS) {
    const list = strings(detail[key]);
    if (list.length) out[key] = list;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The stronger of two rollups by ROLLUP_ORDER.
 *
 * @param {Rollup} a - First rollup.
 * @param {Rollup} b - Second rollup.
 * @returns {Rollup} The stronger one.
 */
function strongest(a, b) {
  return ROLLUP_ORDER.indexOf(a) <= ROLLUP_ORDER.indexOf(b) ? a : b;
}

/**
 * Keeps only non-empty strings from a possibly missing list.
 *
 * @param {unknown} list - Candidate list.
 * @returns {string[]} The strings.
 */
function strings(list) {
  return Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item !== '') : [];
}

/**
 * Coerces a possibly missing value to a string.
 *
 * @param {unknown} value - Candidate text.
 * @returns {string} The string, or '' for null/undefined.
 */
function text(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/**
 * @param {string} journeyId - Journey id.
 * @returns {string} "j:<journeyId>".
 */
function journeyKey(journeyId) {
  return `j:${journeyId}`;
}

/**
 * @param {string} journeyId - Journey id.
 * @param {string} stepId - Step id.
 * @returns {string} "s:<journeyId>/<stepId>".
 */
function stepKey(journeyId, stepId) {
  return `s:${journeyId}/${stepId}`;
}

/**
 * @param {string} journeyId - Journey id.
 * @param {string} stepId - Step id.
 * @returns {string} Step node id "<journeyId>/<stepId>".
 */
function nodeId(journeyId, stepId) {
  return `${journeyId}/${stepId}`;
}

/**
 * @param {string} from - Source step id.
 * @param {string} to - Target step id.
 * @returns {string} Collision-free key for an edge.
 */
function edgeKey(from, to) {
  return JSON.stringify([from, to]);
}
