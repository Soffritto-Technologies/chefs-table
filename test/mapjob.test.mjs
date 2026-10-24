import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import * as M from '../lib/mapjob.mjs';
import {
  baseDoc, cleanupProjects, docOf, fileAnchor, journey, makeProject, sampleInventory, sampleUnits, step, unitOutput,
} from './helpers/project.mjs';

after(cleanupProjects);

const CLI_PATH = '/plugin/bin/journeys.mjs';
const MODULE_URL = new URL('../lib/mapjob.mjs', import.meta.url).href;

/**
 * A project with the sample inventory saved and a job over the sample units.
 *
 * @param {object} [options] - `budget` and `doc` overrides.
 * @returns {{ project: object, dir: string, job: object }} The project and its fresh job.
 */
function jobProject({ budget = {}, doc = baseDoc() } = {}) {
  const project = makeProject({ fixture: false, doc });
  M.saveInventory(project.dir, sampleInventory());
  const { job } = M.startJob(project.dir, { units: sampleUnits(), budget });
  return { project, dir: project.dir, job };
}

/**
 * Reads a brief back.
 *
 * @param {string} path - Absolute path.
 * @returns {string} Contents.
 */
function readBrief(path) {
  return readFileSync(path, 'utf8');
}

/**
 * Writes a helper's output for a unit.
 *
 * @param {object} project - Test project.
 * @param {string} unitId - Unit id.
 * @param {object|string} out - Output object, or raw text.
 * @returns {void}
 */
function writeOut(project, unitId, out) {
  project.write(`.journeys/build/units/${unitId}.out.json`, typeof out === 'string' ? out : JSON.stringify(out));
}

describe('jobPaths, startJob and loadJob', () => {
  it('puts everything under .journeys/', () => {
    const paths = M.jobPaths('/proj');
    assert.deepEqual(Object.keys(paths).sort(), ['build', 'coverage', 'inventory', 'job', 'units']);
    assert.equal(paths.job, join('/proj', '.journeys', 'build', 'job.json'));
    assert.equal(paths.inventory, join('/proj', '.journeys', 'inventory.json'));
  });

  it('writes a stir-phase job with pending units and the budget', () => {
    const { dir, job } = jobProject({ budget: { tokens: 5000, percent: 10, startPercent: 2 } });
    assert.deepEqual(M.loadJob(dir), job);
    assert.equal(job.phase, 'stir');
    assert.equal(job.usedTokens, 0);
    assert.deepEqual(job.budget, { tokens: 5000, percent: 10, startPercent: 2, lastPercent: null });
    assert.deepEqual(job.units.map((u) => [u.id, u.status, u.tokens, u.attempts]), [['area-home', 'pending', 0, 0], ['area-checkout', 'pending', 0, 0], ['area-blog', 'pending', 0, 0]]);
  });

  it('turns unusable budget numbers into nulls', () => {
    const { job } = jobProject({ budget: { tokens: 'lots', percent: '', startPercent: undefined } });
    assert.deepEqual(job.budget, { tokens: null, percent: null, startPercent: null, lastPercent: null });
  });

  it('hands back an unfinished job unchanged unless asked to restart', () => {
    const { dir, job } = jobProject();
    M.updateJob(dir, (j) => { j.units[0].status = 'done'; });
    const again = M.startJob(dir, { units: [] });
    assert.equal(again.resumed, true);
    assert.equal(again.job.units.length, job.units.length);
    assert.equal(again.job.units[0].status, 'done');
    const fresh = M.startJob(dir, { units: sampleUnits().slice(0, 1), restart: true });
    assert.equal(fresh.resumed, false);
    assert.equal(fresh.job.units.length, 1);
    assert.equal(fresh.job.units[0].status, 'pending');
  });

  it('starts a new job once the old one is done, and clears the old unit files', () => {
    const { project, dir } = jobProject();
    writeOut(project, 'area-home', unitOutput(sampleUnits()[0]));
    M.updateJob(dir, (j) => { j.phase = 'done'; });
    assert.equal(M.startJob(dir, { kind: 'sync', units: sampleUnits() }).resumed, false);
    assert.equal(M.loadJob(dir).kind, 'sync');
    assert.equal(project.exists('.journeys/build/units/area-home.out.json'), false);
  });

  it('loadJob is null when there is no job or the file is junk', () => {
    const project = makeProject({ fixture: false });
    assert.equal(M.loadJob(project.dir), null);
    project.write('.journeys/build/job.json', '{"nope":1}');
    assert.equal(M.loadJob(project.dir), null);
  });
});

describe('nextUnits and resumeJob', () => {
  it('hands out the requested number of pending units and counts attempts', () => {
    const { job } = jobProject();
    const first = M.nextUnits(job, 2);
    assert.deepEqual(first.map((u) => u.id), ['area-home', 'area-checkout']);
    assert.deepEqual(first.map((u) => [u.status, u.attempts]), [['in_progress', 1], ['in_progress', 1]]);
    assert.deepEqual(M.nextUnits(job, 5).map((u) => u.id), ['area-blog']);
    assert.deepEqual(M.nextUnits(job, 5), []);
    assert.equal(M.nextUnits(job, 0).length, 0);
  });

  it('gives up on a unit that already crashed three times', () => {
    const { job } = jobProject();
    for (let i = 0; i < 3; i += 1) {
      M.nextUnits(job, 1);
      M.resumeJob(job);
    }
    assert.equal(job.units[0].attempts, 3);
    assert.deepEqual(M.nextUnits(job, 1).map((u) => u.id), ['area-checkout']);
    assert.equal(job.units[0].status, 'failed');
  });

  it('puts in-progress work back to pending when resuming', () => {
    const { job } = jobProject();
    M.nextUnits(job, 3);
    job.units[2].status = 'done';
    M.resumeJob(job);
    assert.deepEqual(job.units.map((u) => u.status), ['pending', 'pending', 'done']);
    assert.equal(job.units[0].attempts, 1, 'the crashed attempt still counts');
  });

  it('stops the job with a plain reason when the budget is spent', () => {
    const { job } = jobProject({ budget: { tokens: 100 } });
    job.usedTokens = 100;
    assert.deepEqual(M.nextUnits(job, 2), []);
    assert.equal(job.phase, 'stopped');
    assert.match(job.stopReason, /used 100 of its 100 allowed tokens/);
    assert.ok(job.units.every((u) => u.status === 'pending'));
  });

  it('leaves a finished job finished even when the budget is spent', () => {
    const { job } = jobProject({ budget: { tokens: 1 } });
    job.usedTokens = 5;
    job.phase = 'done';
    assert.deepEqual(M.nextUnits(job, 1), []);
    assert.equal(job.phase, 'done');
  });

  it('returns a stopped job to stir only when the budget allows it', () => {
    const { job } = jobProject({ budget: { tokens: 100 } });
    job.usedTokens = 100;
    M.nextUnits(job, 1);
    assert.equal(M.resumeJob(job).phase, 'stopped');
    M.setBudget(job, { tokens: 500 });
    assert.equal(M.resumeJob(job).phase, 'stir');
    assert.equal(job.stopReason, null);
  });
});

describe('budgetStatus', () => {
  it('is never exceeded without limits', () => {
    const { job } = jobProject();
    job.usedTokens = 9e9;
    assert.deepEqual(M.budgetStatus(job, { nowPercent: 99 }), { exceeded: false, reason: null, usedTokens: 9e9, tokenLimit: null, percentUsedByJob: null });
  });

  it('is exceeded exactly at the token limit', () => {
    const { job } = jobProject({ budget: { tokens: 10 } });
    job.usedTokens = 9;
    assert.equal(M.budgetStatus(job).exceeded, false);
    job.usedTokens = 10;
    const status = M.budgetStatus(job);
    assert.equal(status.exceeded, true);
    assert.equal(status.tokenLimit, 10);
    assert.match(status.reason, /^This run has used 10 of its 10 allowed tokens\.$/);
  });

  it('counts points of 5-hour usage since the start and remembers the last reading', () => {
    const { job } = jobProject({ budget: { percent: 10, startPercent: 2 } });
    assert.equal(M.budgetStatus(job).percentUsedByJob, 0, 'no reading yet: nothing used');
    const mid = M.budgetStatus(job, { nowPercent: 8 });
    assert.deepEqual([mid.exceeded, mid.percentUsedByJob, job.budget.lastPercent], [false, 6, 8]);
    assert.equal(M.budgetStatus(job).percentUsedByJob, 6, 'without a new reading it uses the last one');
    const over = M.budgetStatus(job, { nowPercent: 12 });
    assert.equal(over.exceeded, true);
    assert.equal(over.reason, 'This run has used 10 of your 10 allowed points of 5-hour usage (2% → 12%).');
    assert.equal(M.budgetStatus(job).exceeded, true, 'the last reading is remembered');
  });

  it('cannot enforce a percent limit without a starting percentage', () => {
    const { job } = jobProject({ budget: { percent: 5 } });
    assert.equal(M.budgetStatus(job, { nowPercent: 90 }).exceeded, false);
  });

  it('reports the token limit first when both limits are spent', () => {
    const { job } = jobProject({ budget: { tokens: 1, percent: 1, startPercent: 0 } });
    job.usedTokens = 5;
    assert.match(M.budgetStatus(job, { nowPercent: 50 }).reason, /allowed tokens/);
  });
});

describe('writeBrief', () => {
  it('starts with the unit marker and tells the helper what to read and write', () => {
    const { dir } = jobProject();
    const unit = sampleUnits()[1];
    const path = M.writeBrief(dir, unit, sampleInventory(), baseDoc(), CLI_PATH);
    assert.equal(path, M.unitPaths(dir, unit.id).brief);
    const text = readFileSync(path, 'utf8');
    assert.equal(text.split('\n')[0], '[chefs-table unit area-checkout]');
    assert.match(text, /Area: Checkout \(id "checkout"\)/);
    assert.match(text, /# Checkout/);
    assert.match(text, /- \/checkout → app\/\(shop\)\/checkout\/page\.tsx/);
    assert.match(text, /### Forms\n- app\/\(shop\)\/checkout\/page\.tsx:12 form with card number/);
    assert.match(text, /### Server endpoints\n- pages\/api\/pay\.ts:1 POST \/api\/pay/);
    assert.match(text, /- app\/\(shop\)\/checkout\/page\.tsx \(~1,000 tokens\)/);
    assert.match(text, /Update these rather than duplicating them[^\n]*\n- pay: Pay for the order/);
    assert.doesNotMatch(text, /- browse:/);
    assert.match(text, new RegExp(`Write one JSON file: ${dir}/\\.journeys/build/units/area-checkout\\.out\\.json`));
    assert.ok(text.includes(`node "${CLI_PATH}" stir submit area-checkout`));
    for (const rule of ['non-technical', 'file or a route', 'sees, does, rules, saves, files', 'lowercase-hyphen', 'subflow', 'Do not invent']) {
      assert.ok(text.includes(rule), rule);
    }
  });

  it('says so when nothing is on the map yet and nothing special was found', () => {
    const { dir } = jobProject({ doc: docOf([]) });
    const text = readBrief(M.writeBrief(dir, sampleUnits()[0], sampleInventory(), docOf([]), CLI_PATH));
    assert.match(text, /Nothing yet for these pages\./);
    assert.match(text, /Nothing special found\./);
  });

  it('matches existing journeys by file anchor and by detail.files too', () => {
    const { dir } = jobProject();
    const doc = docOf([
      journey('by-file', 'By file', [step('a', null, { anchor: fileAnchor('app/page.tsx') })]),
      journey('by-detail', 'By detail', [step('a', null, { detail: { files: ['app/page.tsx'] } })]),
      journey('elsewhere', 'Elsewhere', [step('a', '/other')]),
    ]);
    const text = readBrief(M.writeBrief(dir, sampleUnits()[0], sampleInventory(), doc, CLI_PATH));
    assert.match(text, /- by-file: By file\n- by-detail: By detail/);
    assert.doesNotMatch(text, /elsewhere/);
  });
});

describe('submitUnit', () => {
  it('marks the unit done when its output is valid', () => {
    const { project, dir } = jobProject();
    writeOut(project, 'area-home', unitOutput(sampleUnits()[0]));
    assert.deepEqual(M.submitUnit(dir, 'area-home'), { ok: true });
    assert.equal(M.loadJob(dir).units[0].status, 'done');
  });

  it('keeps the unit in progress and explains an invalid output', () => {
    const { project, dir, job } = jobProject();
    M.nextUnits(job, 1);
    M.saveJob(dir, job);
    const bad = unitOutput(sampleUnits()[0]);
    bad.journeys[0].steps[0].anchor = { type: 'file', value: '../etc/passwd' };
    writeOut(project, 'area-home', bad);
    const result = M.submitUnit(dir, 'area-home');
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /must stay inside the project folder/);
    assert.equal(M.loadJob(dir).units[0].status, 'in_progress');
  });

  it('rejects missing, broken, empty and unknown output', () => {
    const { project, dir } = jobProject();
    assert.match(M.submitUnit(dir, 'area-home').errors[0], /can't find .*area-home\.out\.json/);
    writeOut(project, 'area-home', '{not json');
    assert.match(M.submitUnit(dir, 'area-home').errors[0], /not valid JSON/);
    writeOut(project, 'area-home', { journeys: 'many' });
    assert.match(M.submitUnit(dir, 'area-home').errors[0], /must be a JSON object with a "journeys" list/);
    writeOut(project, 'area-home', { journeys: [] });
    assert.match(M.submitUnit(dir, 'area-home').errors[0], /list is empty/);
    assert.match(M.submitUnit(dir, 'nope').errors[0], /no work unit "nope"/);
    assert.ok(M.loadJob(dir).units.every((u) => u.status === 'pending'));
  });

  it('accepts a journey in an area known only from the inventory, and rejects an unknown one', () => {
    const { project, dir } = jobProject({ doc: { ...baseDoc(), areas: [] } });
    const out = unitOutput(sampleUnits()[0]);
    delete out.areas;
    writeOut(project, 'area-home', out);
    assert.deepEqual(M.submitUnit(dir, 'area-home'), { ok: true });
    out.journeys[0].area = 'made-up';
    writeOut(project, 'area-blog', out);
    assert.match(M.submitUnit(dir, 'area-blog').errors.join('\n'), /area "made-up", which is not listed/);
  });
});

describe('failUnit and recordTokens', () => {
  it('marks a unit failed with a reason, and reports unknown units', () => {
    const { dir } = jobProject();
    assert.equal(M.failUnit(dir, 'area-blog', 'helper gave up'), true);
    assert.equal(M.failUnit(dir, 'nope', 'x'), false);
    const unit = M.loadJob(dir).units[2];
    assert.deepEqual([unit.status, unit.failReason], ['failed', 'helper gave up']);
  });

  it('adds tokens to the job and to the matching unit only', () => {
    const { dir } = jobProject();
    M.recordTokens(dir, { tokens: 1000, unitId: 'area-home' });
    M.recordTokens(dir, { tokens: 500, unitId: 'unknown' });
    M.recordTokens(dir, { tokens: 250 });
    const job = M.loadJob(dir);
    assert.equal(job.usedTokens, 1750);
    assert.deepEqual(job.units.map((u) => u.tokens), [1000, 0, 0]);
  });

  it('ignores tokens that are not a positive number', () => {
    const { dir } = jobProject();
    for (const tokens of [0, -5, NaN, '1234', null, undefined]) assert.equal(M.recordTokens(dir, { tokens }), null);
    assert.equal(M.loadJob(dir).usedTokens, 0);
  });

  it('does not lose updates when several helpers finish at the same moment', async () => {
    const { dir } = jobProject();
    const script = `import(${JSON.stringify(MODULE_URL)}).then((M) => { for (let i = 0; i < 15; i += 1) M.recordTokens(${JSON.stringify(dir)}, { tokens: 1, unitId: 'area-home' }); });`;
    await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      spawn(process.execPath, ['-e', script], { stdio: 'inherit' }).on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
    })));
    const job = M.loadJob(dir);
    assert.deepEqual([job.usedTokens, job.units[0].tokens], [60, 60]);
  });

  it('breaks a stale lock instead of waiting forever, and always releases its own', () => {
    const { dir } = jobProject();
    const lock = join(dir, '.journeys', 'build', 'job.lock');
    mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    M.recordTokens(dir, { tokens: 10 });
    assert.equal(M.loadJob(dir).usedTokens, 10);
    assert.equal(existsSync(lock), false);
    assert.throws(() => M.updateJob(dir, () => { throw new Error('boom'); }), /boom/);
    assert.equal(existsSync(lock), false);
  });
});

describe('mergeUnits', () => {
  it('adds every done unit to the base map and ignores the rest', () => {
    const { project, dir } = jobProject();
    const [home, checkout] = sampleUnits();
    writeOut(project, 'area-home', unitOutput(home));
    writeOut(project, 'area-checkout', unitOutput(checkout));
    M.submitUnit(dir, 'area-home');
    const merged = M.mergeUnits(dir, baseDoc());
    assert.deepEqual(merged.errors, []);
    assert.deepEqual(merged.collisions, []);
    assert.deepEqual(merged.doc.journeys.map((j) => j.id), ['browse', 'pay', 'j-area-home']);
    assert.deepEqual(merged.doc.areas, [{ id: 'home', title: 'Home' }]);
  });

  it('keeps the later unit when two write the same journey, and reports it', () => {
    const { project, dir } = jobProject();
    const [home, checkout] = sampleUnits();
    for (const [unit, title] of [[home, 'First take'], [checkout, 'Second take']]) {
      const out = unitOutput(unit);
      out.journeys[0].id = 'shared';
      out.journeys[0].title = title;
      writeOut(project, unit.id, out);
      assert.deepEqual(M.submitUnit(dir, unit.id), { ok: true });
    }
    const merged = M.mergeUnits(dir, baseDoc());
    assert.deepEqual(merged.collisions, ['shared']);
    assert.equal(merged.doc.journeys.filter((j) => j.id === 'shared').length, 1);
    assert.equal(merged.doc.journeys.find((j) => j.id === 'shared').title, 'Second take');
  });

  it('lets a unit replace a base journey in place without calling it a collision', () => {
    const { project, dir } = jobProject();
    const out = unitOutput(sampleUnits()[1]);
    out.journeys[0].id = 'pay';
    out.journeys[0].title = 'Pay, redone';
    writeOut(project, 'area-checkout', out);
    M.submitUnit(dir, 'area-checkout');
    const merged = M.mergeUnits(dir, baseDoc());
    assert.deepEqual(merged.collisions, []);
    assert.deepEqual(merged.doc.journeys.map((j) => j.title), ['Browse the shop', 'Pay, redone']);
  });

  it('unions areas: unit titles win, then the base, then the inventory title', () => {
    const { project, dir } = jobProject({ doc: { ...baseDoc(), areas: [{ id: 'checkout', title: 'Old name' }, { id: 'home', title: 'Start' }] } });
    const base = M.loadJob(dir) && JSON.parse(project.read('.journeys/journeys.json'));
    const [home, checkout, blog] = sampleUnits();
    const outs = { 'area-home': unitOutput(home), 'area-checkout': unitOutput(checkout), 'area-blog': unitOutput(blog) };
    outs['area-checkout'].areas = [{ id: 'checkout', title: 'Paying' }];
    outs['area-home'].areas = [];
    outs['area-blog'].areas = undefined;
    for (const [id, out] of Object.entries(outs)) {
      writeOut(project, id, out);
      assert.deepEqual(M.submitUnit(dir, id), { ok: true }, id);
    }
    const titles = Object.fromEntries(M.mergeUnits(dir, base).doc.areas.map((a) => [a.id, a.title]));
    assert.deepEqual(titles, { checkout: 'Paying', home: 'Start', blog: 'Blog' });
  });

  it('reports a done unit whose output is gone, and an invalid result', () => {
    const { project, dir } = jobProject();
    M.updateJob(dir, (job) => { job.units[0].status = 'done'; });
    assert.match(M.mergeUnits(dir, baseDoc()).errors[0], /"area-home" is marked done, but its output is unusable/);
    const out = unitOutput(sampleUnits()[0]);
    out.journeys[0].steps[0].next = ['ghost'];
    writeOut(project, 'area-home', out);
    assert.match(M.mergeUnits(dir, baseDoc()).errors.join('\n'), /leads to step "ghost"/);
  });
});

describe('gapUnits', () => {
  const missing = (routes) => ({ pages: { covered: 0, total: 4, missing: routes }, forms: { covered: 0, total: 0, missing: [] }, endpoints: { covered: 0, total: 0, missing: [] }, percent: 0 });

  it('plans gap units for missing pages and stops once a page was tried twice', () => {
    const { dir } = jobProject();
    M.updateJob(dir, (job) => { job.units.forEach((u) => { u.status = 'done'; }); });
    const job = M.loadJob(dir);
    const first = M.gapUnits(sampleInventory(), missing(['/blog/:param']), job);
    assert.ok(first.length > 0);
    assert.ok(first.every((u) => u.kind === 'gap' && /^gap-1/.test(u.id)));
    assert.ok(first.some((u) => u.routes.includes('/blog/:param')));
    M.addUnits(job, first);
    assert.equal(job.phase, 'stir');
    assert.deepEqual(M.gapUnits(sampleInventory(), missing(['/blog/:param']), job), [], 'waiting in a pending unit');
    job.units.forEach((u) => { u.status = 'done'; });
    assert.deepEqual(M.gapUnits(sampleInventory(), missing(['/blog/:param']), job), [], 'already tried by an area unit and a gap unit');
  });

  it('numbers new gap units after the existing ones, and tries pages nobody covered yet', () => {
    const { dir } = jobProject();
    const job = M.loadJob(dir);
    job.units.push({ id: 'gap-1', kind: 'gap', area: 'x', title: 'x', routes: ['/other'], files: [], estTokens: 1, status: 'done', tokens: 0, attempts: 1 });
    job.units.forEach((u) => { u.status = 'done'; });
    const next = M.gapUnits(sampleInventory(), missing(['/gift']), job);
    assert.ok(next.length > 0);
    assert.ok(next.every((u) => /^gap-2/.test(u.id)));
  });

  it('returns nothing when no page is missing', () => {
    const { job } = jobProject();
    assert.deepEqual(M.gapUnits(sampleInventory(), missing([]), job), []);
  });
});

describe('refreshTargets', () => {
  const inventory = sampleInventory();

  it('selects new pages and the routes of journeys that touch a changed file', () => {
    const doc = docOf([
      journey('pay', 'Pay', [step('checkout', '/checkout'), step('receipt', null, { anchor: fileAnchor('src/Nav.tsx') })]),
      journey('read', 'Read', [step('post', '/blog/:param', { detail: { files: ['src/Nav.tsx'] } })]),
      journey('quiet', 'Quiet', [step('home', '/', { anchor: fileAnchor('app/page.tsx') })]),
    ]);
    const targets = M.refreshTargets(doc, inventory, { newPages: [{ route: '/gift', file: 'app/gift/page.tsx' }], changedFiles: ['src/Nav.tsx'], removedPages: [], headChanged: true });
    assert.deepEqual(targets, { routes: ['/blog/:param', '/checkout', '/gift'], newRoutes: ['/gift'], changedJourneys: ['pay', 'read'] });
  });

  it('accepts route strings, maps a changed page file to its route, and drops routes that no longer exist', () => {
    const doc = docOf([journey('home', 'Home', [step('a', '/removed', { anchor: fileAnchor('app/page.tsx') })])]);
    const targets = M.refreshTargets(doc, inventory, { newPages: ['/gift'], changedFiles: ['app/page.tsx'] });
    assert.deepEqual(targets.routes, ['/', '/gift']);
    assert.deepEqual(targets.changedJourneys, ['home']);
  });

  it('selects nothing when nothing relevant changed', () => {
    assert.deepEqual(M.refreshTargets(baseDoc(), inventory, { newPages: [], changedFiles: ['README.txt'] }), { routes: [], newRoutes: [], changedJourneys: [] });
  });
});

describe('unit marker', () => {
  it('round-trips and finds the marker at the top of a longer prompt', () => {
    assert.equal(M.unitMarker('gap-2'), '[chefs-table unit gap-2]');
    assert.equal(M.parseUnitMarker(`${M.unitMarker('gap-2')}\nRead the brief at /x`), 'gap-2');
  });

  it('returns null for anything else', () => {
    for (const prompt of [undefined, 42, 'no marker', '[chefs-table unit ]', '[chefs-table unit a b]', '[chefs-table unit open']) {
      assert.equal(M.parseUnitMarker(prompt), null, String(prompt));
    }
  });
});

describe('writeBrief: who and sections', () => {
  const viewUnit = { id: 'area-home-people', kind: 'area', area: 'home', title: 'Home · People (part 2 of 3)', routes: ['/'], files: ['app/page.tsx'], estTokens: 100 };

  it('asks for the real role of the person and no longer teaches "Customer"', () => {
    const { dir } = jobProject();
    const text = readBrief(M.writeBrief(dir, sampleUnits()[0], sampleInventory(), baseDoc(), CLI_PATH));
    assert.ok(text.includes('"who":"<the role of the person using this, e.g. Adviser>"'));
    assert.doesNotMatch(text, /"who":"Customer"/);
    assert.ok(text.includes('Set "who" to the real role of the person using this part of the app, read from the code and on-screen text; never a placeholder.'));
    assert.ok(text.includes('- Use area id "home".'));
  });

  it('tells the helper to nest a view of a big page under the page area', () => {
    const { dir } = jobProject();
    const text = readBrief(M.writeBrief(dir, viewUnit, sampleInventory(), baseDoc(), CLI_PATH));
    assert.ok(text.includes('Declare an area with id "home-people", "parent": "home" and the plain section title "People"'));
    assert.ok(text.includes('"areas":[{"id":"home-people","title":"Plain-language area name","parent":"home"}]'));
    assert.ok(text.includes('"area":"home-people"'));
    assert.doesNotMatch(text, /- Use area id/);
  });

  it('recognises view units from their title and ignores ordinary units', () => {
    assert.deepEqual(M.viewOf(viewUnit), { key: 'people', label: 'People', areaId: 'home-people' });
    assert.deepEqual(M.viewOf({ ...viewUnit, area: 'contacts', title: 'Contacts · Meeting notes & tasks' }), { key: 'meeting-notes-tasks', label: 'Meeting notes & tasks', areaId: 'contacts-meeting-notes-tasks' });
    assert.equal(M.viewOf(sampleUnits()[0]), null);
    assert.equal(M.viewOf({ ...viewUnit, title: 'Home · ***' }), null);
    assert.ok(M.viewOf({ ...viewUnit, area: 'a'.repeat(60), title: 'Home · A long view name' }).areaId.length <= 64);
  });

  it('accepts a view unit whose parent area is known only from the inventory', () => {
    const { project, dir } = jobProject({ doc: { ...baseDoc(), areas: [] } });
    M.updateJob(dir, (job) => { job.units.push({ ...viewUnit, status: 'pending', tokens: 0, attempts: 0 }); });
    const out = unitOutput(sampleUnits()[0]);
    out.areas = [{ id: 'home-people', title: 'People', parent: 'home' }];
    out.journeys[0].area = 'home-people';
    writeOut(project, 'area-home-people', out);
    assert.deepEqual(M.submitUnit(dir, 'area-home-people'), { ok: true });
    const merged = M.mergeUnits(dir, JSON.parse(project.read('.journeys/journeys.json')));
    assert.deepEqual(merged.errors, []);
    assert.deepEqual(merged.doc.areas, [{ id: 'home-people', title: 'People', parent: 'home' }, { id: 'home', title: 'Home' }]);
  });
});

describe('organise brief', () => {
  const orgDoc = () => docOf([
    journey('buy', 'Buy a thing | fast', [step('a', '/cart'), step('b', '/checkout'), step('c', '/cart')], { area: 'shop', who: 'Customer' }),
    journey('callback', 'OAuth callback', [step('a', '/auth/callback')], { area: 'oauth' }),
    journey('loose', 'Loose end', [step('a', null)]),
  ], { areas: [{ id: 'shop', title: 'Shop' }, { id: 'oauth', title: 'OAuth', parent: 'shop' }] });

  it('starts with the marker and lists areas, journeys and the rules', () => {
    const { dir } = jobProject();
    const path = M.writeOrganiseBrief(dir, orgDoc(), CLI_PATH);
    assert.equal(path, M.organisePaths(dir).brief);
    const text = readBrief(path);
    assert.equal(text.split('\n')[0], '[chefs-table unit organise]');
    assert.match(text, /^shop \| Shop \| - \| 1$/m);
    assert.match(text, /^oauth \| OAuth \| shop \| 1$/m);
    assert.match(text, /^buy \| Buy a thing \/ fast \| shop \| Customer \| \/cart \/checkout$/m);
    assert.match(text, /^loose \| Loose end \| - \| - \| -$/m);
    for (const rule of [
      'business-level tree a non-technical owner would recognise', 'At most 8 top-level areas', 'No level with more than about 20 items',
      'giving the new areas a "parent"', 'OAuth callbacks, connect or link pages', '"Connecting accounts" or "Signing in"', 'lowercase-hyphen ids',
      'Keep existing ids and placements', 'real role of the person doing the journey', '"Adviser", "Admin", "Visitor"', 'never a placeholder',
    ]) assert.ok(text.includes(rule), rule);
    assert.ok(text.includes(`Write one JSON file: ${M.organisePaths(dir).out}`));
    assert.ok(text.includes('{ "areas": Area[], "assign": { "<journeyId>": "<areaId>" }, "who": { "<journeyId>": "<role>" } }'));
    assert.ok(text.includes(`Then run: node "${CLI_PATH}" organise apply`));
  });

  it('stays under 20k tokens for 200 journeys, even with long titles and many screens', () => {
    const { dir } = jobProject();
    const many = Array.from({ length: 200 }, (_, i) => journey(`journey-number-${i}`, `A fairly long journey title number ${i} `.repeat(8), Array.from({ length: 12 }, (__, s) => step(`s${s}`, `/section-${i}/page-${s}`)), { area: `area-${i % 40}`, who: 'Customer' }));
    const doc = docOf(many, { areas: Array.from({ length: 40 }, (_, i) => ({ id: `area-${i}`, title: `Area ${i}` })) });
    const tokens = Buffer.byteLength(readBrief(M.writeOrganiseBrief(dir, doc, CLI_PATH))) / 4;
    assert.ok(tokens < 20000, `${tokens} tokens`);
  });

  it('removes an earlier output and opens a short metering window on the job', () => {
    const { project, dir } = jobProject();
    project.write('.journeys/build/organise.out.json', '{"stale":true}');
    M.writeOrganiseBrief(dir, orgDoc(), CLI_PATH);
    assert.equal(project.exists('.journeys/build/organise.out.json'), false);
    const until = M.loadJob(dir).organiseUntil;
    assert.ok(until > Date.now() && until <= Date.now() + 31 * 60 * 1000);
    const bare = makeProject({ fixture: false });
    M.writeOrganiseBrief(bare.dir, orgDoc(), CLI_PATH);
    assert.equal(bare.exists('.journeys/build/job.json'), false, 'no job: nothing to meter');
  });
});

describe('organise apply', () => {
  const doc = () => docOf([
    journey('j1', 'One', [step('s', '/one')], { area: 'shop', who: 'Customer' }),
    journey('j2', 'Two', [step('s', '/two')], { area: 'shop', who: 'Customer' }),
    journey('j3', 'Three', [step('s', '/auth')], { area: 'oauth', who: 'Customer' }),
    journey('j4', 'Four', [step('s', '/four')], { area: 'stale', who: 'Customer' }),
    journey('j5', 'Five', [step('s', '/five')], { area: 'lost' }),
    journey('j6', 'Six', [step('s', '/six')]),
  ], { areas: [{ id: 'shop', title: 'Shop', say: 'Buying things' }, { id: 'oauth', title: 'OAuth' }, { id: 'stale', title: 'Stale', parent: 'shop' }, { id: 'lost', title: 'Lost' }] });
  const output = () => ({
    areas: [{ id: 'shop', title: 'Shop' }, { id: 'orders', title: 'Orders', parent: 'shop' }, { id: 'signing-in', title: 'Signing in' }],
    assign: { j2: 'orders', j3: 'signing-in' },
    who: { j1: 'Adviser', j2: 'You' },
  });

  it('replaces the areas, moves the assigned journeys and sets their roles', () => {
    const before = doc();
    const result = M.organiseDoc(before, output());
    assert.equal(result.ok, true);
    assert.deepEqual(result.doc.areas, [{ id: 'shop', title: 'Shop', say: 'Buying things' }, { id: 'orders', title: 'Orders', parent: 'shop' }, { id: 'signing-in', title: 'Signing in' }, { id: 'other', title: 'Other' }]);
    assert.deepEqual(result.doc.journeys.map((j) => [j.id, j.area, j.who]), [
      ['j1', 'shop', 'Adviser'], ['j2', 'orders', 'You'], ['j3', 'signing-in', 'Customer'], ['j4', 'shop', 'Customer'], ['j5', 'other', undefined], ['j6', undefined, undefined],
    ]);
    assert.equal(result.moved, 4, 'j2 and j3 assigned, j4 to its old parent, j5 to other');
    assert.deepEqual(before, doc(), 'the input is not changed');
  });

  it('keeps an unassigned journey in its area when that area still exists', () => {
    const out = { areas: [{ id: 'shop', title: 'Shop' }, { id: 'oauth', title: 'OAuth' }], assign: {} };
    const result = M.organiseDoc(doc(), out);
    assert.deepEqual(result.doc.journeys.slice(0, 3).map((j) => j.area), ['shop', 'shop', 'oauth']);
    assert.equal(result.doc.journeys[0].who, 'Customer', 'roles it was not told about stay');
  });

  it('rejects a parent that does not exist, a circle and an over-deep tree', () => {
    for (const [areas, pattern] of [
      [[{ id: 'a', title: 'A', parent: 'ghost' }], /sits inside area "ghost"/],
      [[{ id: 'a', title: 'A', parent: 'b' }, { id: 'b', title: 'B', parent: 'a' }], /circle/],
      [['a', 'b', 'c', 'd', 'e'].map((id, i, all) => ({ id, title: id, ...(i ? { parent: all[i - 1] } : {}) })), /5 levels deep/],
    ]) {
      const result = M.organiseDoc(doc(), { areas, assign: {} });
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), pattern);
    }
  });

  it('rejects journeys and areas that do not exist, bad ids and placeholder roles', () => {
    const run = (patch) => M.organiseDoc(doc(), { ...output(), ...patch });
    assert.match(run({ assign: { ghost: 'shop' } }).errors[0], /"assign" names journey "ghost", which is not on the map/);
    assert.match(run({ assign: { j1: 'nowhere' } }).errors[0], /puts journey "j1" in area "nowhere", which is not in "areas"/);
    assert.match(run({ who: { ghost: 'You' } }).errors[0], /"who" names journey "ghost"/);
    assert.match(run({ who: { j1: '<the role of the person using this, e.g. Adviser>' } }).errors[0], /looks like a placeholder/);
    assert.match(run({ who: { j1: '  ' } }).errors[0], /needs a role in words/);
    assert.match(run({ areas: [{ id: 'Bad Id!', title: 'X' }], assign: {} }).errors.join('\n'), /area id "Bad Id!" can only use letters/);
    assert.match(run({ assign: ['j1'] }).errors[0], /"assign" must be an object/);
    for (const bad of [null, [], { areas: [] }, { areas: 'x' }]) assert.match(M.organiseDoc(doc(), bad).errors[0], /non-empty "areas" list/);
  });

  it('cleans roles: control characters out, at most 40 characters', () => {
    const result = M.organiseDoc(doc(), { ...output(), who: { j1: ' Adviser\u0007\n ', j2: 'Wealth planner who also looks after every single client account' } });
    assert.equal(result.doc.journeys[0].who, 'Adviser');
    assert.equal(result.doc.journeys[1].who, 'Wealth planner who also looks after ever');
    assert.equal(result.doc.journeys[1].who.length, 40);
  });

  it('applies the output file to journeys.json, or leaves the file alone and explains', () => {
    const { project, dir } = jobProject({ doc: doc() });
    const { out } = M.organisePaths(dir);
    assert.match(M.applyOrganise(dir).errors[0], /can't find .*organise\.out\.json/);
    project.write('.journeys/build/organise.out.json', '{nope');
    assert.match(M.applyOrganise(dir).errors[0], /not valid JSON/);
    const untouched = project.read('.journeys/journeys.json');
    project.write('.journeys/build/organise.out.json', JSON.stringify({ areas: [{ id: 'a', title: 'A', parent: 'ghost' }] }));
    assert.equal(M.applyOrganise(dir).ok, false);
    assert.equal(project.read('.journeys/journeys.json'), untouched);
    project.write('.journeys/build/organise.out.json', JSON.stringify(output()));
    assert.deepEqual(M.applyOrganise(dir), { ok: true, areas: 4, top: 3, moved: 4 });
    assert.equal(JSON.parse(project.read('.journeys/journeys.json')).areas.length, 4);
    assert.ok(out.endsWith('organise.out.json'));
  });
});
