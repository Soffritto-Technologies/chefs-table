/**
 * Health checks for the journey map. They read only the map (and the code scan and coverage when given), use no AI,
 * and give the same findings in the same order for the same input. Messages are written for a non-technical reader.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRoute } from './anchors.mjs';
import { nextIds, sanitizeText, shortenText } from './model.mjs';
import { sortKeysDeep, writeTextAtomic } from './util.mjs';

/** @typedef {import('./types.mjs').Finding} Finding */
/** @typedef {import('./types.mjs').JourneysDoc} JourneysDoc */

const COMPLEX_FILES = 12;
const HOTSPOT_JOURNEYS = 8;
const HEAVY_RULES = 6;
const MAX_MESSAGE = 160;
const MAX_EVIDENCE = 6;
const MAX_NAME = 60;
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
const NUMBER_FACT = /(\d+(?:[.,]\d+)?)\s*(%|[a-z]{2,})/gi;
const NOT_A_NOUN = new Set(['of', 'to', 'the', 'and', 'or', 'in', 'is', 'are', 'at', 'on', 'per', 'for', 'by', 'as', 'it', 'if', 'be', 'an']);
const REQUIRED = /\b(must|required|mandatory)\b/i;
const OPTIONAL = /\b(optional|not required|can be skipped)\b/i;
const NOT_A_TOPIC = new Set(['must', 'required', 'mandatory', 'optional', 'not', 'that', 'with', 'from', 'this', 'have', 'when', 'will', 'they', 'their', 'then', 'only', 'can', 'skipped', 'user', 'users', 'person']);

/**
 * Runs every health check.
 *
 * @param {JourneysDoc} doc - The map.
 * @param {import('./types.mjs').Inventory|null} [inventory] - The code scan (lets route anchors count as the files that serve them).
 * @param {import('./types.mjs').Coverage|null} [coverage] - Coverage of the map (pages and features nobody mapped become findings).
 * @returns {Finding[]} Findings, most serious first, then by check, target and id.
 */
export function healthChecks(doc, inventory = null, coverage = null) {
  const journeys = (Array.isArray(doc?.journeys) ? doc.journeys : []).filter((journey) => journey && typeof journey === 'object');
  const findings = [];
  for (const journey of journeys) findings.push(...journeyFindings(journey));
  findings.push(...rulesDisagree(journeys));
  findings.push(...sizeFindings(journeys, pageFiles(inventory)));
  findings.push(...orphans(coverage));
  return findings.sort(compareFindings);
}

/**
 * Counts findings by severity.
 *
 * @param {Finding[]} findings - Findings from {@link healthChecks}.
 * @returns {{ high: number, medium: number, low: number }} Counts.
 */
export function countFindings(findings) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/**
 * Where the findings are stored.
 *
 * @param {string} projectDir - Absolute project directory.
 * @returns {string} Absolute path of `.journeys/findings.json`.
 */
export function findingsPath(projectDir) {
  return join(projectDir, '.journeys', 'findings.json');
}

/**
 * Stores findings as sorted, indented JSON (the same findings always give the same file).
 *
 * @param {string} projectDir - Absolute project directory.
 * @param {Finding[]} findings - Findings from {@link healthChecks}.
 * @returns {void}
 */
export function saveFindings(projectDir, findings) {
  writeTextAtomic(findingsPath(projectDir), `${JSON.stringify(sortKeysDeep(findings), null, 2)}\n`);
}

/**
 * Reads the stored findings.
 *
 * @param {string} projectDir - Absolute project directory.
 * @returns {Finding[]} The findings, or an empty list when none are stored or the file is unreadable.
 */
export function loadFindings(projectDir) {
  try {
    const stored = JSON.parse(readFileSync(findingsPath(projectDir), 'utf8'));
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

/** Builds one finding with a plain-language message cut to the limit. */
function finding(check, severity, target, message, evidence = []) {
  return {
    id: `${check}:${target}`,
    check,
    severity,
    target,
    message: shortenText(message.replace(/\s+/g, ' ').trim(), MAX_MESSAGE),
    ...(evidence.length ? { evidence: evidence.slice(0, MAX_EVIDENCE) } : {}),
  };
}

/** Most serious first, then check, target and id (plain string order, so it never depends on the locale). */
function compareFindings(a, b) {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || cmp(a.check, b.check) || cmp(a.target, b.target) || cmp(a.id, b.id);
}

/** Plain string comparison. */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A journey's title as a quoted name for messages. */
function titleOf(journey) {
  return `"${shortenText(sanitizeText(journey.title) || String(journey.id), MAX_NAME)}"`;
}

/** A step's label (or sentence) as a quoted name for messages. */
function nameOf(step) {
  return `"${shortenText(sanitizeText(step.label) || sanitizeText(step.say) || String(step.id), MAX_NAME)}"`;
}

/** The steps of a journey with who leads to whom (arrows to steps that don't exist are ignored). */
function graphOf(journey) {
  const steps = (Array.isArray(journey.steps) ? journey.steps : []).filter((step) => step && typeof step === 'object');
  const byId = new Map(steps.map((step) => [step.id, step]));
  const out = new Map(steps.map((step) => [step.id, nextIds(step).filter((id) => byId.has(id))]));
  const into = new Map(steps.map((step) => [step.id, []]));
  for (const [from, targets] of out) for (const to of targets) into.get(to).push(from);
  return { steps, byId, out, into };
}

/** Findings about one journey's flow: dead ends, no way back from a failure, no success, unreachable steps. */
function journeyFindings(journey) {
  const graph = graphOf(journey);
  const { steps, byId, out, into } = graph;
  if (!steps.length) return [];
  const results = [];
  const title = titleOf(journey);
  const key = (step) => `s:${journey.id}/${step.id}`;
  const handsOver = steps.some((step) => step.continues);
  for (const step of steps) {
    const ends = out.get(step.id).length === 0;
    if (ends && step.kind !== 'outcome' && !step.continues) {
      results.push(finding('dead-end', 'high', key(step), `${nameOf(step)} in ${title} has nowhere to go next and doesn't say how the path ends.`));
    }
    if (ends && step.kind === 'outcome' && step.result === 'failure' && !step.continues) {
      const alternative = into.get(step.id).some((from) => out.get(from).some((to) => to !== step.id && byId.get(to).kind !== 'outcome'));
      if (!alternative) results.push(finding('no-recovery', 'medium', key(step), `${nameOf(step)} in ${title} is a failure with no way back: no retry and no other route.`));
    }
  }
  const outcomes = steps.filter((step) => step.kind === 'outcome');
  if (!handsOver && !outcomes.length) {
    results.push(finding('no-success', 'low', `j:${journey.id}`, `${title} never says how it ends: it has no success, failure or abandoned step.`));
  } else if (!handsOver && !outcomes.some((step) => step.result === 'success')) {
    results.push(finding('no-success', 'high', `j:${journey.id}`, `${title} has endings but none of them is a success.`, outcomes.map(key)));
  }
  const reached = new Set([steps[0].id]);
  for (const id of reached) for (const next of out.get(id)) reached.add(next);
  for (const step of steps.filter((candidate) => !reached.has(candidate.id) && candidate.kind !== 'background')) {
    results.push(finding('unreachable', 'medium', key(step), `${nameOf(step)} in ${title} can't be reached from the start of the journey.`));
  }
  return results;
}

/** Steps in different journeys that sit on the same file and screen but state rules that contradict each other. */
function rulesDisagree(journeys) {
  const groups = new Map();
  for (const journey of journeys) {
    for (const step of graphOf(journey).steps) {
      const rules = (Array.isArray(step.detail?.rules) ? step.detail.rules : []).filter((rule) => typeof rule === 'string');
      if (!rules.length) continue;
      const key = `${step.anchor?.type}:${step.anchor?.value}|${step.screen ?? ''}`;
      groups.set(key, [...(groups.get(key) || []), { journey, step, rules: rules.map(prepareRule) }]);
    }
  }
  const results = [];
  for (const members of groups.values()) {
    const clashes = [];
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        if (members[i].journey.id === members[j].journey.id) continue;
        for (const a of members[i].rules) {
          for (const b of members[j].rules) {
            const why = contradiction(a, b);
            if (why) clashes.push(`${why}: "${shortenText(a.text, 80)}" (${titleOf(members[i].journey)}) vs "${shortenText(b.text, 80)}" (${titleOf(members[j].journey)})`);
          }
        }
      }
    }
    if (!clashes.length) continue;
    const first = members[0];
    results.push(finding('rules-disagree', 'low', `s:${first.journey.id}/${first.step.id}`, `${clashes.length === 1 ? 'Two journeys' : 'Journeys'} state rules for the same screen that don't agree: ${clashes[0].split(': ')[0]}.`, clashes));
  }
  return results;
}

/** A rule with what the contradiction test needs worked out once: its numbers by noun, its topic words, and whether it says required or optional. */
function prepareRule(text) {
  return { text, facts: numberFacts(text), topics: topics(text), required: REQUIRED.test(text), optional: OPTIONAL.test(text) };
}

/** Why two prepared rules contradict (a plain phrase), or null: the same noun with different numbers, or "must" against "optional". */
function contradiction(a, b) {
  for (const [noun, numbers] of a.facts) {
    const other = b.facts.get(noun);
    if (other && ![...numbers].some((value) => other.has(value))) return `different numbers for "${noun}" (${[...numbers].join('/')} vs ${[...other].join('/')})`;
  }
  const sharesTopic = [...a.topics].some((word) => b.topics.has(word));
  if (sharesTopic && ((a.required && b.optional) || (a.optional && b.required))) return 'one says it is required, the other says it is optional';
  return null;
}

/** Numbers a rule gives, by the (singular) noun that follows them. */
function numberFacts(rule) {
  const facts = new Map();
  for (const [, number, word] of rule.matchAll(NUMBER_FACT)) {
    const noun = word.toLowerCase();
    if (NOT_A_NOUN.has(noun)) continue;
    const key = noun.length > 3 && noun.endsWith('s') ? noun.slice(0, -1) : noun;
    facts.set(key, new Set([...(facts.get(key) || []), number.replace(',', '.')]));
  }
  return facts;
}

/** The meaningful words of a rule (4+ letters, without filler and without the words that carry the requirement). */
function topics(rule) {
  return new Set((rule.toLowerCase().match(/[a-z]{4,}/g) || []).filter((word) => !NOT_A_TOPIC.has(word)));
}

/** Repo files that serve each route, from the code scan. */
function pageFiles(inventory) {
  const files = new Map();
  for (const page of inventory?.pages || []) {
    const route = normalizeRoute(page.route);
    files.set(route, [...(files.get(route) || []), page.file]);
  }
  return files;
}

/** Journeys that touch too many files, files that too many journeys touch, and steps that hold too many rules. */
function sizeFindings(journeys, pages) {
  const results = [];
  const usedBy = new Map();
  for (const journey of journeys) {
    const files = new Set();
    for (const step of graphOf(journey).steps) {
      if (step.anchor?.type === 'file' && typeof step.anchor.value === 'string') files.add(step.anchor.value);
      for (const route of [step.screen, step.anchor?.type === 'route' ? step.anchor.value : null].filter((value) => typeof value === 'string')) {
        for (const file of pages.get(normalizeRoute(route)) || []) files.add(file);
      }
      for (const file of Array.isArray(step.detail?.files) ? step.detail.files : []) if (typeof file === 'string') files.add(file);
      const rules = Array.isArray(step.detail?.rules) ? step.detail.rules.length : 0;
      if (rules >= HEAVY_RULES) results.push(finding('logic-heavy', 'low', `s:${journey.id}/${step.id}`, `${nameOf(step)} in ${titleOf(journey)} holds ${rules} rules in one step; splitting it would make it easier to follow.`));
    }
    if (files.size >= COMPLEX_FILES) results.push(finding('complex-journey', 'low', `j:${journey.id}`, `${titleOf(journey)} touches ${files.size} files; it may be doing too much.`));
    for (const file of files) usedBy.set(file, [...(usedBy.get(file) || []), journey.id]);
  }
  for (const [file, ids] of usedBy) {
    if (ids.length >= HOTSPOT_JOURNEYS) results.push(finding('shared-hotspot', 'low', `file:${file}`, `${file} is used by ${ids.length} journeys, so a change there ripples widely (a candidate for tidying up).`, ids.map((id) => `j:${id}`)));
  }
  return results;
}

/** Pages and features the code has that the map doesn't explain. */
function orphans(coverage) {
  const pages = (coverage?.pages?.missing || []).map((route) => finding('orphan-page', 'medium', `page:${route}`, `The page ${route} is in the code but not on the map.`));
  const features = (coverage?.features?.missing || []).map((entry) => {
    const slash = entry.indexOf('/');
    const [app, key] = slash < 0 ? ['', entry] : [entry.slice(0, slash), entry.slice(slash + 1)];
    return finding('orphan-feature', 'medium', `feature:${entry}`, `The ${key} feature${app ? ` of ${app}` : ''} is in the code but not on the map.`);
  });
  return [...pages, ...features];
}
