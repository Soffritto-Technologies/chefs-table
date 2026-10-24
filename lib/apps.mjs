/**
 * Finds the apps a repository ships (a web app, a Mac app, a backend, a background agent, …) without any AI,
 * from workspace settings and the package files of each folder. Journeys and inventories are tagged with these apps.
 */

import fs from 'node:fs';
import path from 'node:path';
import { globToRegExp } from './glob.mjs';

/** @typedef {import('./types.mjs').App} App */

const APP_MARKERS = ['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml'];
const FALLBACK_PATTERNS = ['packages/*', 'apps/*', 'services/*'];
const MAX_GLOBSTAR_DEPTH = 4;
const BASE_TITLES = { web: 'Web app', desktop: 'Desktop app', mobile: 'Mobile app', server: 'Backend', agent: 'Background agent' };

const DESKTOP_DEPS = ['electron', '@electron-forge/*', 'electron-builder', '@tauri-apps/*'];
const MOBILE_DEPS = ['react-native', 'expo'];
const STRONG_WEB_DEPS = ['next', 'vite', '@vitejs/*', 'vue', 'nuxt', 'svelte', '@sveltejs/kit', 'solid-js', '@angular/core', 'react-scripts', 'astro', 'gatsby', '@remix-run/*'];
const WEAK_WEB_DEPS = ['react', 'react-dom', 'preact'];
const SERVER_DEPS = ['express', 'fastify', 'koa', 'hono', '@nestjs/*', '@hapi/hapi', 'restify', 'serverless', 'serverless-http', 'aws-lambda', '@types/aws-lambda'];
const LIBRARY_NAME = /(?:^|[-_/])(?:shared|types?|utils?|ui-kit|ui|common|config|schemas?|contracts?|constants)(?:[-_]|$)/;

/**
 * Lowercase-hyphen slug; camelCase is split into words.
 *
 * @param {string} text Any text, e.g. a folder name.
 * @param {string} [fallback] Returned when nothing is left.
 * @returns {string} Slug such as "contacts-sidebar".
 */
export function slugify(text, fallback = 'x') {
  const slug = splitCamelCase(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || fallback;
}

/**
 * Plain-language title from an id or folder name: camelCase and dashes become spaces, first letter capital.
 *
 * @param {string} id For example "account-settings" or "AICoachTopBar".
 * @returns {string} "Account settings" or "AI Coach Top Bar".
 */
export function humanize(id) {
  const spaced = splitCamelCase(id).replace(/[-_]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function splitCamelCase(text) {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function subdirectories(dirAbs) {
  try {
    return fs.readdirSync(dirAbs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort(compareStrings);
  } catch {
    return [];
  }
}

function toPattern(value) {
  return String(value).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
}

// Folders (repo-relative) a workspace pattern such as "packages/*" or "apps/**" names; `**` spans up to four levels.
function expandPattern(rootAbs, pattern) {
  const segments = toPattern(pattern).split('/').filter(Boolean);
  const found = [];
  const visit = (rel, index, depth) => {
    if (index === segments.length) {
      if (rel) found.push(rel);
      return;
    }
    const segment = segments[index];
    const children = () => subdirectories(path.join(rootAbs, ...rel.split('/').filter(Boolean)));
    const child = (name) => (rel ? `${rel}/${name}` : name);
    if (segment === '**') {
      visit(rel, index + 1, depth);
      if (depth < MAX_GLOBSTAR_DEPTH) for (const name of children()) visit(child(name), index, depth + 1);
    } else if (/[*?{]/.test(segment)) {
      const matcher = globToRegExp(segment);
      for (const name of children()) if (matcher.test(name)) visit(child(name), index + 1, depth);
    } else if (children().includes(segment)) {
      visit(child(segment), index + 1, depth);
    }
  };
  visit('', 0, 0);
  return found;
}

// Lines under a top-level `packages:` key of pnpm-workspace.yaml.
function pnpmPackages(rootAbs) {
  const text = readText(path.join(rootAbs, 'pnpm-workspace.yaml'));
  if (text === null) return [];
  const patterns = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^packages\s*:/.test(line)) inPackages = true;
    else if (inPackages) {
      const item = /^\s*-\s*(?:'([^']*)'|"([^"]*)"|([^\s#]+))/.exec(line);
      if (item) patterns.push(item[1] ?? item[2] ?? item[3]);
      else if (/^\S/.test(line)) inPackages = false;
    }
  }
  return patterns;
}

function workspacePatterns(rootAbs) {
  const pkg = readJson(path.join(rootAbs, 'package.json'));
  const declared = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
  return [...(Array.isArray(declared) ? declared : []), ...pnpmPackages(rootAbs)].filter((entry) => typeof entry === 'string');
}

// Folders that may hold an app: workspace patterns plus packages/*, apps/* and services/*; negated patterns remove folders.
function candidateFolders(rootAbs) {
  const patterns = [...workspacePatterns(rootAbs), ...FALLBACK_PATTERNS];
  const wanted = patterns.filter((pattern) => !pattern.startsWith('!')).flatMap((pattern) => expandPattern(rootAbs, pattern));
  const removed = new Set(patterns.filter((pattern) => pattern.startsWith('!')).flatMap((pattern) => expandPattern(rootAbs, pattern.slice(1))));
  return [...new Set(wanted)].filter((folder) => !removed.has(folder)).sort(compareStrings);
}

function matchesDep(deps, names) {
  return names.some((name) => (name.endsWith('/*') ? [...deps].some((dep) => dep.startsWith(name.slice(0, -1))) : deps.has(name)));
}

function readManifests(dirAbs) {
  return {
    pkg: readJson(path.join(dirAbs, 'package.json')),
    go: readText(path.join(dirAbs, 'go.mod')),
    cargo: readText(path.join(dirAbs, 'Cargo.toml')),
    python: readText(path.join(dirAbs, 'pyproject.toml')),
  };
}

function nodeKind(pkg, dirAbs) {
  const deps = new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((field) => Object.keys(pkg[field] ?? {})));
  const serverless = ['serverless.yml', 'serverless.yaml', 'serverless.ts'].some((name) => fs.existsSync(path.join(dirAbs, name)));
  if (matchesDep(deps, DESKTOP_DEPS)) return { kind: 'desktop', entry: true };
  if (matchesDep(deps, MOBILE_DEPS)) return { kind: 'mobile', entry: true };
  if (matchesDep(deps, STRONG_WEB_DEPS)) return { kind: 'web', entry: true };
  if (matchesDep(deps, SERVER_DEPS) || serverless) return { kind: 'server', entry: true };
  if (matchesDep(deps, WEAK_WEB_DEPS)) return { kind: 'web', entry: fs.existsSync(path.join(dirAbs, 'index.html')) };
  if (pkg.bin || pkg.scripts?.start) return { kind: 'agent', entry: Boolean(pkg.bin) };
  return { kind: null, entry: false };
}

function otherKind({ go, cargo, python }) {
  if (go !== null) return /wailsapp\/wails/.test(go) ? 'desktop' : /gin-gonic\/gin|labstack\/echo|go-chi\/chi|gofiber\/fiber|gorilla\/mux/.test(go) ? 'server' : 'agent';
  if (cargo !== null) return /^\s*tauri\s*=/m.test(cargo) ? 'desktop' : /^\s*(?:axum|actix-web|rocket|warp)\s*=/m.test(cargo) ? 'server' : 'agent';
  return /\b(?:fastapi|flask|django|starlette|aiohttp)\b/i.test(python ?? '') ? 'server' : 'agent';
}

// { kind, library } for a folder; a library has no entry point (no bin, no framework, or a "shared"/"types"/"ui-kit" style name).
function classify(dirAbs, folderName) {
  const manifests = readManifests(dirAbs);
  if (manifests.pkg === null && manifests.go === null && manifests.cargo === null && manifests.python === null) return null;
  if (manifests.pkg !== null) {
    const { kind, entry } = nodeKind(manifests.pkg, dirAbs);
    const libraryName = LIBRARY_NAME.test(String(manifests.pkg.name ?? folderName).replace(/^@[^/]+\//, ''));
    return { kind, library: kind === null || (libraryName && !entry) };
  }
  const kind = otherKind(manifests);
  return { kind, library: kind === 'agent' && LIBRARY_NAME.test(folderName) };
}

// An app nested inside a desktop app (its Go agent, a helper service) is part of that desktop app.
function dropNested(apps) {
  const desktops = apps.filter((app) => app.kind === 'desktop');
  return apps.filter((app) => !desktops.some((desktop) => app.root.startsWith(`${desktop.root}/`)));
}

function uniqueIds(entries) {
  const used = new Set();
  return entries.map((entry) => {
    const bases = [slugify(path.posix.basename(entry.root)), slugify(entry.root)];
    let id = bases.find((candidate) => !used.has(candidate));
    for (let n = 2; id === undefined; n++) if (!used.has(`${bases[1]}-${n}`)) id = `${bases[1]}-${n}`;
    used.add(id);
    return { ...entry, id };
  });
}

function withTitles(entries) {
  const perKind = new Map();
  for (const entry of entries) perKind.set(entry.kind, (perKind.get(entry.kind) ?? 0) + 1);
  return entries.map(({ id, kind, root }) => ({
    id,
    title: perKind.get(kind) > 1 ? `${BASE_TITLES[kind]} · ${humanize(path.posix.basename(root))}` : BASE_TITLES[kind],
    kind,
    root,
  }));
}

/**
 * Finds the apps in a repository.
 *
 * Looks in the workspaces of package.json (array or `{ packages }`), the `packages:` list of pnpm-workspace.yaml, and
 * packages/*, apps/* and services/*. A folder is an app when it has package.json, go.mod, Cargo.toml or pyproject.toml, and is
 * not a pure library (no bin, no framework, a name like *-shared, *-types, *-utils, ui-kit). Kind comes from dependencies:
 * electron/tauri 'desktop'; react-native/expo 'mobile'; next/vite/vue/svelte/solid/angular/react 'web';
 * express/fastify/koa/hono/nest/serverless 'server'; anything else with an entry point (Go, Rust, Python, a CLI) 'agent'.
 * An app inside a desktop app (its Go agent) belongs to the desktop app. A repo without such folders is one app
 * `{ id: 'app', root: '.' }`.
 *
 * @param {string} rootAbs Absolute repo root.
 * @returns {App[]} Apps sorted by id; two apps of one kind get the folder name in their title.
 */
export function findApps(rootAbs) {
  const found = [];
  for (const root of candidateFolders(rootAbs)) {
    const result = classify(path.join(rootAbs, ...root.split('/')), path.posix.basename(root));
    if (result && !result.library) found.push({ kind: result.kind, root });
  }
  const apps = dropNested(found);
  if (apps.length === 0) {
    const result = classify(rootAbs, path.basename(path.resolve(rootAbs)));
    return [{ id: 'app', title: BASE_TITLES[result?.kind ?? 'web'], kind: result?.kind ?? 'web', root: '.' }];
  }
  return withTitles(uniqueIds(apps)).sort((a, b) => compareStrings(a.id, b.id));
}

/**
 * The app a file belongs to: the one with the longest matching root ("." matches everything).
 *
 * @param {App[]} apps From {@link findApps}.
 * @param {string} relPath Repo-relative path ("/" or "\\" separators).
 * @returns {string | null} App id, or null when no app contains the file.
 */
export function appForFile(apps, relPath) {
  const file = toPattern(relPath);
  let best = null;
  for (const app of apps) {
    const root = toPattern(app.root);
    const contains = root === '' || root === '.' || file === root || file.startsWith(`${root}/`);
    const length = root === '.' ? 0 : root.length;
    if (contains && (best === null || length > best.length)) best = { id: app.id, length };
  }
  return best?.id ?? null;
}

/* ───────────── Features: code users notice that no page reaches ───────────── */

/** @typedef {{ app: string, key: string, title: string, files: string[] }} Feature */

const FEATURE_KINDS = new Set(['desktop', 'agent', 'server']);
const FEATURE_CONTAINERS = new Set(['agent', 'src', 'internal', 'pkg', 'lib', 'lambda', 'services', 'modules', 'features', 'cmd']);
const INFRA_FEATURE_KEYS = new Set([
  'util', 'utils', 'config', 'configs', 'types', 'constants', 'log', 'logs', 'logging', 'logger', 'telemetry', 'version', 'build',
  'common', 'shared', 'helpers', 'testutil', 'testutils', 'mocks', 'assets', 'generated', 'scripts',
]);
const SERVER_FEATURE_DIRS = new Set(['emails', 'jobs', 'workers', 'cron', 'notifications', 'webhooks', 'schedulers']);
const NOT_A_FEATURE_FILE = /(?:^|\/)[^/]*\.config\.[cm]?[jt]s$|\.d\.ts$/;

/**
 * Whether an app's non-page code is worth a feature unit (desktop, agent and server apps).
 *
 * @param {App} app
 * @returns {boolean}
 */
export function hasFeatures(app) {
  return FEATURE_KINDS.has(app.kind);
}

const SHELL_KEY = 'shell';
const OTHER_KEY = 'other';
const BYTES_PER_TOKEN = 4;

// The folder below the container folders (agent, src, internal, pkg, lib, lambda, services, modules, features, cmd);
// in cmd/<binary>/ the binary's name is skipped, and a file with no such folder is keyed by its name, so cmd/app/beeper.go
// joins agent/beeper/. `loose` marks a file sitting directly in a container root (src/tray.js, agent/main.go), not under cmd/<binary>/.
function locateFeature(rel) {
  const segments = rel.split('/');
  const folders = segments.slice(0, -1);
  let i = 0;
  let viaCmd = false;
  while (i < folders.length && FEATURE_CONTAINERS.has(folders[i].toLowerCase())) {
    const skipsBinary = folders[i].toLowerCase() === 'cmd' && i + 1 < folders.length;
    viaCmd ||= skipsBinary;
    i += skipsBinary ? 2 : 1;
  }
  if (i < folders.length) return { key: folders[i], loose: false };
  return { key: segments.at(-1).replace(/\.[^.]*$/, ''), loose: !viaCmd };
}

function noticedOnServer({ rel, noticed }) {
  return noticed || rel.split('/').slice(0, -1).some((folder) => SERVER_FEATURE_DIRS.has(folder.toLowerCase()));
}

/**
 * Groups an app's code that no page reaches into features, one per feature folder.
 * Desktop and agent apps offer every file given; a server only the files that are `noticed` (they send emails or run jobs)
 * or sit in folders named emails, jobs, workers, cron, notifications, webhooks or schedulers. Utility folders
 * (util, config, types, log, telemetry, version, build, …) are not features. Files with the same key merge, so
 * agent/beeper/ and agent/cmd/app/beeper.go are one "beeper".
 *
 * With `minTokens` (estimated tokens, bytes / 4) small things are folded together so the map is not fragmented:
 * in a desktop or agent app the files sitting directly in a container root (src/*.js) form one feature "shell"
 * ("Desktop app shell"), except a file of at least `minTokens` which keeps its own feature; then every other feature
 * under `minTokens` (the shell excepted) is merged into one "other" ("Desktop app · other parts"), unless only one is small.
 *
 * @param {App} app
 * @param {Array<{ file: string, rel: string, noticed: boolean, bytes?: number }>} files Candidate files: repo-relative path,
 *   path relative to the app root, whether the file has an email or job item, and its size in bytes.
 * @param {{ minTokens?: number }} [options] 0 (the default) keeps every feature as it is.
 * @returns {Feature[]} Sorted by key; files sorted; the title is the humanized key (see above for "shell" and "other").
 */
export function groupFeatures(app, files, { minTokens = 0 } = {}) {
  if (!hasFeatures(app)) return [];
  const minBytes = minTokens * BYTES_PER_TOKEN;
  const hasShell = app.kind === 'desktop' || app.kind === 'agent';
  const groups = new Map();
  for (const entry of files) {
    if (NOT_A_FEATURE_FILE.test(entry.rel) || (app.kind === 'server' && !noticedOnServer(entry))) continue;
    const { key, loose } = locateFeature(entry.rel);
    const slug = slugify(key);
    if (INFRA_FEATURE_KEYS.has(slug)) continue;
    const bytes = entry.bytes ?? 0;
    const target = hasShell && loose && bytes < minBytes ? SHELL_KEY : slug;
    const group = groups.get(target) ?? { files: [], bytes: 0 };
    group.files.push(entry.file);
    group.bytes += bytes;
    groups.set(target, group);
  }

  const small = [...groups].filter(([key, group]) => key !== SHELL_KEY && group.bytes < minBytes);
  if (small.length > 1) {
    const merged = { files: small.flatMap(([, group]) => group.files), bytes: 0 };
    for (const [key] of small) groups.delete(key);
    groups.set(OTHER_KEY, merged);
  }

  const titles = { [SHELL_KEY]: `${app.title} shell`, [OTHER_KEY]: `${app.title} · other parts` };
  return [...groups]
    .map(([key, group]) => ({ app: app.id, key, title: titles[key] ?? humanize(key), files: [...new Set(group.files)].sort(compareStrings) }))
    .sort((a, b) => compareStrings(a.key, b.key));
}
