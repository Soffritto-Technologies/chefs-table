import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG } from './types.mjs';
import { walk, matchAny } from './glob.mjs';

/** @typedef {import('./types.mjs').Config} Config */
/** @typedef {import('./types.mjs').AnchorState} AnchorState */
/** @typedef {import('./types.mjs').JourneysDoc} JourneysDoc */
/** @typedef {import('./types.mjs').Step} Step */

/**
 * @typedef {object} FileEntry
 * What one scanned source file contributes; rescanned only when its mtime changes.
 * @property {number} mtimeMs
 * @property {string[]} defs      Normalized routes the file defines.
 * @property {string[]} mentions  Normalized routes the file mentions as string literals.
 */

/**
 * @typedef {object} AnchorCache
 * Plain JSON, safe to persist between turns. checkAnchors takes one in and returns an updated copy;
 * that same object is the `ctx` for filesForStep.
 * @property {Record<string, FileEntry>} [files]                  Indexed source files by repo-relative path; only files with a definition or mention are kept.
 * @property {boolean} [indexed]                                  True once sourceGlobs were walked; later calls update the index from `changedFiles` instead.
 * @property {Array<{ file: string, route: string }>} [routeFiles] Next route files from the last listing.
 * @property {Record<string, AnchorState>} [results]              Last result per "s:<journeyId>/<stepId>".
 * @property {boolean} [isNext]                                   Whether the project was judged to use a Next file router.
 */

const PAGE_FILE = /\.(?:js|jsx|ts|tsx|mdx)$/;
const APP_PAGE_FILE = /^page\.(?:js|jsx|ts|tsx|mdx)$/;
const SCANNED_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const PAGES_ROUTER_NON_SCREENS = new Set(['_app', '_document', '_error']);
const MAX_SCANNED_BYTES = 1_000_000;

const QUOTED_ROUTE = String.raw`(["'\`])(\/[^"'\`\s\\]*)\1`;
const MENTION_PATTERN = new RegExp(QUOTED_ROUTE, 'g');
// `path: '/x'` (route configs) or `path="/x"` / `path={'/x'}` (JSX). `path = '/x'` is a plain variable, so it is skipped.
const DEFINITION_PATTERN = new RegExp(String.raw`\bpath(?:\s*:\s*|=\{?\s*)${QUOTED_ROUTE}`, 'g');

// Posix separators, no leading "./" or trailing "/"; "" for the current directory.
function normalizePath(value) {
  const posix = String(value).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  return posix === '.' ? '' : posix;
}

// "[id]" becomes ":id"; "[...slug]" and "[[...slug]]" become ":slug*".
function nextSegmentToParam(segment) {
  const catchAll = /^\[{1,2}\.\.\.([^\]]+)\]{1,2}$/.exec(segment);
  if (catchAll) return `:${catchAll[1]}*`;
  const dynamic = /^\[([^\]]+)\]$/.exec(segment);
  return dynamic ? `:${dynamic[1]}` : segment;
}

function normalizeSegment(segment) {
  const converted = nextSegmentToParam(segment);
  if (converted === '*' || /^:.*\*$/.test(converted)) return ':param*';
  return converted.startsWith(':') ? ':param' : converted;
}

/**
 * Normalizes a route so equivalent spellings compare equal:
 * "/blog/[id]" and "/blog/:postId" both become "/blog/:param"; catch-alls ("[...slug]", ":slug*", "*") become ":param*".
 * Duplicate and trailing slashes are removed, except for the root.
 *
 * @param {string} route
 * @returns {string} Normalized route starting with "/".
 */
export function normalizeRoute(route) {
  const segments = String(route).trim().split('/').filter(Boolean).map(normalizeSegment);
  return `/${segments.join('/')}`;
}

// Only `page.*` files define app-router screens; "(group)", "@slot" and "_private" folders are not URL segments.
function appRouterRoute(segments) {
  const directories = segments.slice(0, -1);
  if (!APP_PAGE_FILE.test(segments.at(-1)) || directories.some((dir) => dir.startsWith('_'))) return null;
  const urlSegments = directories.filter((dir) => !/^\(.*\)$/.test(dir) && !dir.startsWith('@'));
  return `/${urlSegments.map(nextSegmentToParam).join('/')}`;
}

function pagesRouterRoute(segments) {
  const fileName = segments.at(-1);
  if (segments[0] === 'api' || !PAGE_FILE.test(fileName)) return null;
  const name = fileName.replace(PAGE_FILE, '');
  if (segments.length === 1 && PAGES_ROUTER_NON_SCREENS.has(name)) return null;
  const urlSegments = segments.slice(0, -1);
  if (name !== 'index') urlSegments.push(name);
  return `/${urlSegments.map(nextSegmentToParam).join('/')}`;
}

// Longest configured route directory containing the file, or null.
function findRouteDir(file, routeDirs) {
  let best = null;
  for (const candidate of routeDirs.map(normalizePath)) {
    if (candidate && file.startsWith(`${candidate}/`) && candidate.length > (best?.length ?? 0)) best = candidate;
  }
  return best;
}

/**
 * Maps a file inside a file-system router directory to the route it serves.
 * A route directory named "app" is the app router and "pages" the pages router;
 * any other name (e.g. "routes") is unsupported for now.
 *
 * @param {string} relPath Path relative to the app root, e.g. "app/(shop)/checkout/page.tsx".
 * @param {string[]} routeDirs Router directories relative to the app root.
 * @returns {string | null} Route such as "/checkout" or "/blog/:id", or null when the file is not a screen.
 */
export function routeFromNextFile(relPath, routeDirs) {
  const file = normalizePath(relPath);
  const dir = findRouteDir(file, routeDirs);
  if (dir === null) return null;
  const segments = file.slice(dir.length + 1).split('/');
  const router = dir.split('/').at(-1);
  if (router === 'app') return appRouterRoute(segments);
  if (router === 'pages') return pagesRouterRoute(segments);
  return null;
}

const withDefaults = (config) => ({ ...DEFAULT_CONFIG, ...config });
const appRootAbs = (rootAbs, cfg) => path.join(rootAbs, ...normalizePath(cfg.root).split('/'));
// Turns app-root-relative paths into repo-relative ones: "" or "web/".
const appRootPrefix = (cfg) => (normalizePath(cfg.root) ? `${normalizePath(cfg.root)}/` : '');

/**
 * Lists every file-system route file under config.routeDirs (inside config.root).
 * Used to snapshot which pages exist.
 *
 * @param {string} rootAbs Absolute repo root.
 * @param {Partial<Config>} config
 * @returns {Array<{ file: string, route: string }>} Sorted by `file`; `file` is repo-relative (config.root included).
 */
export function listRouteFiles(rootAbs, config) {
  const cfg = withDefaults(config);
  const prefix = appRootPrefix(cfg);
  const routeDirs = cfg.routeDirs.map(normalizePath).filter(Boolean);
  const files = walk(appRootAbs(rootAbs, cfg), { include: routeDirs.map((dir) => `${dir}/**`), exclude: cfg.ignore });
  const routeFiles = [];
  for (const rel of files) {
    const route = routeFromNextFile(rel, routeDirs);
    if (route !== null) routeFiles.push({ file: `${prefix}${rel}`, route });
  }
  return routeFiles;
}

function declaresNext(rootAbs, cfg) {
  const manifests = new Set([path.join(appRootAbs(rootAbs, cfg), 'package.json'), path.join(rootAbs, 'package.json')]);
  for (const manifest of manifests) {
    try {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (['dependencies', 'devDependencies'].some((field) => pkg[field] && Object.hasOwn(pkg[field], 'next'))) return true;
    } catch {
      // missing or malformed package.json: no evidence either way
    }
  }
  return false;
}

// Route files from an 'app' directory are all `page.*` files, which only Next defines.
function detectNext(rootAbs, cfg, listFiles) {
  if (declaresNext(rootAbs, cfg)) return true;
  const prefix = appRootPrefix(cfg);
  const routeDirs = cfg.routeDirs.map(normalizePath);
  return listFiles().some(({ file }) => findRouteDir(file.slice(prefix.length), routeDirs)?.split('/').at(-1) === 'app');
}

/**
 * Whether the project uses a Next file router: package.json (at config.root or the repo root) lists "next"
 * in dependencies or devDependencies, or an app-router `page.*` file exists. A plain `pages/` folder of
 * components (common in Vite apps) is not enough.
 *
 * @param {string} rootAbs Absolute repo root.
 * @param {Partial<Config>} [config]
 * @returns {boolean}
 */
export function isNextProject(rootAbs, config) {
  const cfg = withDefaults(config);
  return detectNext(rootAbs, cfg, () => listRouteFiles(rootAbs, cfg));
}

// Distinct normalized routes from capture group 2 of every match; `clean` returns null to skip a match.
function collectRoutes(pattern, text, clean) {
  const routes = new Set();
  for (const match of text.matchAll(pattern)) {
    const route = clean(match[2]);
    if (route !== null) routes.add(normalizeRoute(route));
  }
  return [...routes];
}

/**
 * Routes this file defines (route configs and JSX route elements), not merely links to.
 * Matches `path: '/x'`, `path="/x"` and `path={'/x'}`; relative nested paths such as `path: 'settings'` are ignored.
 *
 * @param {string} text File contents.
 * @returns {string[]} Distinct normalized routes.
 */
export function extractDefinitions(text) {
  return collectRoutes(DEFINITION_PATTERN, text, (literal) => literal);
}

/**
 * Routes that appear anywhere as a quoted string literal starting with "/" (links, navigate(), fetch).
 * The whole literal is read, so "/book" never matches inside "/bookings". Query strings and hashes are dropped.
 *
 * @param {string} text File contents.
 * @returns {string[]} Distinct normalized routes.
 */
export function extractMentions(text) {
  return collectRoutes(MENTION_PATTERN, text, (literal) => (literal.startsWith('//') ? null : literal.replace(/[?#].*$/, '')));
}

// Reads one source file into an index entry. Returns null for unreadable, oversized or empty (no defs, no mentions) files,
// and reuses `previousEntry` when its mtime is unchanged.
function scanFile(fileAbs, readFile, previousEntry) {
  try {
    const stat = fs.statSync(fileAbs);
    if (!stat.isFile() || stat.size > MAX_SCANNED_BYTES) return null;
    if (previousEntry?.mtimeMs === stat.mtimeMs) return previousEntry;
    const text = readFile(fileAbs);
    const defs = extractDefinitions(text);
    const mentions = extractMentions(text);
    return defs.length > 0 || mentions.length > 0 ? { mtimeMs: stat.mtimeMs, defs, mentions } : null;
  } catch {
    return null;
  }
}

// Full walk of config.sourceGlobs; vanished files drop out and unchanged-mtime entries are reused.
function scanSources(rootAbs, cfg, previous, readFile) {
  const prefix = appRootPrefix(cfg);
  const baseAbs = appRootAbs(rootAbs, cfg);
  const files = {};
  for (const rel of walk(baseAbs, { include: cfg.sourceGlobs, exclude: cfg.ignore })) {
    if (!SCANNED_FILE.test(rel)) continue;
    const entry = scanFile(path.join(baseAbs, rel), readFile, previous[`${prefix}${rel}`]);
    if (entry) files[`${prefix}${rel}`] = entry;
  }
  return files;
}

// Incremental update: re-reads only `changedFiles` (always, whatever their mtime); deleted or emptied files drop out.
function updateIndex(rootAbs, cfg, previous, changedFiles, readFile) {
  const prefix = appRootPrefix(cfg);
  const baseAbs = appRootAbs(rootAbs, cfg);
  const files = { ...previous };
  for (const changed of changedFiles) {
    const key = normalizePath(changed);
    delete files[key];
    if (!key.startsWith(prefix) || key.split('/').includes('..')) continue;
    const rel = key.slice(prefix.length);
    if (!SCANNED_FILE.test(rel) || !matchAny(cfg.sourceGlobs, rel) || matchAny(cfg.ignore, rel)) continue;
    const entry = scanFile(path.join(baseAbs, rel), readFile);
    if (entry) files[key] = entry;
  }
  return files;
}

// Runs `compute` once; `peek()` returns its value only if it has run, so unused work can be told apart.
function memo(compute) {
  let value;
  const get = () => (value ??= compute());
  get.peek = () => value;
  return get;
}

function checkFileAnchor(rootAbs, value) {
  const rel = normalizePath(value);
  if (!rel) return 'broken';
  const fileAbs = path.resolve(rootAbs, rel);
  const fromRoot = path.relative(path.resolve(rootAbs), fileAbs);
  if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) return 'broken';
  return fs.existsSync(fileAbs) ? 'ok' : 'broken';
}

/**
 * Checks every step's anchor against the code.
 *
 * - file anchor: 'ok' if the file exists under rootAbs, else 'broken'.
 * - route anchor, Next project (see isNextProject): 'ok' if a Next route file serves it, else 'broken'.
 * - route anchor, any other project: 'ok' if a source file defines it, else 'unverified'
 *   (absence cannot be proven outside Next, so never 'broken').
 *
 * Paths: file anchors and all returned file paths are repo-relative; routeDirs, sourceGlobs and ignore
 * are relative to config.root.
 *
 * The source index is built by one full walk of sourceGlobs (when `cache.indexed` is falsy or `full` is set;
 * unchanged-mtime entries are reused). Once indexed, calls never walk sourceGlobs: they re-read only `changedFiles`.
 * Route listing and index reads are otherwise lazy, so file-only documents and an empty `only` touch nothing.
 *
 * @param {JourneysDoc} doc
 * @param {object} options
 * @param {string} options.rootAbs Absolute repo root.
 * @param {Partial<Config>} [options.config] Merged over DEFAULT_CONFIG.
 * @param {AnchorCache} [options.cache] Cache returned by a previous call; never mutated.
 * @param {Set<string>} [options.only] Step keys to re-check; other keys are copied from cache.results
 *   (and left out if the cache has none). An empty set does no filesystem work.
 * @param {string[]} [options.changedFiles] Repo-relative files changed since `cache` was built (either slash style).
 *   Used on an indexed cache only; without it an indexed cache is trusted as is.
 * @param {boolean} [options.full] Walk all of sourceGlobs again even if `cache.indexed`.
 * @param {(fileAbs: string) => string} [options._readFile] Test hook replacing how source files are read.
 * @returns {{ results: Record<string, AnchorState>, cache: AnchorCache }} Results by "s:<journeyId>/<stepId>".
 */
export function checkAnchors(doc, { rootAbs, config, cache = {}, only, changedFiles, full, _readFile } = {}) {
  const cfg = withDefaults(config);
  const getRouteFiles = memo(() => listRouteFiles(rootAbs, cfg));
  const getIsNext = memo(() => detectNext(rootAbs, cfg, getRouteFiles));
  const getNextRoutes = memo(() => new Set(getRouteFiles().map((entry) => normalizeRoute(entry.route))));
  const readFile = _readFile ?? ((fileAbs) => fs.readFileSync(fileAbs, 'utf8'));
  const incremental = cache.indexed === true && !full;
  const getSources = memo(() =>
    incremental
      ? updateIndex(rootAbs, cfg, cache.files ?? {}, changedFiles ?? [], readFile)
      : scanSources(rootAbs, cfg, cache.files ?? {}, readFile),
  );
  const getDefinedRoutes = memo(() => new Set(Object.values(getSources()).flatMap((entry) => entry.defs)));

  const checkRouteAnchor = (value) => {
    const target = normalizeRoute(value);
    if (getIsNext()) return getNextRoutes().has(target) ? 'ok' : 'broken';
    return getDefinedRoutes().has(target) ? 'ok' : 'unverified';
  };

  if (full || (incremental && changedFiles?.length > 0)) getSources();

  const results = {};
  for (const journey of doc.journeys ?? []) {
    for (const step of journey.steps ?? []) {
      const key = `s:${journey.id}/${step.id}`;
      if (only && !only.has(key)) {
        if (cache.results?.[key] !== undefined) results[key] = cache.results[key];
        continue;
      }
      const { type, value } = step.anchor ?? {};
      if (type === 'file') results[key] = checkFileAnchor(rootAbs, value);
      else if (type === 'route') results[key] = checkRouteAnchor(value);
      else results[key] = 'unverified';
    }
  }

  return {
    results,
    cache: {
      files: getSources.peek() ?? cache.files ?? {},
      indexed: getSources.peek() !== undefined || cache.indexed === true,
      routeFiles: getRouteFiles.peek() ?? cache.routeFiles ?? [],
      isNext: getIsNext.peek() ?? cache.isNext ?? false,
      results,
    },
  };
}

/**
 * Repo-relative files tied to a step, so callers can tell whether a touched file belongs to it.
 * A file anchor gives its own file; a route anchor gives the Next route file(s) serving it plus every
 * scanned file that defines it. Files that merely mention the route are not included.
 *
 * @param {Step} step
 * @param {AnchorCache} [ctx] The `cache` returned by checkAnchors. Without it, route anchors give [].
 * @returns {string[]} Sorted, distinct, "/"-separated.
 */
export function filesForStep(step, ctx = {}) {
  const { type, value } = step.anchor ?? {};
  if (type === 'file') {
    const rel = normalizePath(value);
    return rel ? [rel] : [];
  }
  if (type !== 'route') return [];
  const target = normalizeRoute(value);
  const files = new Set();
  for (const { file, route } of ctx.routeFiles ?? []) {
    if (normalizeRoute(route) === target) files.add(file);
  }
  for (const [file, entry] of Object.entries(ctx.files ?? {})) {
    if (entry.defs?.includes(target)) files.add(file);
  }
  return [...files].sort();
}
