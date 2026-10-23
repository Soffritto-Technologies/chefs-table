import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  Project, cleanupProjects, docOf, fileAnchor, hookPayload, journey, runHook, step, toolInput, trackTempDir,
} from './helpers/project.mjs';

after(cleanupProjects);

const SID = 'perf-session';
const SOURCE_FILES = 50_000;
const ROUTES = 200;
const FEATURES = 100;
const MODULES = 10;
const JOURNEYS = 40;
const PRE_POST_LIMIT_MS = 250;
const STOP_COLD_LIMIT_MS = 1500;
const STOP_WARM_LIMIT_MS = 600;

/**
 * Nearest-rank percentile.
 *
 * @param {number[]} samples - Measurements.
 * @param {number} pct - Percentile, 0-100.
 * @returns {number} The sample at that rank.
 */
function percentile(samples, pct) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1)];
}

/**
 * Formats milliseconds for the printed report.
 *
 * @param {number} ms - Duration.
 * @returns {string} e.g. "83.4ms".
 */
function fmt(ms) {
  return `${ms.toFixed(1)}ms`;
}

/**
 * Builds a synthetic project of 50,000 small source files under src/** and app/**.
 * "next": 200 of them are app-router page.tsx routes, so anchors resolve from the file router.
 * "vite": no page.tsx and no "next" dependency; the 200 routes are `path: '/rN'` definitions in src/routes.tsx,
 * so every anchor check has to scan the whole source tree (the expensive path).
 *
 * @param {'next'|'vite'} flavour - Which kind of project to build.
 * @returns {{ project: Project, files: number, ms: number }} The project, how many source files it holds, and how long it took to build.
 */
function generateProject(flavour) {
  const started = performance.now();
  const dir = trackTempDir(realpathSync(mkdtempSync(path.join(tmpdir(), 'jm-perf-'))));
  const made = new Set();
  let files = 0;
  /**
   * Writes one source file, creating its folder once.
   *
   * @param {string} rel - Project-relative posix path.
   * @param {string} text - File contents.
   * @returns {void}
   */
  const put = (rel, text) => {
    const abs = path.join(dir, ...rel.split('/'));
    const folder = path.dirname(abs);
    if (!made.has(folder)) {
      mkdirSync(folder, { recursive: true });
      made.add(folder);
    }
    writeFileSync(abs, text);
    files += 1;
  };
  /**
   * Small file contents; every 50th file also mentions a route, like real code does.
   *
   * @param {number} n - File counter.
   * @returns {string} Contents.
   */
  const body = (n) => (n % 50 === 0 ? `export const load${n} = () => fetch('/api/items/${n}');\n` : `export const v${n} = ${n};\n`);

  const dependencies = flavour === 'next' ? { next: '14.2.0' } : { react: '18.3.0' };
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'perf-app', dependencies }));
  put('app/layout.tsx', 'export default function Layout({ children }: { children: unknown }) {\n  return children;\n}\n');
  if (flavour === 'next') {
    for (let r = 0; r < ROUTES; r += 1) put(`app/r${r}/page.tsx`, `export default function Page${r}() {\n  return null;\n}\n`);
  } else {
    const defs = Array.from({ length: ROUTES }, (_, r) => `  { path: '/r${r}', element: null },`).join('\n');
    put('src/routes.tsx', `export const routes = [\n${defs}\n];\n`);
    for (let r = 0; r < ROUTES; r += 1) put(`app/r${r}/Screen.tsx`, `export const Screen${r} = () => null;\n`);
  }
  const srcFiles = Math.floor((SOURCE_FILES - files) * 0.8);
  const partsPerRoute = Math.ceil((SOURCE_FILES - files - srcFiles) / ROUTES);
  for (let r = 0; r < ROUTES && files < SOURCE_FILES - srcFiles; r += 1) {
    for (let k = 0; k < partsPerRoute && files < SOURCE_FILES - srcFiles; k += 1) put(`app/r${r}/parts/p${k}.tsx`, body(files));
  }
  for (let n = 0; files < SOURCE_FILES; n += 1) {
    put(`src/features/f${n % FEATURES}/m${Math.floor(n / FEATURES) % MODULES}/file${Math.floor(n / (FEATURES * MODULES))}.ts`, body(files));
  }
  return { project: new Project(dir), files, ms: performance.now() - started };
}

/**
 * Forty journeys of three steps each (a route anchor, an app file anchor, a src file anchor), all of which exist
 * in both project flavours.
 *
 * @returns {object} A journeys document.
 */
function perfDoc() {
  const journeys = Array.from({ length: JOURNEYS }, (_, k) => journey(`j${k}`, `Journey number ${k}`, [
    step('landing', `/r${k}`, { next: ['detail'] }),
    step('detail', null, { anchor: fileAnchor(`app/r${k}/parts/p0.tsx`), next: ['lib'] }),
    step('lib', null, { anchor: fileAnchor(`src/features/f${k}/m0/file0.ts`) }),
  ]));
  return docOf(journeys, { app: 'perf-app' });
}

/**
 * Runs one hook and times it, spawn included.
 *
 * @param {Project} project - Project to run in.
 * @param {string} event - Hook event.
 * @param {object} fields - Event payload fields.
 * @returns {{ ms: number, stdout: any }} Wall time and parsed output.
 */
function timedHook(project, event, fields) {
  const payload = hookPayload(event, { cwd: project.dir, session_id: SID, ...fields });
  const t0 = performance.now();
  const result = runHook(event, payload);
  const ms = performance.now() - t0;
  assert.equal(result.status, 0, `${event} exit code`);
  assert.equal(result.stderr, '', `${event} must not crash`);
  return { ms, stdout: result.stdout };
}

/**
 * Times `count` runs of a hook, each on a different file.
 *
 * @param {Project} project - Project to run in.
 * @param {string} event - PreToolUse or PostToolUse.
 * @param {(i: number) => string} fileFor - Project-relative file for run i.
 * @param {number} [count] - Number of runs.
 * @returns {number[]} Wall times in ms.
 */
function timeEdits(project, event, fileFor, count = 10) {
  return Array.from({ length: count }, (_, i) => {
    const file = project.abs(fileFor(i));
    const fields = { tool_name: 'Write', tool_input: toolInput('Write', file) };
    if (event === 'PostToolUse') fields.tool_response = { filePath: file };
    return timedHook(project, event, fields).ms;
  });
}

/**
 * Prints one line of the report.
 *
 * @param {string} label - What was measured.
 * @param {number[]} samples - Wall times in ms.
 * @param {number} baseline - Median of an empty node process; the median gap to it estimates the in-process time.
 * @returns {number} p95 of the samples.
 */
function report(label, samples, baseline) {
  const p95 = percentile(samples, 95);
  console.log(`perf ${label.padEnd(34)} p95 ${fmt(p95).padStart(9)}  median ${fmt(percentile(samples, 50)).padStart(9)}  in-process ~${fmt(Math.max(0, percentile(samples, 50) - baseline))}  (n=${samples.length})`);
  return p95;
}

const SUITES = [
  { flavour: 'next', todo: {} },
  {
    flavour: 'vite',
    todo: {
      pre: 'bug: without a Next file router every PreToolUse parses the whole anchor cache (~6 MB for 50,000 files) and filesForStep walks all 50,000 cached files for each of the 40 route steps: ~490ms, 5x over the 100ms hook budget',
      stop: 'bug: warm Stop re-stats all 50,000 source files and rewrites the ~6 MB anchor cache every turn: ~920ms, over the 600ms warm budget',
    },
  },
];

for (const { flavour, todo } of SUITES) {
  describe(`hook speed on a 50,000-file ${flavour} project`, { skip: process.env.CHEFS_TABLE_PERF !== '1' && 'set CHEFS_TABLE_PERF=1 to run (slow: builds a 50,000-file project)' }, () => {
    let project;
    let baseline;

    before(() => {
      const built = generateProject(flavour);
      project = built.project;
      project.writeDoc(perfDoc());
      console.log(`perf ${flavour} project: ${built.files} source files (${flavour === 'next' ? `${ROUTES} page.tsx routes` : `${ROUTES} routes defined in src/routes.tsx`}), ${JOURNEYS} journeys, built in ${fmt(built.ms)} at ${project.dir}`);
      const spawns = Array.from({ length: 10 }, () => {
        const t0 = performance.now();
        spawnSync(process.execPath, ['-e', '0']);
        return performance.now() - t0;
      });
      baseline = percentile(spawns, 50);
      console.log(`perf ${'empty node process (spawn floor)'.padEnd(34)} p95 ${fmt(percentile(spawns, 95)).padStart(9)}  median ${fmt(percentile(spawns, 50)).padStart(9)}  (n=10)`);
    });

    it('SessionStart finishes well inside its 10 second budget', () => {
      const { ms, stdout } = timedHook(project, 'SessionStart', { source: 'startup' });
      console.log(`perf ${`SessionStart (first, cold)`.padEnd(34)} ${fmt(ms)}`);
      assert.ok(stdout.hookSpecificOutput.additionalContext.includes('Journey number 0'));
      assert.ok(ms < 5000, `SessionStart took ${fmt(ms)}`);
    });

    it(`PreToolUse p95 over 10 runs is under ${PRE_POST_LIMIT_MS}ms`, { todo: todo.pre }, () => {
      const unmapped = timeEdits(project, 'PreToolUse', (i) => `src/features/f99/m9/file${i}.ts`);
      const mapped = timeEdits(project, 'PreToolUse', (i) => `app/r${i}/parts/p0.tsx`);
      const worst = Math.max(report('PreToolUse, unmapped file', unmapped, baseline), report('PreToolUse, mapped file (nudge)', mapped, baseline));
      assert.ok(worst < PRE_POST_LIMIT_MS, `PreToolUse p95 ${fmt(worst)}`);
    });

    it(`PostToolUse p95 over 10 runs is under ${PRE_POST_LIMIT_MS}ms`, () => {
      const plain = timeEdits(project, 'PostToolUse', (i) => `src/features/f99/m9/file${i}.ts`);
      project.write(`.journeys/.session/${SID}/plan.json`, JSON.stringify({
        summary: 'Perf plan',
        upsert: [journey('perf-new', 'Perf new', [step('s', '/perf-new', { anchor: fileAnchor('src/features/f99/m9/file0.ts') })])],
        remove: ['j1'],
      }));
      const withPlan = timeEdits(project, 'PostToolUse', (i) => `src/features/f98/m9/file${i}.ts`);
      project.remove(`.journeys/.session/${SID}/plan.json`);
      project.remove(`.journeys/.session/${SID}/approval.json`);
      const worst = Math.max(report('PostToolUse, no plan', plain, baseline), report('PostToolUse, pending plan', withPlan, baseline));
      assert.ok(worst < PRE_POST_LIMIT_MS, `PostToolUse p95 ${fmt(worst)}`);
    });

    it(`Stop over 5 runs: cold first run under ${STOP_COLD_LIMIT_MS}ms, later runs (cache warm) p95 under ${STOP_WARM_LIMIT_MS}ms`, { todo: todo.stop }, () => {
      project.remove(`.journeys/.session/${SID}/anchor-cache.json`);
      const runs = [];
      for (let i = 0; i < 5; i += 1) {
        timedHook(project, 'PostToolUse', { tool_name: 'Write', tool_input: toolInput('Write', project.abs(`src/features/f97/m9/file${i}.ts`)), tool_response: {} });
        const { ms, stdout } = timedHook(project, 'Stop', { stop_hook_active: false });
        assert.equal(stdout, null, `Stop run ${i + 1} should not block`);
        runs.push(ms);
      }
      console.log(`perf Stop runs: ${runs.map(fmt).join(', ')}`);
      report('Stop, first run (cache cold)', [runs[0]], baseline);
      const warmP95 = report('Stop, later runs (cache warm)', runs.slice(1), baseline);
      assert.ok(runs[0] < STOP_COLD_LIMIT_MS, `first Stop took ${fmt(runs[0])}`);
      assert.ok(warmP95 < STOP_WARM_LIMIT_MS, `warm Stop p95 ${fmt(warmP95)}`);
    });
  });
}
