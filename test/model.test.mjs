import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  ModelError,
  applyPlan,
  loadDoc,
  sanitizeText,
  savePlanApplied,
  screensOf,
  stableStringify,
  validateDoc,
} from '../lib/model.mjs';

const step = (id, overrides = {}) => ({
  id,
  say: `Step ${id}`,
  screen: null,
  anchor: { type: 'route', value: '/x' },
  next: [],
  ...overrides,
});
const journey = (id, steps = [step('start')], overrides = {}) => ({ id, title: `Journey ${id}`, steps, ...overrides });
const doc = (journeys, extra = {}) => ({ version: 1, app: 'Demo', journeys, ...extra });

/** Asserts the doc is rejected and that some error matches the pattern. */
function assertRejected(candidate, pattern) {
  const result = validateDoc(candidate);
  assert.equal(result.ok, false, 'expected the document to be rejected');
  assert.ok(result.errors.some((message) => pattern.test(message)), `no error matched ${pattern}: ${result.errors.join(' | ')}`);
}

describe('sanitizeText', () => {
  it('strips control characters and trims', () => {
    assert.equal(sanitizeText('  he\u0000l\u001Flo\u007F \n'), 'hello');
  });

  it('caps to 200 characters', () => {
    assert.equal(sanitizeText('a'.repeat(500)).length, 200);
  });

  it('never leaves half of an emoji at the cap', () => {
    const text = `${'a'.repeat(199)}\u{1F600}`;
    assert.equal(sanitizeText(text), 'a'.repeat(199));
  });

  it('returns an empty string for non-strings', () => {
    assert.equal(sanitizeText(undefined), '');
    assert.equal(sanitizeText(42), '');
  });
});

describe('validateDoc', () => {
  it('accepts a valid document and returns a deep copy', () => {
    const input = doc([journey('pay', [step('a', { next: ['b'] }), step('b')])]);
    const result = validateDoc(input);
    assert.equal(result.ok, true);
    assert.deepEqual(result.doc, input);
    assert.notEqual(result.doc, input);
    assert.notEqual(result.doc.journeys[0], input.journeys[0]);
  });

  it('does not change its input', () => {
    const input = doc([journey('pay', [step('a', { say: '  hi\u0000 ', anchor: { type: 'file', value: 'src\\a.js' } })])]);
    const before = structuredClone(input);
    validateDoc(input);
    assert.deepEqual(input, before);
  });

  it('rejects anything that is not an object', () => {
    for (const bad of [null, undefined, 'text', 5, []]) assert.equal(validateDoc(bad).ok, false);
  });

  it('rejects a wrong version, a missing app name and missing journeys', () => {
    assertRejected({ ...doc([]), version: 2 }, /version/);
    assertRejected({ ...doc([]), app: 5 }, /"app"/);
    assertRejected({ version: 1, app: 'x' }, /"journeys"/);
  });

  it('rejects empty, too long and duplicate journey ids', () => {
    assertRejected(doc([journey('')]), /needs an "id"/);
    assertRejected(doc([journey('x'.repeat(65))]), /longer than 64/);
    assertRejected(doc([journey('pay'), journey('pay')]), /more than once/);
  });

  it('rejects ids with slashes, colons, spaces or a leading dash, naming the bad id', () => {
    for (const bad of ['a/b', 'a:b', 'a b', '-a', '_a', 'é']) {
      assertRejected(doc([journey(bad)]), new RegExp(`journey id "${bad}" can only use letters, numbers`));
      assertRejected(doc([journey('ok', [step(bad)])]), new RegExp(`step id "${bad}" can only use letters, numbers`));
      assertRejected(doc([], { areas: [{ id: bad, title: 'T' }] }), new RegExp(`area id "${bad}" can only use letters, numbers`));
    }
  });

  it('accepts ids of letters, digits, dashes and underscores up to 64 characters', () => {
    const longest = `a${'b'.repeat(63)}`;
    assert.equal(validateDoc(doc([journey(longest, [step('Step_1-b')])])).ok, true);
    assertRejected(doc([journey(`${longest}c`)]), /longer than 64/);
    assertRejected(doc([journey('ok', [step(`${longest}c`)])]), /step id .* longer than 64/);
  });

  it('allows the same step id in different journeys but not twice in one', () => {
    assert.equal(validateDoc(doc([journey('a'), journey('b')])).ok, true);
    assertRejected(doc([journey('a', [step('s'), step('s')])]), /step id "s" more than once/);
  });

  it('rejects a next id that does not exist in the same journey', () => {
    assertRejected(doc([journey('a', [step('s', { next: ['ghost'] })])]), /"ghost".*does not exist/);
    assertRejected(doc([journey('a', [step('s', { next: ['t'] })]), journey('b', [step('t')])]), /"t".*does not exist/);
  });

  it('allows steps that loop back to an earlier step', () => {
    const looping = journey('a', [step('s', { next: ['t'] }), step('t', { next: ['s'] })]);
    assert.equal(validateDoc(doc([looping])).ok, true);
  });

  it('rejects unknown anchor types', () => {
    assertRejected(doc([journey('a', [step('s', { anchor: { type: 'url', value: '/x' } })])]), /"file" or "route"/);
  });

  it('rejects file anchors that climb out of the project or are absolute', () => {
    const withFile = (value) => doc([journey('a', [step('s', { anchor: { type: 'file', value } })])]);
    assertRejected(withFile('../x'), /no "\.\."/);
    assertRejected(withFile('src/../../x'), /no "\.\."/);
    assertRejected(withFile('/abs'), /not a full path/);
    assertRejected(withFile('C:\\x'), /not a full path/);
    assertRejected(withFile('c:/x'), /not a full path/);
    assertRejected(withFile('..\\x'), /no "\.\."/);
  });

  it('normalizes backslashes in file anchors', () => {
    const result = validateDoc(doc([journey('a', [step('s', { anchor: { type: 'file', value: 'src\\app\\page.tsx' } })])]));
    assert.equal(result.doc.journeys[0].steps[0].anchor.value, 'src/app/page.tsx');
  });

  it('requires route anchors and screens to start with a slash', () => {
    assertRejected(doc([journey('a', [step('s', { anchor: { type: 'route', value: 'checkout' } })])]), /must start with "\/"/);
    assertRejected(doc([journey('a', [step('s', { screen: 'checkout' })])]), /"screen"/);
    assert.equal(validateDoc(doc([journey('a', [step('s', { screen: '/checkout' })])])).ok, true);
  });

  it('checks areas: unique ids, and journeys may only name listed areas', () => {
    const areas = [{ id: 'buy', title: 'Buying' }];
    assertRejected(doc([], { areas: [...areas, ...areas] }), /Area "buy" appears more than once/);
    assertRejected(doc([journey('a', [step('s')], { area: 'sell' })], { areas }), /area "sell".*not listed/);
    assert.equal(validateDoc(doc([journey('a', [step('s')], { area: 'buy' })], { areas })).ok, true);
  });

  describe('apps', () => {
    const app = (overrides = {}) => ({ id: 'desktop', title: 'Mac app', kind: 'desktop', root: 'packages/desktop', ...overrides });
    const withApps = (apps, journeyApps) => doc([journey('j', [step('s')], journeyApps === undefined ? {} : { apps: journeyApps })], apps === undefined ? {} : { apps });

    it('allows single-app maps, with no apps anywhere', () => {
      assert.equal(validateDoc(withApps()).ok, true);
      assert.equal(validateDoc(withApps(undefined, ['anything'])).ok, true, 'a journey tag is free text while the map lists no apps');
    });

    it('accepts a list of apps and journeys tagged with them, dropping duplicate tags and empty lists', () => {
      const result = validateDoc(withApps([app(), app({ id: 'backend', kind: 'server', root: '.' })], ['desktop', 'backend', 'desktop']));
      assert.equal(result.ok, true);
      assert.deepEqual(result.doc.journeys[0].apps, ['desktop', 'backend']);
      assert.equal(validateDoc(withApps([app()], [])).doc.journeys[0].apps, undefined);
    });

    it('checks ids: letters, digits, "-" and "_", unique', () => {
      assertRejected(withApps([app({ id: 'Mac app!' })]), /app id "Mac app!" can only use letters, numbers/);
      assertRejected(withApps([app(), app()]), /App "desktop" appears more than once/);
      assertRejected(withApps([{ title: 'x', kind: 'web', root: '.' }]), /Every app needs an "id"/);
      assertRejected(withApps({ id: 'desktop' }), /"apps" must be a list/);
    });

    it('checks the kind', () => {
      assertRejected(withApps([app({ kind: 'toaster' })]), /App "desktop": "kind" must be one of "web", "desktop", "mobile", "server", "agent"/);
      for (const kind of ['web', 'desktop', 'mobile', 'server', 'agent']) assert.equal(validateDoc(withApps([app({ kind })])).ok, true, kind);
    });

    it('checks the root: a folder inside the project, written with forward slashes', () => {
      assertRejected(withApps([app({ root: '/etc' })]), /root "\/etc" must be a folder inside the project, not a full path/);
      assertRejected(withApps([app({ root: 'C:\\apps' })]), /not a full path/);
      assertRejected(withApps([app({ root: '../outside' })]), /must stay inside the project folder/);
      assertRejected(withApps([app({ root: '' })]), /needs a "root"/);
      assertRejected(withApps([app({ root: undefined })]), /needs a "root"/);
      assert.deepEqual(validateDoc(withApps([app({ root: '.\\packages\\desktop\\' }), app({ id: 'all', root: '.' })])).doc.apps.map((a) => a.root), ['packages/desktop', '.']);
    });

    it('requires a journey\'s apps to be listed once the map lists apps', () => {
      assertRejected(withApps([app()], ['web']), /Journey "j" happens in app "web", which is not listed in "apps"/);
      assertRejected(withApps([app()], 'desktop'), /Journey "j": "apps" must be a list of app ids/);
      assertRejected(withApps([app()], ['desktop', '']), /"apps" must be a list of app ids/);
    });

    it('writes apps in a fixed order: after the app name on the map, after "who" on a journey', () => {
      const parsed = JSON.parse(stableStringify({ journeys: [{ steps: [], apps: ['desktop'], who: 'w', title: 't', id: 'j' }], apps: [{ root: 'r', kind: 'web', title: 'T', id: 'a' }], app: 'Demo', version: 1 }));
      assert.deepEqual(Object.keys(parsed), ['version', 'app', 'apps', 'journeys']);
      assert.deepEqual(Object.keys(parsed.apps[0]), ['id', 'title', 'kind', 'root']);
      assert.deepEqual(Object.keys(parsed.journeys[0]), ['id', 'title', 'who', 'apps', 'steps']);
    });
  });

  describe('area parents', () => {
    const area = (id, parent) => ({ id, title: id.toUpperCase(), ...(parent === undefined ? {} : { parent }) });
    const withAreas = (...areas) => doc([], { areas });

    it('accepts sections up to four levels deep and keeps the parent', () => {
      const result = validateDoc(withAreas(area('a'), area('b', 'a'), area('c', 'b'), area('d', 'c')));
      assert.equal(result.ok, true);
      assert.equal(result.doc.areas[3].parent, 'c');
    });

    it('rejects a parent that is missing, not text, or the area itself', () => {
      assertRejected(withAreas(area('a', 'ghost')), /Area "a" sits inside area "ghost", which is not listed in "areas"/);
      assertRejected(withAreas(area('a'), area('b', 7)), /Area "b": "parent" must be the id of the area it sits inside/);
      assertRejected(withAreas(area('a', 'a')), /Area "a" cannot sit inside itself/);
    });

    it('rejects areas that sit inside each other in a circle, once per circle', () => {
      assertRejected(withAreas(area('a', 'b'), area('b', 'c'), area('c', 'a')), /circle: "a" -> "b" -> "c" -> "a"/);
      const tail = validateDoc(withAreas(area('x', 'a'), area('a', 'b'), area('b', 'a')));
      assert.equal(tail.errors.filter((message) => /circle/.test(message)).length, 1, 'the tail leading into the circle is not a second circle');
    });

    it('rejects nesting five levels deep', () => {
      assertRejected(withAreas(area('a'), area('b', 'a'), area('c', 'b'), area('d', 'c'), area('e', 'd')), /Area "e" is nested 5 levels deep; areas can be at most 4 levels deep/);
    });

    it('lets a journey sit in a section', () => {
      const journeys = [journey('j', [step('s')], { area: 'b' })];
      assert.equal(validateDoc(doc(journeys, { areas: [area('a'), area('b', 'a')] })).ok, true);
    });
  });

  describe('step label', () => {
    const labelled = (label) => {
      const result = validateDoc(doc([journey('j', [step('s', { label })])]));
      return result.ok ? result.doc.journeys[0].steps[0].label : result.errors;
    };

    it('keeps a short label as it is', () => {
      assert.equal(labelled('Allow Gmail access'), 'Allow Gmail access');
      assert.equal(labelled('a'.repeat(48)), 'a'.repeat(48));
    });

    it('strips control characters and extra spaces', () => {
      assert.equal(labelled('  Open\u0007 the   page\n'), 'Open the page');
    });

    it('drops a label that is empty after cleaning, and a step may have none at all', () => {
      assert.equal(labelled('  \u0007 '), undefined);
      assert.equal(labelled(''), undefined);
      assert.equal(validateDoc(doc([journey('j', [step('s')])])).doc.journeys[0].steps[0].label, undefined);
    });

    it('cuts a long label at a word boundary and adds an ellipsis, within 48 characters', () => {
      const cut = labelled('See the "Waiting" popup while Google finishes signing you in');
      assert.equal(cut, 'See the "Waiting" popup while Google finishes…');
      assert.ok(cut.length <= 48);
      const oneWord = labelled('x'.repeat(80));
      assert.equal(oneWord, `${'x'.repeat(47)}…`);
      assert.equal(labelled(`${'a'.repeat(46)} bbbb`), `${'a'.repeat(46)}…`);
    });

    it('rejects a label that is not text', () => {
      assert.match(labelled(5)[0], /step "s": "label" must be text/);
    });

    it('writes the label right after the id', () => {
      const text = stableStringify(doc([journey('j', [step('s', { label: 'Do it' })])]));
      assert.deepEqual(Object.keys(JSON.parse(text).journeys[0].steps[0]).slice(0, 3), ['id', 'label', 'say']);
    });
  });

  it('allows any area value when there is no areas list', () => {
    assert.equal(validateDoc(doc([journey('a', [step('s')], { area: 'anything' })])).ok, true);
  });

  it('rejects a subflow that points nowhere or at its own journey', () => {
    assertRejected(doc([journey('a', [step('s', { subflow: 'missing' })])]), /"missing".*does not exist/);
    assertRejected(doc([journey('a', [step('s', { subflow: 'a' })])]), /own journey/);
  });

  it('rejects subflow cycles of any length', () => {
    const zoom = (id, target) => journey(id, [step('s', { subflow: target })]);
    assertRejected(doc([zoom('a', 'b'), zoom('b', 'a')]), /circle: "a" -> "b" -> "a"/);
    assertRejected(doc([zoom('a', 'b'), zoom('b', 'c'), zoom('c', 'a')]), /circle/);
    assert.equal(validateDoc(doc([zoom('a', 'b'), zoom('b', 'c'), journey('c')])).ok, true);
  });

  it('sanitizes titles, steps and details', () => {
    const dirty = doc([
      journey('a', [step('s', { say: `  hi\u0000 there${'!'.repeat(300)}`, detail: { sees: 'a\u0007b', rules: ['ok\n', '', 'x'.repeat(300)] } })], {
        title: '\u0001Title ',
        who: ' Customer\t',
      }),
    ]);
    const { journeys } = validateDoc(dirty).doc;
    assert.equal(journeys[0].title, 'Title');
    assert.equal(journeys[0].who, 'Customer');
    assert.equal(journeys[0].steps[0].say.length, 200);
    assert.ok(journeys[0].steps[0].say.startsWith('hi there'));
    assert.equal(journeys[0].steps[0].detail.sees, 'ab');
    assert.deepEqual(journeys[0].steps[0].detail.rules.map((rule) => rule.length), [2, 200]);
  });

  it('caps detail lists at 20 items', () => {
    const many = Array.from({ length: 30 }, (_, index) => `rule ${index}`);
    const result = validateDoc(doc([journey('a', [step('s', { detail: { rules: many, saves: many, files: many } })])]));
    const { detail } = result.doc.journeys[0].steps[0];
    assert.equal(detail.rules.length, 20);
    assert.equal(detail.saves.length, 20);
    assert.equal(detail.files.length, 20);
    assert.equal(detail.rules[19], 'rule 19');
  });

  it('path-checks every detail file entry like a file anchor', () => {
    const withFiles = (files) => doc([journey('a', [step('s', { detail: { files } })])]);
    assertRejected(withFiles(['src/ok.js', '../x']), /the file "\.\.\/x" must stay inside/);
    assertRejected(withFiles(['/abs']), /the file "\/abs" must be relative/);
    assertRejected(withFiles(['C:\\x']), /the file "C:\/x" must be relative/);
    assertRejected(withFiles(['a\\..\\b']), /must stay inside/);
    assertRejected(withFiles(['a\u0000b']), /contains hidden characters/);
    assertRejected(withFiles(['a.js\n']), /contains hidden characters/);
    assertRejected(withFiles([42]), /entry in "files" must be text/);
    assertRejected(withFiles('src/a.js'), /"files" must be a list/);
  });

  it('normalizes valid detail file entries and drops blanks', () => {
    const result = validateDoc(doc([journey('a', [step('s', { detail: { files: [' src\\a.js ', '', '  ', 'lib/b.js'] } })])]));
    assert.deepEqual(result.doc.journeys[0].steps[0].detail.files, ['src/a.js', 'lib/b.js']);
  });

  it('reports every problem, not just the first', () => {
    const result = validateDoc({ version: 3, app: 1, journeys: [journey('a'), journey('a')] });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 3);
  });
});

describe('screensOf', () => {
  it('collects the distinct non-null screens', () => {
    const screens = screensOf(journey('a', [step('1', { screen: '/a' }), step('2', { screen: null }), step('3', { screen: '/a' }), step('4', { screen: '/b' })]));
    assert.deepEqual([...screens].sort(), ['/a', '/b']);
  });
});

describe('applyPlan', () => {
  const base = () => doc([journey('a'), journey('b'), journey('c')]);

  it('removes first, then replaces in place and appends new journeys', () => {
    const next = applyPlan(base(), {
      summary: '',
      remove: ['b'],
      upsert: [journey('d'), journey('a', [step('start')], { title: 'A again' })],
    });
    assert.deepEqual(next.journeys.map((entry) => entry.id), ['a', 'c', 'd']);
    assert.equal(next.journeys[0].title, 'A again');
  });

  it('re-adds a journey that is both removed and upserted at the end', () => {
    const next = applyPlan(base(), { summary: '', remove: ['a'], upsert: [journey('a')] });
    assert.deepEqual(next.journeys.map((entry) => entry.id), ['b', 'c', 'a']);
  });

  it('does not modify its inputs and shares no objects with them', () => {
    const original = base();
    const plan = { summary: '', remove: [], upsert: [journey('a', [step('start')], { title: 'changed' })] };
    const snapshot = structuredClone({ original, plan });
    const next = applyPlan(original, plan);
    next.journeys[0].title = 'mutated';
    next.journeys[1].steps[0].say = 'mutated';
    assert.deepEqual({ original, plan }, snapshot);
  });
});

describe('stableStringify', () => {
  it('writes keys in the contract order with unknown keys after, alphabetically', () => {
    const messy = {
      zeta: 1,
      journeys: [{ steps: [{ subflow: 'b', detail: { files: ['f'], sees: 's' }, next: [], anchor: { value: '/x', type: 'route' }, screen: null, say: 'hi', id: 's', extra: { b: 1, a: 2 } }], who: 'w', area: 'a', title: 't', id: 'j', alpha: true }, journey('b')],
      areas: [{ say: 'x', title: 'T', id: 'a' }],
      app: 'Demo',
      version: 1,
    };
    const parsed = JSON.parse(stableStringify(messy));
    assert.deepEqual(Object.keys(parsed), ['version', 'app', 'areas', 'journeys', 'zeta']);
    assert.deepEqual(Object.keys(parsed.areas[0]), ['id', 'title', 'say']);
    assert.deepEqual(Object.keys(parsed.journeys[0]), ['id', 'title', 'area', 'who', 'steps', 'alpha']);
    const firstStep = parsed.journeys[0].steps[0];
    assert.deepEqual(Object.keys(firstStep), ['id', 'say', 'screen', 'anchor', 'next', 'detail', 'subflow', 'extra']);
    assert.deepEqual(Object.keys(firstStep.anchor), ['type', 'value']);
    assert.deepEqual(Object.keys(firstStep.detail), ['sees', 'files']);
    assert.deepEqual(Object.keys(firstStep.extra), ['a', 'b']);
  });

  it('is deterministic whatever order the keys were inserted in', () => {
    const forward = doc([journey('a')]);
    const reversed = Object.fromEntries(Object.entries(forward).reverse());
    reversed.journeys = [Object.fromEntries(Object.entries(forward.journeys[0]).reverse())];
    assert.equal(stableStringify(forward), stableStringify(reversed));
  });

  it('indents with two spaces and ends with exactly one newline', () => {
    const text = stableStringify(doc([]));
    assert.ok(text.startsWith('{\n  "version": 1,'));
    assert.ok(text.endsWith('}\n'));
    assert.ok(!text.endsWith('\n\n'));
  });
});

describe('loadDoc and savePlanApplied', () => {
  let dir;
  let path;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chefs-table-model-'));
    path = join(dir, 'journeys.json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (document) => writeFileSync(path, stableStringify(document));
  const ids = () => loadDoc(path).doc.journeys.map((entry) => entry.id);

  it('loads a document with its mtime and the sha1 of the raw text', () => {
    write(doc([journey('pay')]));
    const loaded = loadDoc(path);
    assert.equal(loaded.doc.journeys[0].id, 'pay');
    assert.equal(loaded.mtimeMs, statSync(path).mtimeMs);
    assert.equal(loaded.hash, createHash('sha1').update(readFileSync(path, 'utf8')).digest('hex'));
  });

  it('loads a file that starts with a byte-order mark', () => {
    writeFileSync(path, `\uFEFF${stableStringify(doc([journey('pay')]))}`);
    assert.deepEqual(ids(), ['pay']);
  });

  it('explains a missing file in plain words', () => {
    assert.throws(() => loadDoc(join(dir, 'nope.json')), (error) => error instanceof ModelError && /can't find the journey map/.test(error.message));
  });

  it('names the line and column of a JSON mistake', () => {
    writeFileSync(path, '{"version": 1,}');
    assert.throws(() => loadDoc(path), (error) => error instanceof ModelError && /not valid JSON.*line 1, column 15 \(character 14\)/.test(error.message));
  });

  it('says so when the file ends too early or is empty', () => {
    writeFileSync(path, '{"version":\n');
    assert.throws(() => loadDoc(path), /ends too early.*line 2, column 1/);
    writeFileSync(path, '  \n');
    assert.throws(() => loadDoc(path), /is empty/);
  });

  it('lists every validation problem in the error', () => {
    writeFileSync(path, JSON.stringify({ version: 2, app: 5, journeys: [] }));
    assert.throws(() => loadDoc(path), (error) => error instanceof ModelError && /"version": 1/.test(error.message) && /"app"/.test(error.message) && error.errors.length === 2);
  });

  it('saves a plan, returns the new document and leaves no temp files behind', () => {
    write(doc([journey('pay')]));
    const lastDoc = loadDoc(path).doc;
    const { doc: saved, twoChats } = savePlanApplied(path, { summary: 's', upsert: [journey('book')], remove: [] }, { lastDoc });
    assert.deepEqual(saved.journeys.map((entry) => entry.id), ['pay', 'book']);
    assert.deepEqual(twoChats, []);
    assert.deepEqual(ids(), ['pay', 'book']);
    assert.equal(readFileSync(path, 'utf8'), stableStringify(saved));
    assert.deepEqual(readdirSync(dir), ['journeys.json']);
  });

  it('keeps both journeys when another chat writes a different journey mid-save', () => {
    write(doc([journey('pay')]));
    const lastDoc = loadDoc(path).doc;
    const otherChat = () => {
      const onDisk = loadDoc(path).doc;
      onDisk.journeys.push(journey('refund'));
      write(onDisk);
    };
    const { twoChats } = savePlanApplied(path, { summary: '', upsert: [journey('book')], remove: [] }, { lastDoc, _beforeWrite: otherChat });
    assert.deepEqual(ids(), ['pay', 'refund', 'book']);
    assert.deepEqual(twoChats, []);
    assert.deepEqual(readdirSync(dir), ['journeys.json']);
  });

  it('flags a journey that was edited on disk since the last turn', () => {
    write(doc([journey('pay'), journey('refund')]));
    const lastDoc = loadDoc(path).doc;
    const edited = loadDoc(path).doc;
    edited.journeys[0].title = 'Edited elsewhere';
    write(edited);
    const plan = { summary: '', upsert: [journey('pay', [step('start')], { title: 'Mine' }), journey('refund')], remove: [] };
    const { twoChats } = savePlanApplied(path, plan, { lastDoc });
    assert.deepEqual(twoChats, ['pay']);
    assert.equal(loadDoc(path).doc.journeys[0].title, 'Mine');
  });

  it('flags a collision that happens during the save and recomputes it on the newer file', () => {
    write(doc([journey('pay')]));
    const lastDoc = loadDoc(path).doc;
    const otherChat = () => {
      const onDisk = loadDoc(path).doc;
      onDisk.journeys[0].title = 'Edited mid-save';
      write(onDisk);
    };
    const plan = { summary: '', upsert: [journey('pay', [step('start')], { title: 'Mine' })], remove: [] };
    const { twoChats } = savePlanApplied(path, plan, { lastDoc, _beforeWrite: otherChat });
    assert.deepEqual(twoChats, ['pay']);
    assert.equal(loadDoc(path).doc.journeys[0].title, 'Mine');
  });

  it('does not flag a journey that is absent from both the disk and the last document', () => {
    write(doc([journey('pay')]));
    const { twoChats } = savePlanApplied(path, { summary: '', upsert: [journey('brand-new')], remove: [] }, { lastDoc: loadDoc(path).doc });
    assert.deepEqual(twoChats, []);
  });

  it('flags a journey someone else created or deleted since the last turn', () => {
    write(doc([journey('pay')]));
    const lastDoc = doc([journey('gone')]);
    const { twoChats } = savePlanApplied(path, { summary: '', upsert: [journey('pay'), journey('gone')], remove: [] }, { lastDoc });
    assert.deepEqual(twoChats.sort(), ['gone', 'pay']);
  });

  it('applies removals', () => {
    write(doc([journey('pay'), journey('refund')]));
    savePlanApplied(path, { summary: '', upsert: [], remove: ['pay'] }, { lastDoc: loadDoc(path).doc });
    assert.deepEqual(ids(), ['refund']);
  });

  it('refuses a plan that would make the document invalid and leaves the file alone', () => {
    write(doc([journey('pay')]));
    const before = readFileSync(path, 'utf8');
    const bad = journey('book', [step('s', { anchor: { type: 'file', value: '../x' } })]);
    assert.throws(() => savePlanApplied(path, { summary: '', upsert: [bad], remove: [] }, {}), (error) => error instanceof ModelError && /nothing was saved/.test(error.message));
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.deepEqual(readdirSync(dir), ['journeys.json']);
  });

  it('throws a ModelError when the file does not exist', () => {
    assert.throws(() => savePlanApplied(join(dir, 'nope.json'), { summary: '', upsert: [], remove: [] }), ModelError);
  });
});
