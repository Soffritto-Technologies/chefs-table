/**
 * Chop: scans a codebase without any AI and lists everything a user can touch (pages, links, forms, API calls,
 * endpoints, sign-in guards, emails, jobs, data models), so later AI passes can be small, targeted and measured.
 * Same code in, byte-identical JSON out: every list is sorted and nothing depends on absolute paths or mtimes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, PIPELINE } from './types.mjs';
import { matchAny, walk } from './glob.mjs';
import { extractDefinitions, extractMentions, isNextProject, listRouteFiles, normalizeRoute } from './anchors.mjs';
import { sha1 } from './util.mjs';

/** @typedef {import('./types.mjs').Config} Config */
/** @typedef {import('./types.mjs').Inventory} Inventory */
/** @typedef {import('./types.mjs').InventoryPage} InventoryPage */
/** @typedef {import('./types.mjs').InventoryItem} InventoryItem */
/** @typedef {import('./types.mjs').WorkUnit} WorkUnit */
/** @typedef {import('./types.mjs').Coverage} Coverage */
/** @typedef {import('./types.mjs').JourneysDoc} JourneysDoc */

/**
 * @typedef {object} PlanOptions
 * @property {number} [maxTokens]   Budget per unit in estimated tokens (bytes / 4); defaults to PIPELINE.UNIT_MAX_TOKENS.
 * @property {string[]} [routes]    Plan only the pages with these routes (any spelling; they are normalized).
 * @property {'area' | 'gap' | 'refresh'} [kind]  Kind of the units; 'area' by default.
 * @property {string} [idPrefix]    Id prefix; defaults to `kind`.
 * @property {number} [minViewTokens]  A view of a big page smaller than this is merged into "Other parts"; defaults to 3000.
 */

/**
 * @typedef {object} Source
 * @property {string} file    Repo-relative path.
 * @property {string} rel     Path relative to config.root.
 * @property {string} text    Contents with LF line endings.
 * @property {number} bytes
 * @property {string} sha1
 */

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|prisma|sql)$/;
const CODE_FILE = /\.[cm]?[jt]sx?$/;
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const ROOT_MIDDLEWARE = ['middleware.ts', 'middleware.js', 'middleware.mjs'];
const MAX_FILE_BYTES = 1_000_000;
const MAX_DETAIL = 120;
const COMPONENT_LOOKAHEAD = 300;
const SHARED_FRACTION = 0.3;
// With only a handful of pages any import would pass 30%, so a file must also be reached from this many pages.
const MIN_SHARED_PAGES = 3;
const FORM_IMPORT_DEPTH = 2;
const BYTES_PER_TOKEN = 4;
const HOME_AREA = 'home';

const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (values) => [...new Set(values)].sort(compareStrings);
const sortedObject = (entries) => Object.fromEntries([...entries].sort(([a], [b]) => compareStrings(a, b)));
const estTokens = (bytes) => Math.ceil(bytes / BYTES_PER_TOKEN);

// Posix separators, no leading "./" or trailing "/"; "" for the current directory.
function toPosix(value) {
  const normalized = path.posix.normalize(String(value).replace(/\\/g, '/')).replace(/\/+$/, '');
  return normalized === '.' ? '' : normalized;
}

function capDetail(detail) {
  const text = detail.replace(/\s+/g, ' ').trim();
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text;
}

// "AICoachTopBar" becomes "AI Coach Top Bar".
const splitCamelCase = (text) => text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

function humanize(id) {
  const spaced = splitCamelCase(id).replace(/[-_]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Returns a function mapping a text offset to its 1-based line; the line table is built on first use.
function memoLineIndex(text) {
  let starts = null;
  return (index) => {
    if (starts === null) {
      starts = [0];
      for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    }
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

/* ───────────── Reading files ───────────── */

function readSource(fileAbs, file, rel) {
  try {
    const stat = fs.statSync(fileAbs);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    // CRLF checkouts must hash like LF ones, or the same code would differ between machines.
    const text = fs.readFileSync(fileAbs, 'utf8').replace(/\r\n/g, '\n');
    return { file, rel, text, bytes: Buffer.byteLength(text), sha1: sha1(text) };
  } catch {
    return null;
  }
}

// Walks sourceGlobs plus the route directories (so every page file is known), plus a root-level middleware
// (a glob without a folder would make walk() enter every directory).
function loadSources(rootAbs, cfg, prefix) {
  const baseAbs = path.join(rootAbs, ...prefix.split('/'));
  const routeGlobs = cfg.routeDirs.map(toPosix).filter(Boolean).map((dir) => `${dir}/**`);
  const rels = new Set(walk(baseAbs, { include: [...cfg.sourceGlobs, ...routeGlobs], exclude: cfg.ignore }));
  for (const name of ROOT_MIDDLEWARE) if (!matchAny(cfg.ignore, name)) rels.add(name);
  const sources = [];
  for (const rel of [...rels].filter((entry) => SOURCE_FILE.test(entry)).sort(compareStrings)) {
    const source = readSource(path.join(baseAbs, rel), `${prefix}${rel}`, rel);
    if (source) sources.push(source);
  }
  return sources;
}

/* ───────────── Imports ───────────── */

const IMPORT_FROM = /\bimport\s+([\w$*{},\s]+?)\s*\bfrom\s*(['"])([^'"\n]+)\2/g;
const EXPORT_FROM = /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\1/g;
const NAMED_REEXPORT = /\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"\n]+)\2/g;
const BARE_IMPORT = /\bimport\s*(['"])([^'"\n]+)\1/g;
const CALL_IMPORT = /\b(?:import|require)\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
const LAZY_BINDING = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\w+\.)?lazy\s*\(\s*\(\s*\)\s*=>\s*import\s*\(\s*(['"])([^'"\n]+)\2/g;

const captures = (text, regex, group) => [...text.matchAll(regex)].map((match) => match[group]);

function importSpecifiers(text) {
  return [
    ...captures(text, IMPORT_FROM, 3),
    ...captures(text, EXPORT_FROM, 2),
    ...captures(text, BARE_IMPORT, 2),
    ...captures(text, CALL_IMPORT, 2),
  ];
}

// "React, { useState as s }" or "* as NS": the local names a clause binds and what each one imports ('default', '*' or a name).
function clauseBindings(clause) {
  const body = clause.replace(/^\s*type\s+/, '');
  const named = [...body.matchAll(/\{([^}]*)\}/g)].flatMap((match) => match[1].split(',')).map((part) => {
    const [imported, local = imported] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
    return { local, imported };
  });
  const rest = body.replace(/\{[^}]*\}/g, '').split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const namespace = /^\*\s*as\s+(.+)$/.exec(part);
    return namespace ? { local: namespace[1], imported: '*' } : { local: part, imported: 'default' };
  });
  return [...named, ...rest].filter(({ local }) => /^[A-Za-z_$][\w$]*$/.test(local));
}

// Local name to where it came from; lazy(() => import('./X')) counts as a default import of its const.
function importBindings(text) {
  const bindings = new Map();
  for (const match of text.matchAll(IMPORT_FROM)) {
    for (const { local, imported } of clauseBindings(match[1])) bindings.set(local, { specifier: match[3], imported });
  }
  for (const match of text.matchAll(LAZY_BINDING)) bindings.set(match[1], { specifier: match[3], imported: 'default' });
  return bindings;
}

function* resolutionCandidates(base) {
  yield base;
  for (const ext of RESOLVE_EXTENSIONS) yield `${base}${ext}`;
  for (const ext of RESOLVE_EXTENSIONS) yield path.posix.join(base, `index${ext}`);
  // TypeScript ESM writes "./a.js" for a.ts
  const stem = base.replace(/\.[cm]?jsx?$/, '');
  if (stem !== base) for (const ext of ['.ts', '.tsx']) yield `${stem}${ext}`;
}

/**
 * Builds the specifier resolver: relative paths and the '@/' alias, checked only against the scanned file set.
 *
 * @param {Set<string>} fileSet Scanned repo-relative files.
 * @param {string} srcPrefix What '@/' stands for, e.g. "src/" or "web/src/".
 * @returns {(fromFile: string, specifier: string) => string | null}
 */
function makeResolver(fileSet, srcPrefix) {
  return (fromFile, specifier) => {
    let base;
    if (specifier.startsWith('@/')) base = path.posix.normalize(`${srcPrefix}${specifier.slice(2)}`);
    else if (specifier.startsWith('.')) base = path.posix.join(path.posix.dirname(fromFile), specifier);
    else return null;
    if (base === '..' || base.startsWith('../')) return null;
    for (const candidate of resolutionCandidates(base)) if (fileSet.has(candidate)) return candidate;
    return null;
  };
}

// Follows `export { Name } from './Name'` through barrel files so a page points at the component, not at index.ts.
function followReexport(file, name, resolve, textOf, depth = 3) {
  if (depth === 0 || name === '*') return file;
  for (const match of textOf(file).matchAll(NAMED_REEXPORT)) {
    for (const part of match[1].split(',')) {
      const [original, exported = original] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      if (exported !== name) continue;
      const next = resolve(file, match[3]);
      return next === null ? file : followReexport(next, original, resolve, textOf, depth - 1);
    }
  }
  return file;
}

function buildImports(codeSources, resolve) {
  const entries = [];
  for (const { file, text } of codeSources) {
    const targets = sortedUnique(importSpecifiers(text).map((specifier) => resolve(file, specifier)).filter((target) => target && target !== file));
    if (targets.length > 0) entries.push([file, targets]);
  }
  return sortedObject(entries);
}

/* ───────────── Pages and areas ───────────── */

const COMPONENT_REF = /\belement\s*[:=]\s*\{?\s*<\s*([A-Za-z_$][\w$]*)|\b[Cc]omponent\s*[:=]\s*\{?\s*([A-Za-z_$][\w$]*)/;

function areaOf(route) {
  const first = route.split('/')[1] ?? '';
  if (first === '') return HOME_AREA;
  return first.startsWith(':') ? 'other' : first;
}

// Text from each `path` token up to the next one: every route definition starts a segment, and a segment holds at most one,
// so the component named after a path can never belong to the next route.
function pathSegments(text) {
  const starts = [...text.matchAll(/\bpath\b/g)].map((match) => match.index);
  return starts.map((start, i) => text.slice(start, starts[i + 1] ?? text.length));
}

function resolveComponent(segment, bindings, file, resolve, textOf) {
  const match = COMPONENT_REF.exec(segment.slice(0, COMPONENT_LOOKAHEAD));
  const binding = bindings.get(match?.[1] ?? match?.[2]);
  const target = binding === undefined ? null : resolve(file, binding.specifier);
  return target === null ? null : followReexport(target, binding.imported, resolve, textOf);
}

// `resolved` is false when the component could not be followed and the defining file stands in for it.
function routerPages({ file, text }, definitions, resolve, textOf) {
  if (definitions.length === 0) return [];
  const bindings = importBindings(text);
  const pages = [];
  for (const segment of pathSegments(text)) {
    const [route] = extractDefinitions(segment);
    if (route === undefined) continue;
    const component = resolveComponent(segment, bindings, file, resolve, textOf);
    pages.push({ resolved: component !== null, page: { route, file: component ?? file, source: 'router', area: areaOf(route) } });
  }
  return pages;
}

// For a route defined more than once the first wins, in this order: Next file routes, router definitions whose component
// was found (a nav menu's `{ path: '/x' }` must not beat the real page), then the rest; each group in file order.
function collectPages(rootAbs, cfg, routerCandidates) {
  const candidates = [];
  if (isNextProject(rootAbs, cfg)) {
    for (const { file, route } of listRouteFiles(rootAbs, cfg)) {
      const normalized = normalizeRoute(route);
      candidates.push({ route: normalized, file, source: 'next', area: areaOf(normalized) });
    }
  }
  for (const wantResolved of [true, false]) {
    for (const { resolved, page } of routerCandidates) if (resolved === wantResolved) candidates.push(page);
  }
  const byRoute = new Map();
  for (const page of candidates) if (!byRoute.has(page.route)) byRoute.set(page.route, page);
  return [...byRoute.values()].sort((a, b) => compareStrings(a.route, b.route) || compareStrings(a.file, b.file));
}

function buildAreas(pages) {
  const routesByArea = new Map();
  for (const { area, route } of pages) routesByArea.set(area, [...(routesByArea.get(area) ?? []), route]);
  return [...routesByArea]
    .map(([id, routes]) => ({ id, title: humanize(id), routes: sortedUnique(routes) }))
    .sort((a, b) => compareStrings(a.id, b.id));
}

/* ───────────── Links ───────────── */

const TEMPLATE_EXPRESSION = /\$\{[^}]*\}/g;
const NAV_TARGET = /(?:\b(?:href|to)\s*=\s*\{?\s*|\b(?:navigate|redirect|router\.(?:push|replace))\s*\(\s*)(['"`])(\/[^'"`\s]*)\1/g;

function cleanRoute(literal) {
  return literal.startsWith('//') ? null : normalizeRoute(literal.replace(/[?#].*$/, ''));
}

// Navigation calls and attributes always count. Other quoted routes count unless the file only defines them
// (a router config mentions every route without linking to any).
function linkTargets(text, definitions) {
  const prepared = text.replace(TEMPLATE_EXPRESSION, ':param');
  const defined = new Set(definitions);
  const targets = new Set(captures(prepared, NAV_TARGET, 2).map(cleanRoute).filter(Boolean));
  for (const route of extractMentions(prepared)) if (!defined.has(route)) targets.add(route);
  return targets;
}

// Keeps only links to routes that are pages; sorted by file, then route.
function knownLinks(targetsByFile, pageRoutes) {
  const links = [];
  for (const [from, targets] of targetsByFile) {
    for (const to of targets) if (pageRoutes.has(to)) links.push({ from, to });
  }
  return links.sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to));
}

/* ───────────── Items ───────────── */

const FORM_RULES = [
  { re: /<form(?=[\s>/])/, detail: '<form>' },
  { re: /\bonSubmit\s*=/, detail: 'onSubmit handler' },
  { re: /\bhandleSubmit\s*\(/, detail: 'handleSubmit()' },
  { re: /\buseForm\s*\(/, detail: 'useForm()' },
  { re: /^[ \t]*(['"])use server\1/m, detail: "'use server' actions" },
];
const AUTH_PATH_RULES = [{ re: /^(?:src\/)?middleware\.[cm]?[jt]s$/, detail: 'middleware' }];
const AUTH_RULES = [
  { re: /\b(redirect|navigate)\s*\(\s*(['"`])(\/(?:login|sign-?in)\b[^'"`]*)\2/, detail: (m) => `${m[1]} to ${m[3]}` },
  { re: /\b(useAuth|withAuth)\s*\(/, detail: (m) => `${m[1]}()` },
  { re: /\brequireAuth\b/, detail: 'requireAuth' },
  { re: /<(SignedIn|Protected\w*)/, detail: (m) => `<${m[1]}>` },
  { re: /\bProtectedRoute\b/, detail: 'ProtectedRoute' },
];
const EMAIL_PATH_RULES = [{ re: /(?:^|\/)emails\//, detail: 'email template' }];
const EMAIL_RULES = [
  { re: /\bsendEmail\s*\(/, detail: 'sendEmail()' },
  { re: /\bresend\.emails\.send\s*\(/, detail: 'resend.emails.send()' },
  { re: /nodemailer/i, detail: 'nodemailer' },
  { re: /sendgrid/i, detail: 'sendgrid' },
];
const JOB_PATH_RULES = [{ re: /(?:^|\/)(?:jobs|workers|cron)\//, detail: 'background job' }];
const JOB_RULES = [
  { re: /\bcron\.schedule\s*\(/, detail: 'cron.schedule()' },
  { re: /\bschedule\s*\(/, detail: 'schedule()' },
];
const LAMBDA_DIR = /(?:^|\/)lambda\//;
const LAMBDA_HANDLER_RULE = { re: /\bexport\s+(?:const|async\s+function|function)\s+handler\b/, detail: 'lambda handler' };

const FETCH_CALL = /\bfetch\s*\(\s*(['"`])([^'"`\n]+)\1/g;
const HTTP_CLIENT_CALL = /\b(?:axios|api)\.(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`\n]+)\2/g;
const QUERY_HOOK = /\.(useQuery|useMutation)\s*\(/g;
const ROUTE_DEFINITION = /\b(?:app|[\w$]*[rR]outer)\.(get|post|put|patch|delete)\s*\(\s*(['"`])(\/[^'"`\n]*)\2/g;
const PAGES_API_FILE = /(?:^|\/)pages\/(api\/.+)\.[cm]?[jt]sx?$/;
const ROUTE_HANDLER_FILE = /(?:^|\/)route\.[cm]?[jt]sx?$/;
const NEXT_HANDLER_EXPORT = /\bexport\s+(?:async\s+)?(?:function\*?\s+|(?:const|let|var)\s+)(GET|POST|PUT|PATCH|DELETE)\b/g;
const NEXT_EXPORT_LIST = /\bexport\s*\{([^}]*)\}/g;
const HTTP_METHOD = /\b(GET|POST|PUT|PATCH|DELETE)\b/g;

const PRISMA_MODEL = /^[ \t]*model\s+(\w+)\s*\{/gm;
const SQL_TABLE = /\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([\w.]+)/gi;
const ZOD_SCHEMA = /\bexport\s+const\s+(\w+?)Schema\s*=\s*z\.object\s*\(/g;

const toItem = (kind, ctx, index, detail) => ({ kind, file: ctx.file, line: ctx.lineOf(index), detail: capDetail(detail) });

// Earliest match among the rules (regexes must not be global).
function firstHit(text, rules) {
  let best = null;
  for (const { re, detail } of rules) {
    const match = re.exec(text);
    if (match && (best === null || match.index < best.index)) {
      best = { index: match.index, detail: typeof detail === 'function' ? detail(match) : detail };
    }
  }
  return best;
}

// Kinds where the whole file is one thing (a form, a guard, an email, a job): one item at the earliest evidence.
function fileItem(kind, ctx, pathRules, textRules) {
  const pathRule = pathRules.find(({ re }) => re.test(ctx.rel));
  const hit = pathRule ? { index: 0, detail: pathRule.detail } : firstHit(ctx.text, textRules);
  return hit ? [toItem(kind, ctx, hit.index, hit.detail)] : [];
}

// Kinds where every match is its own thing; `describe(match, text)` returns its detail.
function matchItems(kind, ctx, regex, describe) {
  return [...ctx.text.matchAll(regex)].map((match) => toItem(kind, ctx, match.index, describe(match, ctx.text)));
}

function fetchMethod(text, match) {
  const start = match.index + match[0].length;
  const options = text.slice(start, start + 160).split('fetch(')[0];
  return (/\bmethod\s*:\s*['"`](\w+)['"`]/.exec(options)?.[1] ?? 'GET').toUpperCase();
}

// "trpc.orders.list" in front of ".useQuery(".
const callChainBefore = (text, index) => /[\w$.]*$/.exec(text.slice(Math.max(0, index - 120), index))[0];

function apiCallItems(ctx) {
  return [
    ...matchItems('api-call', ctx, FETCH_CALL, (m, text) => `${fetchMethod(text, m)} ${m[2]}`),
    ...matchItems('api-call', ctx, HTTP_CLIENT_CALL, (m) => `${m[1].toUpperCase()} ${m[3]}`),
    ...matchItems('api-call', ctx, QUERY_HOOK, (m, text) => `${callChainBefore(text, m.index)}.${m[1]}()`),
  ];
}

// "app/(shop)/api/pay/route.ts" gives "/api/pay"; only folders listed in routeDirs named "app" count.
function nextAppRouteUrl(rel, appDirs) {
  const dir = appDirs.find((candidate) => rel.startsWith(`${candidate}/`));
  if (dir === undefined || !ROUTE_HANDLER_FILE.test(rel)) return null;
  const segments = rel.slice(dir.length + 1).split('/').slice(0, -1);
  return normalizeRoute(segments.filter((segment) => !/^\(.*\)$/.test(segment) && !segment.startsWith('@')).join('/'));
}

function nextHandlerExports(text) {
  const found = [...text.matchAll(NEXT_HANDLER_EXPORT)].map((match) => ({ index: match.index, method: match[1] }));
  for (const list of text.matchAll(NEXT_EXPORT_LIST)) {
    for (const name of list[1].matchAll(HTTP_METHOD)) found.push({ index: list.index, method: name[1] });
  }
  return found;
}

function endpointItems(ctx) {
  const items = matchItems('endpoint', ctx, ROUTE_DEFINITION, (m) => `${m[1].toUpperCase()} ${m[3]}`);
  const pagesApi = PAGES_API_FILE.exec(ctx.rel);
  if (pagesApi) items.push(toItem('endpoint', ctx, 0, `API route ${normalizeRoute(`/${pagesApi[1]}`.replace(/\/index$/, ''))}`));
  const url = nextAppRouteUrl(ctx.rel, ctx.appDirs);
  if (url !== null) for (const { index, method } of nextHandlerExports(ctx.text)) items.push(toItem('endpoint', ctx, index, `${method} ${url}`));
  return items;
}

function sourceItems(source, appDirs) {
  const ctx = { ...source, appDirs, lineOf: memoLineIndex(source.text) };
  if (ctx.file.endsWith('.prisma')) return matchItems('model', ctx, PRISMA_MODEL, (m) => `model ${m[1]}`);
  if (ctx.file.endsWith('.sql')) return matchItems('model', ctx, SQL_TABLE, (m) => `table ${m[1]}`);
  const jobRules = LAMBDA_DIR.test(ctx.rel) ? [...JOB_RULES, LAMBDA_HANDLER_RULE] : JOB_RULES;
  return [
    ...fileItem('form', ctx, [], FORM_RULES),
    ...apiCallItems(ctx),
    ...endpointItems(ctx),
    ...fileItem('auth-guard', ctx, AUTH_PATH_RULES, AUTH_RULES),
    ...fileItem('email', ctx, EMAIL_PATH_RULES, EMAIL_RULES),
    ...fileItem('job', ctx, JOB_PATH_RULES, jobRules),
    ...matchItems('model', ctx, ZOD_SCHEMA, (m) => `schema ${m[1]}`),
  ];
}

// Sorted, with repeats of the same thing in one file (same kind and detail) reduced to the first.
function finalizeItems(items) {
  const sorted = items.sort((a, b) => compareStrings(a.file, b.file) || a.line - b.line || compareStrings(a.kind, b.kind) || compareStrings(a.detail, b.detail));
  const seen = new Set();
  return sorted.filter((item) => {
    const key = `${item.file}\0${item.kind}\0${item.detail}`;
    return seen.has(key) ? false : seen.add(key);
  });
}

/* ───────────── Git ───────────── */

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

// ".git" in rootAbs or the nearest ancestor; a ".git" file ("gitdir: …") is a worktree or submodule pointing at the real folder.
function findGitDir(rootAbs) {
  let dir = path.resolve(rootAbs);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    const stat = statOrNull(dotGit);
    if (stat?.isDirectory()) return dotGit;
    if (stat?.isFile()) {
      const target = /^gitdir:\s*(.+)$/m.exec(readTextOrNull(dotGit) ?? '')?.[1].trim();
      if (target) return path.resolve(dir, target);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// A worktree keeps HEAD in its own folder but branches and packed-refs in the shared one named by "commondir".
function resolveRef(gitDir, ref) {
  if (!ref.startsWith('refs/') || ref.includes('..')) return null;
  const commonRelative = readTextOrNull(path.join(gitDir, 'commondir'))?.trim();
  const dirs = [...new Set([gitDir, commonRelative ? path.resolve(gitDir, commonRelative) : gitDir])];
  for (const dir of dirs) {
    const loose = readTextOrNull(path.join(dir, ...ref.split('/')))?.trim();
    if (loose && SHA.test(loose)) return loose;
  }
  for (const dir of dirs) {
    for (const line of (readTextOrNull(path.join(dir, 'packed-refs')) ?? '').split('\n')) {
      const [sha, name] = line.trim().split(' ');
      if (name === ref && SHA.test(sha)) return sha;
    }
  }
  return null;
}

/**
 * Reads the current commit straight from the .git folder (never spawns git).
 * Handles branches (loose or packed refs), a detached HEAD, and worktrees/submodules whose `.git` is a file.
 *
 * @param {string} rootAbs Absolute directory inside a repository; the nearest ancestor with `.git` is used.
 * @returns {string | null} Commit sha, or null when there is no repository, an unborn branch or an unreadable HEAD.
 */
export function readGitHead(rootAbs) {
  const gitDir = findGitDir(rootAbs);
  if (gitDir === null) return null;
  const head = readTextOrNull(path.join(gitDir, 'HEAD'))?.trim();
  if (!head) return null;
  const ref = /^ref:\s*(.+)$/.exec(head);
  if (ref) return resolveRef(gitDir, ref[1].trim());
  return SHA.test(head) ? head : null;
}

/* ───────────── buildInventory ───────────── */

/**
 * Scans the code without AI and lists what a user can reach and touch.
 *
 * Scans `config.sourceGlobs` (relative to `config.root`) plus the route directories and a root-level
 * `middleware.*`, minus `config.ignore`; reads .js/.jsx/.ts/.tsx/.mjs/.cjs for code and .prisma/.sql for models.
 * Files over 1 MB are skipped, and CRLF is read as LF so hashes match across operating systems.
 * Pages come from Next route files (only in a Next project) and from router definitions (`path: '/x'`), whose rendered
 * component is followed through the file's imports. Everything is sorted, so the same code gives byte-identical JSON.
 *
 * @param {string} rootAbs Absolute repo root.
 * @param {Partial<Config>} [config] Merged over DEFAULT_CONFIG.
 * @returns {Inventory} The inventory; all paths are repo-relative with "/" separators.
 */
export function buildInventory(rootAbs, config = DEFAULT_CONFIG) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const rootDir = toPosix(cfg.root);
  const prefix = rootDir ? `${rootDir}/` : '';
  const sources = loadSources(rootAbs, cfg, prefix);
  const textByFile = new Map(sources.map((source) => [source.file, source.text]));
  const resolve = makeResolver(new Set(textByFile.keys()), `${prefix}src/`);
  const textOf = (file) => textByFile.get(file) ?? '';
  const appDirs = cfg.routeDirs.map(toPosix).filter((dir) => dir.split('/').at(-1) === 'app');

  const codeSources = sources.filter((source) => CODE_FILE.test(source.file));
  const routerCandidates = [];
  const linkTargetsByFile = [];
  for (const source of codeSources) {
    const definitions = extractDefinitions(source.text);
    routerCandidates.push(...routerPages(source, definitions, resolve, textOf));
    linkTargetsByFile.push([source.file, linkTargets(source.text, definitions)]);
  }
  const pages = collectPages(rootAbs, cfg, routerCandidates);

  return {
    version: 1,
    head: readGitHead(rootAbs),
    pages,
    links: knownLinks(linkTargetsByFile, new Set(pages.map((page) => page.route))),
    items: finalizeItems(sources.flatMap((source) => sourceItems(source, appDirs))),
    imports: buildImports(codeSources, resolve),
    areas: buildAreas(pages),
    files: sortedObject(sources.map((source) => [source.file, { bytes: source.bytes, sha1: source.sha1 }])),
  };
}

/* ───────────── planUnits ───────────── */

const VENDOR_FILE = /(?:^|\/)node_modules\//;

// Files reachable through imports from the seeds, breadth-first; files for which `skip` is true are neither listed nor followed.
function reachableFiles(seeds, imports, skip = () => false) {
  const visited = new Set(seeds);
  const order = [];
  for (let i = 0; i < seeds.length + order.length; i++) {
    const file = i < seeds.length ? seeds[i] : order[i - seeds.length];
    for (const dep of imports[file] ?? []) {
      if (visited.has(dep)) continue;
      visited.add(dep);
      if (!skip(dep)) order.push(dep);
    }
  }
  return order;
}

// Files reached from more than 30% of all page files (layouts, UI kits) belong to every unit and to none in particular.
function sharedFiles(inventory) {
  const pageFiles = sortedUnique(inventory.pages.map((page) => page.file));
  const reachedBy = new Map();
  for (const pageFile of pageFiles) {
    for (const file of reachableFiles([pageFile], inventory.imports)) reachedBy.set(file, (reachedBy.get(file) ?? 0) + 1);
  }
  const shared = new Set();
  for (const [file, count] of reachedBy) {
    if (count >= MIN_SHARED_PAGES && count / pageFiles.length > SHARED_FRACTION) shared.add(file);
  }
  return shared;
}

// Greedy groups of pages whose distinct files fit the budget; a single page larger than the budget gets a group of its own.
function splitPages(pages, sizeOf, budgetBytes) {
  const groups = [];
  let current = [];
  let files = new Set();
  let bytes = 0;
  for (const page of pages) {
    const extra = files.has(page.file) ? 0 : sizeOf(page.file);
    if (current.length > 0 && bytes + extra > budgetBytes) {
      groups.push(current);
      current = [];
      files = new Set();
      bytes = 0;
    }
    current.push(page);
    if (!files.has(page.file)) {
      files.add(page.file);
      bytes += sizeOf(page.file);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

const MIN_VIEW_TOKENS = 3000;
// Folders that only hold the feature folders, so the feature key is the folder below them.
const VIEW_CONTAINERS = new Set(['src', 'pages', 'components', 'features', 'modules', 'views', 'widgets']);
// Feature keys that are plumbing rather than something a user sees.
const INFRA_KEYS = new Set([
  'stores', 'store', 'hooks', 'api', 'util', 'utils', 'lib', 'services', 'types', 'constants', 'config', 'styles', 'theme',
  'assets', 'icons', 'i18n', 'locales', 'test', 'tests', '__tests__', 'mocks', 'contexts', 'context', 'helpers',
]);

const sumBytes = (files, sizeOf) => files.reduce((sum, file) => sum + sizeOf(file), 0);

function slugOf(text) {
  const slug = splitCamelCase(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'view';
}

// The feature a file belongs to: the first folder below the folder of the page that owns it, or below a components/features/
// modules/views/widgets (or pages) folder; a file sitting directly in one of those is keyed by its name.
function viewKey(file, pageDirs) {
  const owner = pageDirs.filter((dir) => dir === '' || file.startsWith(`${dir}/`)).sort((a, b) => b.length - a.length)[0];
  const relative = owner === undefined ? file.replace(/^(?:.*?\/)?src\//, '') : file.slice(owner === '' ? 0 : owner.length + 1);
  const segments = relative.split('/');
  return segments.slice(0, -1).find((dir) => !VIEW_CONTAINERS.has(dir.toLowerCase())) ?? segments.at(-1).replace(/\.[^.]*$/, '');
}

// Greedy chunks of files, in order, each within the capacity (a single file bigger than that gets a chunk of its own).
function packFiles(files, sizeOf, capacityBytes) {
  const chunks = [];
  let current = [];
  let bytes = 0;
  for (const file of files) {
    if (current.length > 0 && bytes + sizeOf(file) > capacityBytes) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += sizeOf(file);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// Seeds, then imports in order while the budget holds; stops at the first file that does not fit.
function fitFiles(seeds, imported, plan) {
  const files = [...seeds];
  let bytes = sumBytes(seeds, plan.sizeOf);
  for (const file of imported) {
    if (bytes + plan.sizeOf(file) > plan.budgetBytes) break;
    files.push(file);
    bytes += plan.sizeOf(file);
  }
  return files;
}

// Infra files a chunk imports directly, added after it while budget remains (one that does not fit is skipped).
function withInfra(seeds, chunk, infra, plan) {
  const files = [...seeds, ...chunk];
  let bytes = sumBytes(files, plan.sizeOf);
  const have = new Set(files);
  for (const file of chunk) {
    for (const dep of plan.imports[file] ?? []) {
      if (!infra.has(dep) || have.has(dep) || bytes + plan.sizeOf(dep) > plan.budgetBytes) continue;
      have.add(dep);
      files.push(dep);
      bytes += plan.sizeOf(dep);
    }
  }
  return files;
}

// One draft per feature of a page too big for one unit: biggest first, tiny ones merged into "Other parts", and a feature too big for
// the budget split into parts. Returns null when the closure holds no feature files at all.
function viewDrafts(seeds, closure, plan) {
  const pageDirs = seeds.map((seed) => seed.split('/').slice(0, -1).join('/'));
  const infra = new Set();
  const byKey = new Map();
  for (const file of closure) {
    const key = viewKey(file, pageDirs);
    if (INFRA_KEYS.has(key.toLowerCase())) infra.add(file);
    else byKey.set(key, [...(byKey.get(key) ?? []), file]);
  }
  if (byKey.size === 0) return null;

  const views = [...byKey].map(([key, files]) => ({ key, label: humanize(key), files, bytes: sumBytes(files, plan.sizeOf) }))
    .sort((a, b) => b.bytes - a.bytes || compareStrings(a.key, b.key));
  const small = views.filter((view) => view.bytes < plan.minViewBytes);
  if (small.length > 1) {
    const merged = new Set(small.flatMap((view) => view.files));
    views.splice(views.length - small.length, small.length, { key: 'other-parts', label: 'Other parts', files: closure.filter((file) => merged.has(file)) });
  }

  const capacity = Math.max(plan.budgetBytes - sumBytes(seeds, plan.sizeOf), 0);
  return views.flatMap((view) => {
    const chunks = packFiles(view.files, plan.sizeOf, capacity);
    return chunks.map((chunk, i) => ({
      suffix: `-${slugOf(view.key)}${i > 0 ? `-${i + 1}` : ''}`,
      label: chunks.length > 1 ? `${view.label} (part ${i + 1} of ${chunks.length})` : view.label,
      files: withInfra(seeds, chunk, infra, plan),
    }));
  });
}

// What to hand out for one group of pages: a single unit when everything they reach fits, otherwise one per feature.
function unitDrafts(seeds, plan) {
  const closure = reachableFiles(seeds, plan.imports, plan.skip);
  if (sumBytes(seeds, plan.sizeOf) + sumBytes(closure, plan.sizeOf) <= plan.budgetBytes) return [{ suffix: '', label: '', files: [...seeds, ...closure] }];
  return viewDrafts(seeds, closure, plan) ?? [{ suffix: '', label: '', files: fitFiles(seeds, closure, plan) }];
}

/**
 * Cuts the inventory into work units small enough for a single AI helper.
 *
 * Each unit lists its pages' files first, then their transitive imports in breadth-first order. Files reached from more
 * than 30% of all page files (and from at least 3 pages), and anything under node_modules, are left out. An area whose
 * page files alone exceed `maxTokens` (bytes / 4) is split into several units (`area-shop`, `area-shop-2`, …, titled
 * "Shop (part 2 of 3)"); a single page bigger than the budget still gets its file, so such a unit can exceed the budget.
 *
 * When everything a page reaches does not fit (a single-page app whose tabs and panels all hang off one route), the unit
 * is cut into views instead: files are grouped by feature (the first folder below the page's folder, or below
 * components/features/modules/views/widgets; a file directly in one is keyed by its name). Each view becomes a unit titled
 * "Contacts · People" with id `area-contacts-people` that starts with the page file, then the view's files, then the
 * infra files (stores, hooks, api, util, types, …) those files import directly while budget remains. Views come biggest
 * first; those under `minViewTokens` are merged into "Other parts"; a view over budget is split into parts.
 *
 * Area units are named `<prefix>-<areaId>…`; gap and refresh units are numbered `<prefix>-1`, `-2`, … in area order.
 *
 * @param {Inventory} inventory
 * @param {PlanOptions} [options]
 * @returns {WorkUnit[]} Units ordered by area id, then part; `estTokens` is always the size of the unit's own files.
 */
export function planUnits(inventory, { maxTokens = PIPELINE.UNIT_MAX_TOKENS, routes, kind = 'area', idPrefix, minViewTokens = MIN_VIEW_TOKENS } = {}) {
  const wanted = routes ? new Set(routes.map(normalizeRoute)) : null;
  const shared = sharedFiles(inventory);
  const sizeOf = (file) => inventory.files[file]?.bytes ?? 0;
  const plan = {
    imports: inventory.imports,
    skip: (file) => shared.has(file) || VENDOR_FILE.test(file),
    sizeOf,
    budgetBytes: maxTokens * BYTES_PER_TOKEN,
    minViewBytes: minViewTokens * BYTES_PER_TOKEN,
  };
  const titles = new Map((inventory.areas ?? []).map((area) => [area.id, area.title]));
  const prefix = idPrefix ?? kind;
  const pages = inventory.pages.filter((page) => !wanted || wanted.has(page.route));

  const usedIds = new Set();
  const claimId = (id) => {
    let candidate = id;
    for (let n = 2; usedIds.has(candidate); n++) candidate = `${id}-v${n}`;
    usedIds.add(candidate);
    return candidate;
  };

  const units = [];
  for (const areaId of sortedUnique(pages.map((page) => page.area))) {
    const areaPages = pages.filter((page) => page.area === areaId).sort((a, b) => compareStrings(a.route, b.route));
    const groups = splitPages(areaPages, sizeOf, plan.budgetBytes);
    groups.forEach((group, i) => {
      const seeds = [...new Set(group.map((page) => page.file))];
      const areaTitle = titles.get(areaId) ?? humanize(areaId);
      const title = groups.length > 1 ? `${areaTitle} (part ${i + 1} of ${groups.length})` : areaTitle;
      for (const draft of unitDrafts(seeds, plan)) {
        const id = kind === 'area' ? claimId(`${prefix}-${areaId}${i > 0 ? `-${i + 1}` : ''}${draft.suffix}`) : `${prefix}-${units.length + 1}`;
        units.push({
          id,
          kind,
          area: areaId,
          title: draft.label ? `${title} · ${draft.label}` : title,
          routes: group.map((page) => page.route),
          files: draft.files,
          estTokens: estTokens(sumBytes(draft.files, sizeOf)),
        });
      }
    });
  }
  return units;
}

/* ───────────── coverage ───────────── */

function bucket(keys, isCovered) {
  const unique = sortedUnique(keys);
  const missing = unique.filter((key) => !isCovered(key));
  return { covered: unique.length - missing.length, total: unique.length, missing };
}

// What the map points at: normalized routes (screens and route anchors) and repo-relative files (file anchors and detail.files).
function mapReferences(doc) {
  const routes = new Set();
  const files = new Set();
  for (const journey of doc?.journeys ?? []) {
    for (const step of journey.steps ?? []) {
      if (step.screen) routes.add(normalizeRoute(step.screen));
      const { type, value } = step.anchor ?? {};
      if (type === 'route' && value) routes.add(normalizeRoute(value));
      if (type === 'file' && value) files.add(toPosix(value));
      for (const file of step.detail?.files ?? []) files.add(toPosix(file));
    }
  }
  return { routes, files };
}

/**
 * Measures how much of the inventory the map explains.
 *
 * - page: covered when a step's screen or route anchor equals its route, or a step's file anchor / detail.files names its file.
 * - form (counted by file): covered when its file is named by a step, or lies within two import hops of a covered page's file.
 * - endpoint (counted by "file: detail"): covered when its file is named by a step.
 * `percent` is covered pages over all pages (100 when there are none). Missing lists are sorted.
 *
 * @param {JourneysDoc} doc The map.
 * @param {Inventory} inventory
 * @returns {Coverage}
 */
export function coverage(doc, inventory) {
  const { routes, files } = mapReferences(doc);
  const pageCovered = (page) => routes.has(normalizeRoute(page.route)) || files.has(page.file);
  const coveredPages = inventory.pages.filter(pageCovered);

  const nearCoveredPages = new Set(coveredPages.map((page) => page.file));
  let frontier = [...nearCoveredPages];
  for (let hop = 0; hop < FORM_IMPORT_DEPTH; hop++) {
    frontier = frontier.flatMap((file) => inventory.imports[file] ?? []).filter((dep) => !nearCoveredPages.has(dep));
    for (const dep of frontier) nearCoveredPages.add(dep);
  }

  const itemsOf = (kind) => inventory.items.filter((item) => item.kind === kind);
  const endpoints = itemsOf('endpoint').map((item) => ({ key: `${item.file}: ${item.detail}`, file: item.file }));
  const fileOfEndpoint = new Map(endpoints.map(({ key, file }) => [key, file]));

  const coveredRoutes = new Set(coveredPages.map((page) => page.route));
  return {
    pages: bucket(inventory.pages.map((page) => page.route), (route) => coveredRoutes.has(route)),
    forms: bucket(itemsOf('form').map((item) => item.file), (file) => files.has(file) || nearCoveredPages.has(file)),
    endpoints: bucket([...fileOfEndpoint.keys()], (key) => files.has(fileOfEndpoint.get(key))),
    percent: inventory.pages.length === 0 ? 100 : Math.round((coveredPages.length / inventory.pages.length) * 100),
  };
}

/* ───────────── diffInventory ───────────── */

/**
 * Compares two inventories.
 *
 * @param {Inventory | null | undefined} before The earlier inventory; null or undefined counts as empty.
 * @param {Inventory} after
 * @returns {{ newPages: string[], removedPages: string[], changedFiles: string[], headChanged: boolean }}
 *   Routes added and removed; files added, removed or whose sha1 differs; whether the git HEAD moved. All lists sorted.
 */
export function diffInventory(before, after) {
  const beforeRoutes = new Set((before?.pages ?? []).map((page) => page.route));
  const afterRoutes = new Set(after.pages.map((page) => page.route));
  const beforeFiles = before?.files ?? {};
  const changedFiles = sortedUnique([...Object.keys(beforeFiles), ...Object.keys(after.files)])
    .filter((file) => beforeFiles[file]?.sha1 !== after.files[file]?.sha1);
  return {
    newPages: [...afterRoutes].filter((route) => !beforeRoutes.has(route)).sort(compareStrings),
    removedPages: [...beforeRoutes].filter((route) => !afterRoutes.has(route)).sort(compareStrings),
    changedFiles,
    headChanged: (before?.head ?? null) !== (after.head ?? null),
  };
}
