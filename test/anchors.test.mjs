import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeRoute,
  routeFromNextFile,
  listRouteFiles,
  isNextProject,
  extractDefinitions,
  extractMentions,
  checkAnchors,
  filesForStep,
} from '../lib/anchors.mjs';
import { DEFAULT_CONFIG } from '../lib/types.mjs';

const fixture = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', name);
const NEXT = fixture('next-app');
const VITE = fixture('vite-router');
const DIRS = DEFAULT_CONFIG.routeDirs;
const route = (value) => ({ type: 'route', value });
const file = (value) => ({ type: 'file', value });
const step = (anchor, id = 's') => ({ id, say: 'step', screen: null, anchor, next: [] });

/** Creates a temp project (relative posix path to contents), removed when the test ends. */
function project(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-anchors-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const fileAbs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
    fs.writeFileSync(fileAbs, contents);
  }
  return dir;
}

/** One journey "j" whose step i has the i-th anchor: keys "s:j/s0", "s:j/s1", ... */
const docWith = (...anchors) => ({
  version: 1,
  app: 'test',
  journeys: [{ id: 'j', title: 'J', steps: anchors.map((anchor, i) => step(anchor, `s${i}`)) }],
});

const stateOf = (rootAbs, anchor, config) => checkAnchors(docWith(anchor), { rootAbs, config }).results['s:j/s0'];

/** Asserts each [input, expected] row against fn. */
function table(fn, rows) {
  for (const [input, expected] of rows) assert.equal(fn(input), expected, String(input));
}

describe('normalizeRoute', () => {
  test('parameter styles compare equal; catch-alls become :param*', () => {
    table(normalizeRoute, [
      ['/blog/[id]', '/blog/:param'],
      ['/blog/:postId', '/blog/:param'],
      ['/blog/:id?', '/blog/:param'],
      ['/docs/[...slug]', '/docs/:param*'],
      ['/docs/[[...slug]]', '/docs/:param*'],
      ['/docs/:rest*', '/docs/:param*'],
      ['/files/*', '/files/:param*'],
    ]);
  });

  test('slashes are tidied but the root survives', () => {
    table(normalizeRoute, [['/checkout/', '/checkout'], ['//a///b//', '/a/b'], ['checkout', '/checkout'], ['/', '/'], ['', '/']]);
  });
});

describe('routeFromNextFile', () => {
  test('app router: page files only; groups and slots dropped', () => {
    table((p) => routeFromNextFile(p, DIRS), [
      ['app/page.tsx', '/'],
      ['app/(shop)/checkout/page.tsx', '/checkout'],
      ['app/blog/[id]/page.tsx', '/blog/:id'],
      ['app/docs/[...slug]/page.mdx', '/docs/:slug*'],
      ['app/docs/[[...slug]]/page.js', '/docs/:slug*'],
      ['app/dash/@stats/page.tsx', '/dash'],
      ['src/app/(a)/(b)/x/page.jsx', '/x'],
      ['app/layout.tsx', null],
      ['app/checkout/loading.tsx', null],
      ['app/checkout/page.css', null],
      ['app/api/pay/route.ts', null],
      ['app/_components/page.tsx', null],
    ]);
  });

  test('pages router: files are routes; api and special files are not screens', () => {
    table((p) => routeFromNextFile(p, DIRS), [
      ['pages/checkout.tsx', '/checkout'],
      ['pages/index.tsx', '/'],
      ['pages/blog/[id].tsx', '/blog/:id'],
      ['pages/blog/index.js', '/blog'],
      ['src/pages/shop/[...all].ts', '/shop/:all*'],
      ['pages/api.tsx', '/api'],
      ['pages/api/pay.ts', null],
      ['pages/_app.tsx', null],
      ['pages/_document.tsx', null],
      ['pages/_error.tsx', null],
      ['pages/styles.css', null],
    ]);
  });

  test('other directories, "routes" included, and backslash paths', () => {
    table((p) => routeFromNextFile(p, DIRS), [
      ['src/routes/+page.svelte', null],
      ['src/routes/checkout/page.tsx', null],
      ['src/components/Nav.tsx', null],
      ['app\\(shop)\\checkout\\page.tsx', '/checkout'],
    ]);
    assert.equal(routeFromNextFile('web/app/page.tsx', ['web/app']), '/');
  });
});

describe('listRouteFiles', () => {
  test('next-app fixture: sorted by file, api and layout excluded', () => {
    assert.deepEqual(listRouteFiles(NEXT, DEFAULT_CONFIG), [
      { file: 'app/(shop)/checkout/page.tsx', route: '/checkout' },
      { file: 'app/blog/[id]/page.tsx', route: '/blog/:id' },
      { file: 'app/page.tsx', route: '/' },
      { file: 'pages/legacy.tsx', route: '/legacy' },
    ]);
    assert.deepEqual(listRouteFiles(VITE, DEFAULT_CONFIG), [{ file: 'src/pages/Home.tsx', route: '/Home' }]);
  });

  test('honors config.root and config.ignore; files stay repo-relative', (t) => {
    const root = project(t, { 'web/app/page.tsx': '', 'web/app/about/page.tsx': '', 'web/app/about/page.test.tsx': '', 'app/page.tsx': '' });
    assert.deepEqual(listRouteFiles(root, { ...DEFAULT_CONFIG, root: 'web' }), [
      { file: 'web/app/about/page.tsx', route: '/about' },
      { file: 'web/app/page.tsx', route: '/' },
    ]);
  });
});

describe('isNextProject', () => {
  test('fixtures: next-app is Next, vite-router (with a src/pages component) is not', () => {
    assert.equal(isNextProject(NEXT), true);
    assert.equal(isNextProject(VITE), false);
  });

  test('"next" in dependencies or devDependencies counts, even without route files', (t) => {
    assert.equal(isNextProject(project(t, { 'package.json': '{"dependencies":{"next":"14"}}' })), true);
    assert.equal(isNextProject(project(t, { 'package.json': '{"devDependencies":{"next":"14"}}' })), true);
    assert.equal(isNextProject(project(t, { 'package.json': '{"dependencies":{"nextra":"1"}}' })), false);
  });

  test('package.json is read at config.root or the repo root', (t) => {
    const config = { ...DEFAULT_CONFIG, root: 'web' };
    assert.equal(isNextProject(project(t, { 'web/package.json': '{"dependencies":{"next":"14"}}' }), config), true);
    assert.equal(isNextProject(project(t, { 'package.json': '{"dependencies":{"next":"14"}}', 'web/x.ts': '' }), config), true);
  });

  test('an app-router page counts without a package.json; a bare pages folder or broken manifest does not', (t) => {
    assert.equal(isNextProject(project(t, { 'app/page.tsx': '' })), true);
    assert.equal(isNextProject(project(t, { 'src/app/about/page.tsx': '' })), true);
    assert.equal(isNextProject(project(t, { 'pages/index.tsx': '' })), false);
    assert.equal(isNextProject(project(t, { 'pages/index.tsx': '', 'package.json': '{oops' })), false);
    assert.equal(isNextProject(project(t, { 'app/layout.tsx': '' })), false);
  });
});

describe('extractDefinitions / extractMentions', () => {
  test('definitions: config objects and JSX route elements', () => {
    const text = `
      createBrowserRouter([{ path: '/a' }, { path: "/b/:id" }, { path: \`/c\` }]);
      <Route path="/d" element={<D />} /> <Route index path={'/e'} /> <Route element={<L />} path='/f/*' />`;
    assert.deepEqual(extractDefinitions(text), ['/a', '/b/:param', '/c', '/d', '/e', '/f/:param*']);
    assert.deepEqual(extractDefinitions(`{ path: '/a' }, { path: '/a/' }`), ['/a']);
  });

  test('definitions ignore relative paths, plain variables and look-alikes', () => {
    const text = `{ path: 'settings' } const path = '/x'; const filepath: s = '/x'; <Link pathname="/y" /> navigate('/z')`;
    assert.deepEqual(extractDefinitions(text), []);
  });

  test('mentions: quoted literals starting with a slash, query dropped', () => {
    const text = `<a href="/book">x</a> navigate('/checkout?step=2'); fetch(\`/api/pay\`); 'no slash'; src="//cdn.example.com/x.js"`;
    assert.deepEqual(extractMentions(text), ['/book', '/checkout', '/api/pay']);
  });

  test('"/book" is not found inside "/bookings"', () => {
    assert.deepEqual(extractMentions(`navigate('/bookings')`), ['/bookings']);
    assert.ok(!extractMentions(`<a href="/bookings/new">`).includes('/book'));
  });
});

describe('checkAnchors: Next project', () => {
  test('route anchors resolve through folders, groups and params', () => {
    const doc = docWith(route('/'), route('/checkout'), route('/blog/[id]'), route('/blog/:postId'), route('/legacy/'));
    const { results, cache } = checkAnchors(doc, { rootAbs: NEXT });
    assert.deepEqual(Object.values(results), ['ok', 'ok', 'ok', 'ok', 'ok']);
    assert.equal(cache.isNext, true);
  });

  test('a route with no Next file is broken, even if the code mentions it; api is not a screen', () => {
    for (const missing of ['/book', '/nowhere', '/api/pay', '/pay']) assert.equal(stateOf(NEXT, route(missing)), 'broken', missing);
  });

  test('file anchors check existence', () => {
    assert.equal(stateOf(NEXT, file('app/layout.tsx')), 'ok');
    assert.equal(stateOf(NEXT, file('app/(shop)/checkout/page.tsx')), 'ok');
    assert.equal(stateOf(NEXT, file('app/missing.tsx')), 'broken');
  });
});

describe('checkAnchors: non-Next project', () => {
  test('a src/pages component folder does not make routes broken', () => {
    const doc = docWith(route('/bookings'), route('/book'), route('/nowhere'), route('/Home'));
    assert.deepEqual(Object.values(checkAnchors(doc, { rootAbs: VITE }).results), ['ok', 'unverified', 'unverified', 'unverified']);
  });

  test('pages-only project: broken only once package.json declares next', (t) => {
    const pages = { 'pages/index.tsx': '', 'pages/about.tsx': '' };
    const plain = project(t, pages);
    assert.equal(stateOf(plain, route('/about')), 'unverified');
    assert.equal(stateOf(plain, route('/missing')), 'unverified');

    const next = project(t, { ...pages, 'package.json': '{"dependencies":{"next":"14"}}' });
    assert.equal(stateOf(next, route('/about')), 'ok');
    assert.equal(stateOf(next, route('/missing')), 'broken');
  });

  test('a definition satisfies the anchor, and :postId equals :id', () => {
    for (const ok of ['/bookings', '/blog/:id', '/blog/[id]']) assert.equal(stateOf(VITE, route(ok)), 'ok', ok);
  });

  test('mentioned-only, absent and unknown-type anchors are unverified, never broken', () => {
    assert.equal(stateOf(VITE, route('/book')), 'unverified');
    assert.equal(stateOf(VITE, route('/nowhere')), 'unverified');
    assert.equal(stateOf(VITE, { type: 'api', value: '/x' }), 'unverified');
  });

  test('regex metacharacters in a route are inert', (t) => {
    const root = project(t, { 'src/routes.ts': `export default [{ path: '/a.b' }, { path: '/x(y)' }];` });
    assert.equal(stateOf(root, route('/a.b')), 'ok');
    assert.equal(stateOf(root, route('/axb')), 'unverified');
    assert.equal(stateOf(root, route('/x(y)')), 'ok');
    for (const hostile of ['/(.*)', '/[', '/a+(b', '/a\\', '/.*', '/?', '/{1,}', '/$^']) {
      assert.equal(stateOf(root, route(hostile)), 'unverified', hostile);
    }
  });
});

describe('checkAnchors: file anchors', () => {
  test('backslash paths work', () => {
    assert.equal(stateOf(NEXT, file('src\\components\\Nav.tsx')), 'ok');
    assert.equal(stateOf(NEXT, file('.\\src\\components\\Nav.tsx')), 'ok');
    assert.equal(stateOf(NEXT, file('src\\components\\Gone.tsx')), 'broken');
  });

  test('empty values and paths outside the root are broken', (t) => {
    const root = project(t, { 'inner/app.ts': '', 'outside.txt': '' });
    const inner = path.join(root, 'inner');
    for (const bad of ['', '../outside.txt', path.join(root, 'outside.txt')]) assert.equal(stateOf(inner, file(bad)), 'broken', bad);
    assert.equal(stateOf(inner, file('app.ts')), 'ok');
  });

  test('config.root moves route scanning but file anchors stay repo-relative', (t) => {
    const root = project(t, { 'web/app/about/page.tsx': '', 'web/src/x.ts': `[{ path: '/named' }]` });
    const config = { ...DEFAULT_CONFIG, root: 'web' };
    assert.equal(stateOf(root, file('web/src/x.ts'), config), 'ok');
    assert.equal(stateOf(root, route('/about'), config), 'ok');
    assert.equal(stateOf(root, route('/named'), config), 'broken');
  });
});

describe('checkAnchors: cache', () => {
  const MAIN = { 'src/main.tsx': `[{ path: '/real' }]`, 'src/other.ts': `export const link = '/there';` };
  const opts = (root, cache) => ({ rootAbs: root, config: DEFAULT_CONFIG, cache });

  test('a full walk reuses entries whose mtime is unchanged and re-reads the rest', (t) => {
    const root = project(t, MAIN);
    const doc = docWith(route('/real'), route('/planted'));
    const first = checkAnchors(doc, opts(root));
    assert.deepEqual(first.results, { 's:j/s0': 'ok', 's:j/s1': 'unverified' });

    const planted = structuredClone(first.cache);
    planted.files['src/main.tsx'].defs = ['/planted'];
    const full = (cache) => ({ ...opts(root, cache), full: true });
    assert.deepEqual(checkAnchors(doc, full(planted)).results, { 's:j/s0': 'unverified', 's:j/s1': 'ok' });

    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, 'src', 'main.tsx'), later, later);
    const rescanned = checkAnchors(doc, full(planted));
    assert.deepEqual(rescanned.results, first.results);
    assert.notEqual(rescanned.cache.files['src/main.tsx'].mtimeMs, first.cache.files['src/main.tsx'].mtimeMs);
  });

  test('cache is plain JSON, is not mutated, and a full walk drops deleted files', (t) => {
    const root = project(t, { ...MAIN, 'src/empty.ts': 'export {};' });
    const doc = docWith(route('/real'));
    const { cache } = checkAnchors(doc, opts(root));
    assert.deepEqual(JSON.parse(JSON.stringify(cache)), cache);
    assert.equal(cache.isNext, false);
    assert.equal(cache.indexed, true);
    assert.deepEqual(Object.keys(cache.files).sort(), ['src/main.tsx', 'src/other.ts']);

    fs.rmSync(path.join(root, 'src', 'other.ts'));
    const before = JSON.stringify(cache);
    const next = checkAnchors(doc, { ...opts(root, cache), full: true });
    assert.equal(JSON.stringify(cache), before);
    assert.deepEqual(Object.keys(next.cache.files), ['src/main.tsx']);
  });

  test('file-only documents never scan the source tree', (t) => {
    const root = project(t, MAIN);
    assert.deepEqual(checkAnchors(docWith(file('src/other.ts')), opts(root)).cache.files, {});
  });

  test('`only` re-checks just those steps and copies the rest from the cache', (t) => {
    const root = project(t, { 'a.ts': '', 'b.ts': '' });
    const doc = docWith(file('a.ts'), file('b.ts'));
    const first = checkAnchors(doc, { rootAbs: root });
    fs.rmSync(path.join(root, 'a.ts'));
    fs.rmSync(path.join(root, 'b.ts'));

    const partial = checkAnchors(doc, { rootAbs: root, cache: first.cache, only: new Set(['s:j/s0']) });
    assert.deepEqual(partial.results, { 's:j/s0': 'broken', 's:j/s1': 'ok' });
    assert.deepEqual(checkAnchors(doc, { rootAbs: root, cache: first.cache, only: new Set() }).results, first.results);
    assert.deepEqual(checkAnchors(doc, { rootAbs: root, cache: partial.cache }).results, { 's:j/s0': 'broken', 's:j/s1': 'broken' });
  });

  test('`only` leaves out steps the cache knows nothing about, and skips unneeded scans', (t) => {
    const root = project(t, MAIN);
    assert.deepEqual(checkAnchors(docWith(file('src/other.ts'), file('src/other.ts')), { rootAbs: root, only: new Set(['s:j/s1']) }).results, { 's:j/s1': 'ok' });

    const doc = docWith(route('/real'), file('src/other.ts'));
    const first = checkAnchors(doc, opts(root));
    const second = checkAnchors(doc, { ...opts(root, first.cache), only: new Set(['s:j/s1']) });
    assert.deepEqual(second.cache.files, first.cache.files);
    assert.deepEqual(second.results, first.results);
  });
});

describe('checkAnchors: incremental index', () => {
  const FILES = {
    'src/routes.tsx': `[{ path: '/old' }]`,
    'src/a.ts': `fetch('/a')`,
    'src/b.ts': `go('/b')`,
    'src/empty.ts': 'export {};',
  };
  const doc = docWith(route('/old'), route('/fresh'));

  /** Project plus a read log; `check` runs checkAnchors with the log attached and returns what was read. */
  function indexed(t, extra = {}) {
    const root = project(t, { ...FILES, ...extra });
    const reads = [];
    const _readFile = (fileAbs) => {
      reads.push(path.relative(root, fileAbs).split(path.sep).join('/'));
      return fs.readFileSync(fileAbs, 'utf8');
    };
    const check = (options = {}) => {
      reads.length = 0;
      const result = checkAnchors(options.doc ?? doc, { rootAbs: root, config: DEFAULT_CONFIG, _readFile, ...options });
      return { ...result, reads: [...reads].sort() };
    };
    return { root, check, write: (rel, text) => fs.writeFileSync(path.join(root, ...rel.split('/')), text) };
  }

  test('the first call walks everything and keeps only files with a definition or mention', (t) => {
    const { check } = indexed(t);
    const { cache, reads, results } = check();
    assert.deepEqual(reads, ['src/a.ts', 'src/b.ts', 'src/empty.ts', 'src/routes.tsx']);
    assert.equal(cache.indexed, true);
    assert.deepEqual(Object.keys(cache.files).sort(), ['src/a.ts', 'src/b.ts', 'src/routes.tsx']);
    assert.deepEqual(results, { 's:j/s0': 'ok', 's:j/s1': 'unverified' });
  });

  test('an indexed cache reads only changedFiles; a new definition flips unverified to ok', (t) => {
    const { check, write } = indexed(t);
    const { cache } = check();
    write('src/routes.tsx', `[{ path: '/old' }, { path: '/fresh' }]`);
    write('src/a.ts', `fetch('/changed-but-unreported')`);

    const next = check({ cache, changedFiles: ['src\\routes.tsx'] });
    assert.deepEqual(next.reads, ['src/routes.tsx']);
    assert.deepEqual(next.results, { 's:j/s0': 'ok', 's:j/s1': 'ok' });
    assert.deepEqual(next.cache.files['src/a.ts'], cache.files['src/a.ts']);
    assert.equal(next.cache.indexed, true);
  });

  test('without changedFiles an indexed cache is trusted and nothing is read', (t) => {
    const { check, write } = indexed(t);
    const { cache } = check();
    write('src/routes.tsx', `[{ path: '/fresh' }]`);
    const next = check({ cache });
    assert.deepEqual(next.reads, []);
    assert.deepEqual(next.results, { 's:j/s0': 'ok', 's:j/s1': 'unverified' });
  });

  test('a deleted or emptied changed file loses its definitions', (t) => {
    const { root, check, write } = indexed(t);
    const { cache } = check();
    fs.rmSync(path.join(root, 'src', 'routes.tsx'));
    const deleted = check({ cache, changedFiles: ['src/routes.tsx'] });
    assert.deepEqual(deleted.reads, []);
    assert.deepEqual(deleted.results, { 's:j/s0': 'unverified', 's:j/s1': 'unverified' });
    assert.ok(!('src/routes.tsx' in deleted.cache.files));

    write('src/a.ts', 'export {};');
    const emptied = check({ cache: deleted.cache, changedFiles: ['src/a.ts'] });
    assert.ok(!('src/a.ts' in emptied.cache.files));
  });

  test('changedFiles outside sourceGlobs, ignored, unsupported or outside the root are not read', (t) => {
    const { check } = indexed(t, { 'lib/x.ts': `'/x'`, 'src/a.test.ts': `'/t'`, 'src/notes.txt': `'/n'` });
    const { cache } = check();
    const skipped = ['lib/x.ts', 'src/a.test.ts', 'src/notes.txt', 'README.md', '../src/a.ts', 'node_modules/p/i.js'];
    assert.deepEqual(check({ cache, changedFiles: skipped }).reads, []);
  });

  test('changedFiles are repo-relative when config.root is set', (t) => {
    const { check, write } = indexed(t, { 'web/src/r.ts': `[{ path: '/web-route' }]` });
    const config = { ...DEFAULT_CONFIG, root: 'web' };
    const webDoc = docWith(route('/web-route'), route('/web-new'));
    const { cache } = check({ config, doc: webDoc });
    assert.deepEqual(Object.keys(cache.files), ['web/src/r.ts']);
    write('web/src/r.ts', `[{ path: '/web-route' }, { path: '/web-new' }]`);
    const next = check({ config, doc: webDoc, cache, changedFiles: ['web/src/r.ts', 'src/a.ts'] });
    assert.deepEqual(next.reads, ['web/src/r.ts']);
    assert.deepEqual(Object.values(next.results), ['ok', 'ok']);
  });

  test('full: true walks again and finds changes nobody reported', (t) => {
    const { root, check, write } = indexed(t);
    const { cache } = check();
    write('src/new.ts', `go('/n')`);
    write('src/routes.tsx', `[{ path: '/fresh' }]`);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, 'src', 'routes.tsx'), later, later);
    const next = check({ cache, full: true });
    assert.deepEqual(next.reads, ['src/empty.ts', 'src/new.ts', 'src/routes.tsx']);
    assert.deepEqual(next.results, { 's:j/s0': 'unverified', 's:j/s1': 'ok' });
    assert.deepEqual(Object.keys(next.cache.files).sort(), ['src/a.ts', 'src/b.ts', 'src/new.ts', 'src/routes.tsx']);
  });

  test('an empty `only` returns the cached results without touching the filesystem', (t) => {
    const { check } = indexed(t);
    const { cache, results } = check();
    const touched = ['statSync', 'readdirSync', 'readFileSync', 'existsSync'].map((name) => t.mock.method(fs, name));
    const next = check({ cache, only: new Set(), doc: docWith(route('/old'), route('/fresh'), file('nope.ts')) });
    assert.deepEqual(touched.map((spy) => spy.mock.callCount()), [0, 0, 0, 0]);
    assert.deepEqual(next.results, results);
    assert.equal(next.cache.indexed, true);
  });

  test('isNext stays cached across calls that do no route work', () => {
    const first = checkAnchors(docWith(route('/checkout')), { rootAbs: NEXT });
    assert.equal(first.cache.isNext, true);
    const second = checkAnchors(docWith(route('/checkout')), { rootAbs: NEXT, cache: first.cache, only: new Set() });
    assert.equal(second.cache.isNext, true);
    assert.deepEqual(second.cache.routeFiles, first.cache.routeFiles);
  });
});

describe('filesForStep', () => {
  test('file anchor: its own normalized path', () => {
    assert.deepEqual(filesForStep(step(file('.\\src\\Nav.tsx'))), ['src/Nav.tsx']);
    assert.deepEqual(filesForStep(step(file(''))), []);
  });

  test('route anchor in Next: the route file', () => {
    const { cache } = checkAnchors(docWith(route('/checkout')), { rootAbs: NEXT });
    assert.deepEqual(filesForStep(step(route('/checkout')), cache), ['app/(shop)/checkout/page.tsx']);
    assert.deepEqual(filesForStep(step(route('/blog/:anything')), cache), ['app/blog/[id]/page.tsx']);
    assert.deepEqual(filesForStep(step(route('/book')), cache), []);
  });

  test('route anchor elsewhere: files that define it, never ones that only mention it', () => {
    const { cache } = checkAnchors(docWith(route('/bookings')), { rootAbs: VITE });
    assert.deepEqual(filesForStep(step(route('/blog/:id')), cache), ['src/main.tsx']);
    assert.deepEqual(filesForStep(step(route('/bookings')), cache), ['src/main.tsx']);
    assert.deepEqual(filesForStep(step(route('/book')), cache), []);
    assert.deepEqual(filesForStep(step(route('/checkout'))), []);
  });
});
