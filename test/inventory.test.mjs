import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInventory, coverage, diffInventory, planUnits, readGitHead } from '../lib/inventory.mjs';
import { appForFile, findApps } from '../lib/apps.mjs';
import { DEFAULT_CONFIG, PIPELINE } from '../lib/types.mjs';

const fixture = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', name);
const RICH = fixture('rich-app');
const NEXT = fixture('next-app');
const VITE = fixture('vite-router');
const SPA = fixture('spa-app');
const MULTI = fixture('multi-app');
const RICH_CONFIG = { ...DEFAULT_CONFIG, sourceGlobs: ['src/**', 'server/**', 'emails/**', 'prisma/**'] };
const rich = buildInventory(RICH, RICH_CONFIG);
const spa = buildInventory(SPA, DEFAULT_CONFIG);

/** Creates a temp dir (relative posix path to contents), removed when the test ends. */
function project(t, files = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ct-inventory-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const fileAbs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
    fs.writeFileSync(fileAbs, contents);
  }
  return dir;
}

const WIDE_CONFIG = { ...DEFAULT_CONFIG, sourceGlobs: [...DEFAULT_CONFIG.sourceGlobs, 'server/**', 'db/**', 'web/**'] };
const scan = (t, files, config = WIDE_CONFIG, apps, options = {}) => buildInventory(project(t, files), config, { apps, ...options });
const itemsOfKind = (inventory, kind) => inventory.items.filter((item) => item.kind === kind);
const details = (inventory, kind, file) => itemsOfKind(inventory, kind).filter((item) => !file || item.file === file).map((item) => item.detail);
const pageFiles = (inventory) => Object.fromEntries(inventory.pages.map((page) => [page.route, page.file]));

describe('buildInventory pages and areas', () => {
  test('router definitions resolve to the component file through the imports', () => {
    assert.deepEqual(pageFiles(rich), {
      '/': 'src/pages/Home.tsx',
      '/account': 'src/pages/Account.tsx',
      '/account/settings': 'src/pages/AccountSettings.tsx',
      '/checkout': 'src/pages/Checkout.tsx',
      '/login': 'src/pages/Login.tsx',
      '/shop': 'src/pages/Shop.tsx',
      '/shop/:param': 'src/pages/Product.tsx',
    });
    assert.ok(rich.pages.every((page) => page.source === 'router'), 'a pages/ folder of components is not a Next router');
  });

  test('areas use the first URL segment and a humanized title', () => {
    assert.deepEqual(
      rich.areas.map((area) => [area.id, area.title, area.routes]),
      [
        ['account', 'Account', ['/account', '/account/settings']],
        ['checkout', 'Checkout', ['/checkout']],
        ['home', 'Home', ['/']],
        ['login', 'Login', ['/login']],
        ['shop', 'Shop', ['/shop', '/shop/:param']],
      ],
    );
    assert.deepEqual(rich.pages.map((page) => page.area), ['home', 'account', 'account', 'checkout', 'login', 'shop', 'shop']);
  });

  test('param-first routes go to "other" and dashes become spaces', (t) => {
    const inventory = scan(t, {
      'src/router.tsx': "export const r = [{ path: '/:slug/edit' }, { path: '/account-settings' }, { path: '/' }];\n",
    });
    assert.deepEqual(
      inventory.areas.map((area) => [area.id, area.title]),
      [['account-settings', 'Account settings'], ['home', 'Home'], ['other', 'Other']],
    );
  });

  test('component references: element, JSX element, Component, component, lazy, namespaces, barrels, renames', (t) => {
    const inventory = scan(t, {
      'src/router.tsx': [
        "import { A } from './pages/A';",
        "import { B as RenamedB } from '@/pages';",
        "import * as Pages from './pages/ns';",
        "import Comp1 from './pages/Comp1';",
        "import Comp2 from './pages/Comp2';",
        "import Jsx from './pages/Jsx';",
        "const Lazy = lazy(() => import('./pages/Lazy'));",
        'export const routes = [',
        "  { path: '/a', element: <A /> },",
        "  { path: '/b', element: <RenamedB /> },",
        "  { path: '/ns', element: <Pages.Anything /> },",
        "  { path: '/c1', Component: Comp1 },",
        "  { path: '/c2', component: Comp2 },",
        "  { path: '/lazy', element: <Lazy /> },",
        "  { path: '/local', element: <LocalOnly /> },",
        "  { path: '/bare' },",
        "  { path: '/after-bare', element: <A /> },",
        '];',
        'export const jsx = <Route path="/jsx" element={<Jsx />} />;',
      ].join('\n'),
      'src/pages/A.tsx': 'export const A = 1;\n',
      'src/pages/B.tsx': 'export const B = 1;\n',
      'src/pages/index.ts': "export { B } from './B';\nexport { A } from './A';\n",
      'src/pages/ns.ts': 'export const Anything = 1;\n',
      'src/pages/Comp1.tsx': 'export default 1;\n',
      'src/pages/Comp2.tsx': 'export default 2;\n',
      'src/pages/Jsx.tsx': 'export default 3;\n',
      'src/pages/Lazy.tsx': 'export default 4;\n',
    });
    assert.deepEqual(pageFiles(inventory), {
      '/a': 'src/pages/A.tsx',
      '/after-bare': 'src/pages/A.tsx',
      '/b': 'src/pages/B.tsx',
      '/bare': 'src/router.tsx',
      '/c1': 'src/pages/Comp1.tsx',
      '/c2': 'src/pages/Comp2.tsx',
      '/jsx': 'src/pages/Jsx.tsx',
      '/lazy': 'src/pages/Lazy.tsx',
      '/local': 'src/router.tsx',
      '/ns': 'src/pages/ns.ts',
    });
  });

  test('a component is only searched for within the route it follows', (t) => {
    const inventory = scan(t, {
      'src/router.tsx': "import { Y } from './Y';\nexport const r = [{ path: '/x' }, { path: '/y', element: <Y /> }];\n",
      'src/Y.tsx': 'export const Y = 1;\n',
    });
    assert.deepEqual(pageFiles(inventory), { '/x': 'src/router.tsx', '/y': 'src/Y.tsx' });
  });

  test('the component is read from the 300 characters after the path only', (t) => {
    const far = `{ path: '/far', ${' '.repeat(320)}element: <Far /> }`;
    const inventory = scan(t, {
      'src/router.tsx': `import { Far } from './Far';\nexport const r = [${far}];\n`,
      'src/Far.tsx': 'export const Far = 1;\n',
    });
    assert.equal(pageFiles(inventory)['/far'], 'src/router.tsx');
  });

  test('a route defined twice keeps one page: the one with a component beats a nav entry, then file order wins', (t) => {
    const inventory = scan(t, {
      'src/a-menu.tsx': "export const menu = [{ path: '/inbox', label: 'Inbox' }, { path: '/same' }];\n",
      'src/routes.tsx': "import { Inbox } from './Inbox';\nexport const r = [{ path: '/inbox', element: <Inbox /> }, { path: '/same' }];\n",
      'src/Inbox.tsx': 'export const Inbox = 1;\n',
    });
    assert.deepEqual(pageFiles(inventory), { '/inbox': 'src/Inbox.tsx', '/same': 'src/a-menu.tsx' });
    assert.equal(inventory.pages.length, 2);
  });

  test('Next file routes: pages, areas and sources', () => {
    const inventory = buildInventory(NEXT, DEFAULT_CONFIG);
    assert.deepEqual(inventory.pages, [
      { route: '/', file: 'app/page.tsx', source: 'next', area: 'home' },
      { route: '/blog/:param', file: 'app/blog/[id]/page.tsx', source: 'next', area: 'blog' },
      { route: '/checkout', file: 'app/(shop)/checkout/page.tsx', source: 'next', area: 'checkout' },
      { route: '/legacy', file: 'pages/legacy.tsx', source: 'next', area: 'legacy' },
    ]);
    assert.deepEqual(inventory.areas.map((area) => area.id), ['blog', 'checkout', 'home', 'legacy']);
    assert.deepEqual(inventory.links, [{ from: 'src/components/Nav.tsx', to: '/checkout' }]);
    assert.deepEqual(inventory.items, [{ kind: 'endpoint', file: 'pages/api/pay.ts', line: 1, detail: 'API route /api/pay' }]);
  });

  test('a Vite router without a component falls back to the defining file', () => {
    const inventory = buildInventory(VITE, DEFAULT_CONFIG);
    assert.deepEqual(pageFiles(inventory), { '/blog/:param': 'src/main.tsx', '/bookings': 'src/main.tsx' });
  });
});

describe('buildInventory links', () => {
  test('links only point at known routes, with param-aware matching and no router-config noise', () => {
    assert.deepEqual(rich.links, [
      { from: 'src/auth/ProtectedRoute.tsx', to: '/login' },
      { from: 'src/components/Nav.tsx', to: '/account' },
      { from: 'src/components/Nav.tsx', to: '/checkout' },
      { from: 'src/components/Nav.tsx', to: '/shop' },
      { from: 'src/pages/Account.tsx', to: '/account/settings' },
      { from: 'src/pages/Login.tsx', to: '/account' },
      { from: 'src/pages/Product.tsx', to: '/checkout' },
      { from: 'src/pages/Shop.tsx', to: '/shop/:param' },
    ]);
    const routes = new Set(rich.pages.map((page) => page.route));
    assert.ok(rich.links.every((link) => routes.has(link.to)));
    assert.ok(!rich.links.some((link) => link.to === '/pricing' || link.to === '/api/orders'));
  });

  test('navigation calls count even in the file that defines the route; queries and hashes are dropped', (t) => {
    const inventory = scan(t, {
      'src/router.tsx': [
        "export const r = [{ path: '/' , element: <Navigate to=\"/shop\" /> }, { path: '/shop' }, { path: '/cart' }];",
        "go('/cart');",
      ].join('\n'),
      'src/Link.tsx': [
        'router.push(`/shop?tab=${tab}#top`);',
        "redirect('/cart/');",
        "const proto = '//cdn.example.com/shop';",
      ].join('\n'),
    });
    assert.deepEqual(inventory.links, [
      { from: 'src/Link.tsx', to: '/cart' },
      { from: 'src/Link.tsx', to: '/shop' },
      { from: 'src/router.tsx', to: '/shop' },
    ]);
  });
});

describe('buildInventory items', () => {
  test('rich-app has every kind with file, line and evidence', () => {
    assert.deepEqual(rich.items, [
      { kind: 'email', file: 'emails/OrderConfirmation.tsx', line: 1, detail: 'email template' },
      { kind: 'model', file: 'prisma/schema.prisma', line: 6, detail: 'model Order' },
      { kind: 'model', file: 'prisma/schema.prisma', line: 12, detail: 'model User' },
      { kind: 'job', file: 'server/jobs/sendReminders.ts', line: 1, detail: 'background job' },
      { kind: 'endpoint', file: 'server/routes.ts', line: 8, detail: 'GET /api/products' },
      { kind: 'endpoint', file: 'server/routes.ts', line: 10, detail: 'POST /api/orders' },
      { kind: 'email', file: 'server/routes.ts', line: 11, detail: 'sendEmail()' },
      { kind: 'api-call', file: 'src/api/client.ts', line: 2, detail: 'POST /api/orders' },
      { kind: 'api-call', file: 'src/api/client.ts', line: 7, detail: 'GET /api/products' },
      { kind: 'auth-guard', file: 'src/auth/ProtectedRoute.tsx', line: 4, detail: 'ProtectedRoute' },
      { kind: 'auth-guard', file: 'src/auth/useAuth.ts', line: 1, detail: 'useAuth()' },
      { kind: 'form', file: 'src/components/CartForm.tsx', line: 6, detail: '<form>' },
      { kind: 'auth-guard', file: 'src/pages/Account.tsx', line: 2, detail: 'ProtectedRoute' },
      { kind: 'auth-guard', file: 'src/pages/AccountSettings.tsx', line: 2, detail: 'ProtectedRoute' },
    ]);
    const kinds = new Set(rich.items.map((item) => item.kind));
    assert.deepEqual([...kinds].sort(), ['api-call', 'auth-guard', 'email', 'endpoint', 'form', 'job', 'model']);
  });

  test('api calls: fetch methods, axios, api client, query hooks; repeats keep the first line', (t) => {
    const inventory = scan(t, {
      'src/calls.ts': [
        "const a = axios.get('/api/a');",
        'const b = api.post(`/api/b/${id}`, body);',
        'const c = trpc.orders.list.useQuery();',
        'const d = trpc.orders.create.useMutation();',
        "fetch('/api/e');",
        "fetch('/api/f', {",
        "  method: 'delete',",
        '});',
        "fetch('/api/e');",
        "const x = fetch('/api/g');",
        `fetch('/api/${'long/'.repeat(40)}');`,
      ].join('\n'),
    });
    const found = itemsOfKind(inventory, 'api-call');
    assert.deepEqual(
      found.slice(0, 7).map((item) => [item.line, item.detail]),
      [
        [1, 'GET /api/a'],
        [2, 'POST /api/b/${id}'],
        [3, 'trpc.orders.list.useQuery()'],
        [4, 'trpc.orders.create.useMutation()'],
        [5, 'GET /api/e'],
        [6, 'DELETE /api/f'],
        [10, 'GET /api/g'],
      ],
    );
    assert.equal(found.length, 8);
    assert.ok(found.every((item) => item.detail.length <= 120), 'details are capped');
    assert.ok(found[7].detail.endsWith('…'));
  });

  test('endpoints: Express routers, Next route handlers (groups, params, export lists) and pages/api', (t) => {
    const inventory = scan(t, {
      'server/api.ts': "app.get('/health', h);\napiRouter.delete(`/things/:id`, h);\nrouter.post('/x', h);\nstore.get('/not-a-route');\n",
      'app/api/orders/route.ts': 'export async function GET() {}\nexport const POST = async () => {};\nexport const helper = 1;\n',
      'app/(shop)/[slug]/route.js': 'export { handler as PUT, handler as PATCH };\n',
      'app/page.tsx': 'export const GET = 1;\n',
      'pages/api/users/[id].ts': 'export default function handler() {}\n',
      'pages/api/index.ts': 'export default function handler() {}\n',
    });
    const all = (file) => details(inventory, 'endpoint', file);
    assert.deepEqual(all('server/api.ts'), ['GET /health', 'DELETE /things/:id', 'POST /x']);
    assert.deepEqual(all('app/api/orders/route.ts'), ['GET /api/orders', 'POST /api/orders']);
    assert.deepEqual(all('app/(shop)/[slug]/route.js').sort(), ['PATCH /:param', 'PUT /:param']);
    assert.deepEqual(all('app/page.tsx'), []);
    assert.deepEqual(all('pages/api/users/[id].ts'), ['API route /api/users/:param']);
    assert.deepEqual(all('pages/api/index.ts'), ['API route /api']);
  });

  test('auth guards: middleware at the root or src, login redirects, auth helpers', (t) => {
    const inventory = scan(t, {
      'middleware.ts': 'export function middleware() {}\n',
      'src/middleware.js': 'module.exports = {};\n',
      'server/middleware.ts': 'export const x = 1;\n',
      'src/a.ts': "function f() {\n  redirect('/sign-in?next=1');\n}\n",
      'src/b.ts': "navigate('/login');\nrequireAuth(handler);\n",
      'src/c.tsx': 'export const c = <SignedIn>hi</SignedIn>;\n',
      'src/d.tsx': 'const Page = withAuth(Inner);\n',
      'src/e.tsx': "redirect('/loginish-path-is-not-login-but-matches-prefix');\nconst z = 1;\n",
      'src/f.ts': "redirect('/home');\n",
    });
    assert.deepEqual(
      itemsOfKind(inventory, 'auth-guard').map((item) => [item.file, item.line, item.detail]),
      [
        ['middleware.ts', 1, 'middleware'],
        ['src/a.ts', 2, 'redirect to /sign-in?next=1'],
        ['src/b.ts', 1, 'navigate to /login'],
        ['src/c.tsx', 1, '<SignedIn>'],
        ['src/d.tsx', 1, 'withAuth()'],
        ['src/middleware.js', 1, 'middleware'],
      ],
    );
  });

  test('forms, emails, jobs and models from text', (t) => {
    const inventory = scan(t, {
      'src/actions.ts': "'use server';\nexport async function save() {}\n",
      'src/late.ts': "\n\n  'use server';\n",
      'src/F.tsx': 'export function F() {\n  const { register } = useForm();\n}\n',
      'src/G.tsx': 'export const G = () => <form className="x" />;\n',
      'src/Plain.tsx': 'export const P = () => <formatted />;\n',
      'src/mail.ts': "import nodemailer from 'nodemailer';\nresend.emails.send({});\n",
      'src/lambda/ping.ts': 'export const handler = async () => ({ statusCode: 200 });\n',
      'src/notlambda.ts': 'export const handler = 1;\n',
      'src/jobs.ts': "cron.schedule('* * * * *', run);\n",
      'src/schema.ts': 'export const OrderSchema = z.object({ id: z.string() });\n',
      'db/init.sql': 'create table public.orders (id int);\nCREATE TABLE IF NOT EXISTS "users" (id int);\n',
    });
    assert.deepEqual(details(inventory, 'form'), ['useForm()', '<form>', "'use server' actions", "'use server' actions"]);
    assert.equal(itemsOfKind(inventory, 'form').find((item) => item.file === 'src/late.ts').line, 3);
    assert.deepEqual(details(inventory, 'email'), ['nodemailer']);
    assert.deepEqual(details(inventory, 'job'), ['cron.schedule()', 'lambda handler']);
    assert.deepEqual(details(inventory, 'model'), ['table public.orders', 'table users', 'schema Order']);
  });

  test('the same evidence repeated in one file is listed once at its first line', (t) => {
    const inventory = scan(t, { 'src/a.ts': "x();\nfetch('/api/z');\nfetch('/api/z');\nfetch('/api/z');\n" });
    assert.deepEqual(inventory.items.map((item) => [item.line, item.detail]), [[2, 'GET /api/z']]);
  });
});

describe('buildInventory imports and files', () => {
  test('rich-app imports resolve the @/ alias, index files and relative paths', () => {
    assert.deepEqual(rich.imports['src/pages/Home.tsx'], ['src/components/Nav.tsx', 'src/components/ui/index.tsx']);
    assert.deepEqual(rich.imports['src/components/ui/index.tsx'], ['src/components/ui/Button.tsx']);
    assert.deepEqual(rich.imports['src/pages/Account.tsx'], ['src/auth/ProtectedRoute.tsx', 'src/components/ui/Button.tsx']);
    assert.deepEqual(rich.imports['src/components/CartForm.tsx'], ['src/api/client.ts', 'src/components/ui/Button.tsx']);
    assert.deepEqual(rich.imports['server/routes.ts'], ['emails/OrderConfirmation.tsx']);
    assert.ok(rich.imports['src/main.tsx'].includes('src/pages/Login.tsx'), "'@/pages/Login' resolves");
    assert.ok(!Object.hasOwn(rich.imports, 'src/components/Nav.tsx'), 'files without resolved imports are left out');
  });

  test('every import form is parsed; packages, missing files and paths leaving the root are dropped', (t) => {
    const inventory = scan(t, {
      'src/a.ts': [
        "import { b } from './b';",
        "import c from '@/lib/c';",
        "import d from './dir';",
        "export * from './e.js';",
        "export { h } from './h';",
        "const f = require('./f');",
        "const g = await import('./g');",
        "import './side';",
        "import type { T } from './types';",
        "import React from 'react';",
        "import out from '../../outside';",
        "import css from './style.css';",
        "import missing from './nope';",
        "import self from './a';",
      ].join('\n'),
      'src/b.ts': '',
      'src/lib/c.tsx': '',
      'src/dir/index.ts': '',
      'src/e.ts': '',
      'src/h.mjs': '',
      'src/f.js': '',
      'src/g.jsx': '',
      'src/side.ts': '',
      'src/types.ts': '',
      'src/style.css': 'x {}',
    });
    assert.deepEqual(inventory.imports['src/a.ts'], [
      'src/b.ts', 'src/dir/index.ts', 'src/e.ts', 'src/f.js', 'src/g.jsx', 'src/h.mjs', 'src/lib/c.tsx', 'src/side.ts', 'src/types.ts',
    ]);
  });

  test("with config.root the '@/' alias points at <root>/src and paths stay repo-relative", (t) => {
    const inventory = scan(
      t,
      {
        'web/src/a.ts': "import c from '@/lib/c';\nimport d from './d';\n",
        'web/src/lib/c.ts': '',
        'web/src/d.ts': '',
        'src/lib/c.ts': 'outside the app root',
      },
      { ...DEFAULT_CONFIG, root: 'web' },
    );
    assert.deepEqual(Object.keys(inventory.files), ['web/src/a.ts', 'web/src/d.ts', 'web/src/lib/c.ts']);
    assert.deepEqual(inventory.imports['web/src/a.ts'], ['web/src/d.ts', 'web/src/lib/c.ts']);
  });

  test('files lists every scanned file with byte size and sha1; ignored and oversized files are skipped', (t) => {
    const dir = project(t, {
      'src/keep.ts': 'export const a = 1;\n',
      'src/skip.test.ts': 'x',
      'src/__tests__/skip.ts': 'x',
      'src/notes.md': 'x',
      'src/data.json': '{}',
      'src/huge.ts': `// ${'x'.repeat(1_000_001)}`,
      'src/schema.prisma': 'model A {\n}\n',
      'pages/home.tsx': 'x',
    });
    const inventory = buildInventory(dir, DEFAULT_CONFIG);
    assert.deepEqual(Object.keys(inventory.files), ['pages/home.tsx', 'src/keep.ts', 'src/schema.prisma']);
    const text = fs.readFileSync(path.join(dir, 'src', 'keep.ts'));
    assert.deepEqual(inventory.files['src/keep.ts'], { bytes: text.length, sha1: createHash('sha1').update(text).digest('hex') });
  });

  test('CRLF files hash and measure like LF files', (t) => {
    const lf = scan(t, { 'src/a.ts': 'export const a = 1;\nexport const b = 2;\n' });
    const crlf = scan(t, { 'src/a.ts': 'export const a = 1;\r\nexport const b = 2;\r\n' });
    assert.deepEqual(crlf.files, lf.files);
  });

  test('a root-level middleware is scanned even though sourceGlobs do not cover it', (t) => {
    const inventory = scan(t, { 'middleware.ts': 'export {};\n', 'other.ts': 'export {};\n' });
    assert.deepEqual(Object.keys(inventory.files), ['middleware.ts']);
  });
});

describe('buildInventory determinism', () => {
  test('two runs give identical JSON', () => {
    assert.equal(JSON.stringify(buildInventory(RICH, RICH_CONFIG)), JSON.stringify(rich));
  });

  test('a copy of the project in another folder gives identical JSON (apart from the git head)', (t) => {
    const copy = project(t);
    fs.cpSync(RICH, copy, { recursive: true });
    const other = buildInventory(copy, RICH_CONFIG);
    assert.equal(other.head, null);
    assert.equal(JSON.stringify({ ...other, head: null }), JSON.stringify({ ...rich, head: null }));
  });

  test('every list and the key order of maps are sorted', () => {
    const sorted = (list, key) => assert.deepEqual(list.map(key), [...list.map(key)].sort());
    sorted(rich.pages, (page) => page.route);
    sorted(rich.areas, (area) => area.id);
    assert.deepEqual(Object.keys(rich.files), [...Object.keys(rich.files)].sort());
    assert.deepEqual(Object.keys(rich.imports), [...Object.keys(rich.imports)].sort());
    for (const targets of Object.values(rich.imports)) assert.deepEqual(targets, [...targets].sort());
  });
});

describe('readGitHead', () => {
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);
  const SHA_C = 'c'.repeat(40);

  test('follows a branch to its loose ref', (t) => {
    const dir = project(t, { '.git/HEAD': 'ref: refs/heads/feature/x\n', '.git/refs/heads/feature/x': `${SHA_A}\n` });
    assert.equal(readGitHead(dir), SHA_A);
  });

  test('falls back to packed-refs', (t) => {
    const dir = project(t, {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${SHA_A} refs/heads/other\n${SHA_B} refs/heads/main\n^${SHA_C}\n`,
    });
    assert.equal(readGitHead(dir), SHA_B);
  });

  test('a loose ref wins over a stale packed one', (t) => {
    const dir = project(t, {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/refs/heads/main': SHA_A,
      '.git/packed-refs': `${SHA_B} refs/heads/main\n`,
    });
    assert.equal(readGitHead(dir), SHA_A);
  });

  test('returns the sha of a detached HEAD', (t) => {
    assert.equal(readGitHead(project(t, { '.git/HEAD': `${SHA_C}\n` })), SHA_C);
  });

  test('follows a worktree .git file to its own HEAD and the shared refs', (t) => {
    const base = project(t, {
      'main/.git/refs/heads/feature': `${SHA_B}\n`,
      'main/.git/worktrees/wt/HEAD': 'ref: refs/heads/feature\n',
      'main/.git/worktrees/wt/commondir': '../..\n',
      'wt/file.txt': 'x',
    });
    fs.writeFileSync(path.join(base, 'wt', '.git'), `gitdir: ${path.join(base, 'main', '.git', 'worktrees', 'wt')}\n`);
    assert.equal(readGitHead(path.join(base, 'wt')), SHA_B);
    fs.writeFileSync(path.join(base, 'wt', '.git'), 'gitdir: ../main/.git/worktrees/wt\n');
    assert.equal(readGitHead(path.join(base, 'wt')), SHA_B, 'a relative gitdir works too');
  });

  test('a worktree can use packed-refs of the shared folder', (t) => {
    const base = project(t, {
      'main/.git/packed-refs': `${SHA_A} refs/heads/feature\n`,
      'main/.git/worktrees/wt/HEAD': 'ref: refs/heads/feature\n',
      'main/.git/worktrees/wt/commondir': '../..\n',
    });
    fs.mkdirSync(path.join(base, 'wt'));
    fs.writeFileSync(path.join(base, 'wt', '.git'), `gitdir: ${path.join(base, 'main', '.git', 'worktrees', 'wt')}\n`);
    assert.equal(readGitHead(path.join(base, 'wt')), SHA_A);
  });

  test('finds .git in an ancestor of the given folder', (t) => {
    const dir = project(t, { '.git/HEAD': `${SHA_A}\n`, 'packages/app/src/x.ts': '' });
    assert.equal(readGitHead(path.join(dir, 'packages', 'app')), SHA_A);
  });

  test('returns null without a repository, on an unborn branch, or on garbage', (t) => {
    assert.equal(readGitHead(project(t, { 'a.txt': '' })), null);
    assert.equal(readGitHead(project(t, { '.git/HEAD': 'ref: refs/heads/main\n' })), null);
    assert.equal(readGitHead(project(t, { '.git/HEAD': 'not a sha\n' })), null);
    assert.equal(readGitHead(project(t, { '.git/HEAD': 'ref: ../../etc/passwd\n' })), null);
    assert.equal(readGitHead(project(t, { '.git/HEAD': 'ref: refs/heads/x\n', '.git/refs/heads/x': 'zzz\n' })), null);
  });

  test('buildInventory records the head of the repository it sits in', (t) => {
    const dir = project(t, { '.git/HEAD': `${SHA_A}\n`, 'src/a.ts': '' });
    assert.equal(buildInventory(dir, DEFAULT_CONFIG).head, SHA_A);
  });
});

/** Hand-built inventory: pages as [route, file, area], sizes in bytes per file. */
function handBuilt({ pages = [], imports = {}, sizes = {}, items = [], head = null } = {}) {
  const files = Object.fromEntries(Object.entries(sizes).map(([file, bytes]) => [file, { bytes, sha1: `sha-${file}-${bytes}` }]));
  const areaIds = [...new Set(pages.map(([, , area]) => area))].sort();
  return {
    version: 1,
    head,
    pages: pages.map(([route, file, area]) => ({ route, file, source: 'router', area })),
    links: [],
    items,
    imports,
    areas: areaIds.map((id) => ({ id, title: id.toUpperCase(), routes: pages.filter(([, , area]) => area === id).map(([route]) => route) })),
    files,
  };
}

describe('planUnits', () => {
  test('rich-app: one unit per area, pages first, shared UI left out', () => {
    const units = planUnits(rich);
    assert.deepEqual(units.map((unit) => unit.id), ['area-account', 'area-checkout', 'area-home', 'area-login', 'area-shop']);
    const byId = Object.fromEntries(units.map((unit) => [unit.id, unit]));
    assert.deepEqual(byId['area-shop'].files, ['src/pages/Shop.tsx', 'src/pages/Product.tsx', 'src/api/client.ts', 'src/components/Nav.tsx']);
    assert.deepEqual(byId['area-shop'].routes, ['/shop', '/shop/:param']);
    assert.deepEqual(byId['area-checkout'].files, ['src/pages/Checkout.tsx', 'src/components/CartForm.tsx', 'src/api/client.ts']);
    assert.deepEqual(byId['area-account'].files.slice(0, 2), ['src/pages/Account.tsx', 'src/pages/AccountSettings.tsx']);
    for (const unit of units) {
      assert.equal(unit.kind, 'area');
      assert.ok(!unit.files.includes('src/components/ui/Button.tsx'), `${unit.id} leaves out the shared Button`);
      assert.ok(!unit.files.includes('src/components/ui/index.tsx'), `${unit.id} leaves out the shared ui index`);
      assert.equal(unit.estTokens, Math.ceil(unit.files.reduce((sum, file) => sum + rich.files[file].bytes, 0) / 4));
      assert.ok(unit.estTokens <= PIPELINE.UNIT_MAX_TOKENS);
    }
    assert.equal(byId['area-shop'].title, 'Shop');
    assert.equal(byId['area-shop'].area, 'shop');
  });

  test('a small budget splits an area into area-<id>, area-<id>-2 with part titles', () => {
    const inventory = handBuilt({
      pages: [['/shop', 'src/Shop.tsx', 'shop'], ['/shop/:param', 'src/Product.tsx', 'shop'], ['/cart', 'src/Cart.tsx', 'cart']],
      sizes: { 'src/Shop.tsx': 120, 'src/Product.tsx': 100, 'src/Cart.tsx': 60 },
    });
    const units = planUnits(inventory, { maxTokens: 30 });
    assert.deepEqual(units.map((unit) => [unit.id, unit.title, unit.routes, unit.files, unit.estTokens]), [
      ['area-cart', 'CART', ['/cart'], ['src/Cart.tsx'], 15],
      ['area-shop', 'SHOP (part 1 of 2)', ['/shop'], ['src/Shop.tsx'], 30],
      ['area-shop-2', 'SHOP (part 2 of 2)', ['/shop/:param'], ['src/Product.tsx'], 25],
    ]);
  });

  test('without feature folders to cut by, imports are added while the budget holds and planning stops at the first that does not fit', () => {
    const inventory = handBuilt({
      pages: [['/p', 'src/pages/p.tsx', 'p']],
      imports: { 'src/pages/p.tsx': ['src/api/a.ts', 'src/api/b.ts', 'src/api/c.ts'] },
      sizes: { 'src/pages/p.tsx': 40, 'src/api/a.ts': 40, 'src/api/b.ts': 400, 'src/api/c.ts': 4 },
    });
    const [unit] = planUnits(inventory, { maxTokens: 25 });
    assert.deepEqual(unit.files, ['src/pages/p.tsx', 'src/api/a.ts']);
    assert.equal(unit.estTokens, 20);
  });

  test('a single page larger than the budget still gets its file', () => {
    const inventory = handBuilt({ pages: [['/p', 'p.tsx', 'p']], sizes: { 'p.tsx': 4000 } });
    const [unit] = planUnits(inventory, { maxTokens: 10 });
    assert.deepEqual(unit.files, ['p.tsx']);
    assert.equal(unit.estTokens, 1000);
  });

  test('pages sharing one file count it once when packing', () => {
    const inventory = handBuilt({ pages: [['/a', 'x.tsx', 'x'], ['/b', 'x.tsx', 'x'], ['/c', 'y.tsx', 'x']], sizes: { 'x.tsx': 100, 'y.tsx': 100 } });
    assert.equal(planUnits(inventory, { maxTokens: 50 }).length, 1);
    assert.equal(planUnits(inventory, { maxTokens: 49 }).length, 2);
  });

  test('files reached from more than 30% of the pages are shared; fewer than 3 pages never share', () => {
    const pages = Array.from({ length: 10 }, (_, i) => [`/p${i}`, `p${i}.tsx`, `a${i}`]);
    const imports = Object.fromEntries(pages.map(([, file], i) => [file, [
      'ui.ts', ...(i < 4 ? ['layout.ts'] : []), ...(i < 3 ? ['tabs.ts'] : []), ...(i < 2 ? ['rare.ts'] : []),
    ]]));
    imports['p0.tsx'].push('node_modules/pkg/index.js');
    imports['layout.ts'] = ['inner.ts'];
    const sizes = Object.fromEntries([...pages.map(([, file]) => file), 'ui.ts', 'layout.ts', 'tabs.ts', 'rare.ts', 'inner.ts'].map((file) => [file, 8]));
    const units = Object.fromEntries(planUnits(handBuilt({ pages, imports, sizes })).map((unit) => [unit.area, unit]));
    assert.deepEqual(units.a0.files, ['p0.tsx', 'tabs.ts', 'rare.ts']);
    assert.deepEqual(units.a3.files, ['p3.tsx']);
    assert.deepEqual(units.a2.files, ['p2.tsx', 'tabs.ts']);
    assert.deepEqual(units.a9.files, ['p9.tsx']);

    const tiny = handBuilt({
      pages: [['/a', 'a.tsx', 'a'], ['/b', 'b.tsx', 'b']],
      imports: { 'a.tsx': ['x.ts'], 'b.tsx': ['x.ts'] },
      sizes: { 'a.tsx': 8, 'b.tsx': 8, 'x.ts': 8 },
    });
    assert.deepEqual(planUnits(tiny).map((unit) => unit.files), [['a.tsx', 'x.ts'], ['b.tsx', 'x.ts']]);
  });

  test('imports are listed breadth-first and each file once', () => {
    const inventory = handBuilt({
      pages: [['/p', 'p.tsx', 'p']],
      imports: { 'p.tsx': ['a.ts', 'b.ts'], 'a.ts': ['c.ts', 'b.ts'], 'b.ts': ['d.ts'], 'c.ts': ['p.tsx', 'e.ts'] },
      sizes: { 'p.tsx': 4, 'a.ts': 4, 'b.ts': 4, 'c.ts': 4, 'd.ts': 4, 'e.ts': 4 },
    });
    assert.deepEqual(planUnits(inventory)[0].files, ['p.tsx', 'a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
  });

  test('routes plans only those pages and numbers gap units gap-1, gap-2, …', () => {
    const units = planUnits(rich, { routes: ['/checkout', '/shop/:id', '/nope'], kind: 'gap' });
    assert.deepEqual(units.map((unit) => [unit.id, unit.kind, unit.area, unit.routes]), [
      ['gap-1', 'gap', 'checkout', ['/checkout']],
      ['gap-2', 'gap', 'shop', ['/shop/:param']],
    ]);
    assert.deepEqual(units[1].files.slice(0, 1), ['src/pages/Product.tsx']);
    assert.deepEqual(planUnits(rich, { routes: [], kind: 'gap' }), []);
  });

  test('gap and refresh numbering continues across split units and honours idPrefix', () => {
    const inventory = handBuilt({
      pages: [['/a', 'a1.tsx', 'a'], ['/b', 'a2.tsx', 'a'], ['/c', 'c.tsx', 'c']],
      sizes: { 'a1.tsx': 40, 'a2.tsx': 40, 'c.tsx': 40 },
    });
    const units = planUnits(inventory, { maxTokens: 10, kind: 'refresh', idPrefix: 'sync' });
    assert.deepEqual(units.map((unit) => [unit.id, unit.kind, unit.title]), [
      ['sync-1', 'refresh', 'A (part 1 of 2)'],
      ['sync-2', 'refresh', 'A (part 2 of 2)'],
      ['sync-3', 'refresh', 'C'],
    ]);
    assert.deepEqual(planUnits(inventory, { maxTokens: 10, idPrefix: 'x' }).map((unit) => unit.id), ['x-a', 'x-a-2', 'x-c']);
  });

  test('an inventory without pages has no units', () => {
    assert.deepEqual(planUnits(handBuilt()), []);
  });
});

describe('planUnits view units', () => {
  const PAGE = 'src/pages/home/HomePage.tsx';
  const bytes = (file) => spa.files[file].bytes;
  const tokensFor = (totalBytes) => Math.ceil(totalBytes / 4);
  const plan = (options) => planUnits(spa, { minViewTokens: 0, ...options });
  const byId = (units) => Object.fromEntries(units.map((unit) => [unit.id, unit]));
  const PEOPLE = ['src/pages/home/people/PeopleView.tsx', 'src/pages/home/people/PersonCard.tsx'];
  const TASKS = ['src/pages/home/tasks/TasksView.tsx', 'src/pages/home/tasks/TaskRow.tsx'];

  test('a single-page app that fits stays one unit', () => {
    const [unit] = planUnits(spa);
    assert.equal(planUnits(spa).length, 1);
    assert.equal(unit.id, 'area-home');
    assert.equal(unit.files[0], PAGE);
    assert.equal(unit.files.length, 11);
  });

  test('a page whose imports do not fit is cut into one unit per feature folder, biggest first', () => {
    const maxTokens = 600;
    assert.ok(planUnits(spa)[0].estTokens > maxTokens, 'precondition: everything together is over budget');
    const units = plan({ maxTokens });
    assert.deepEqual(units.map((unit) => [unit.id, unit.title]), [
      ['area-home-people', 'Home · People'],
      ['area-home-tasks', 'Home · Tasks'],
      ['area-home-notebook', 'Home · Notebook'],
      ['area-home-editor', 'Home · Editor'],
    ]);
    for (const unit of units) {
      assert.equal(unit.kind, 'area');
      assert.equal(unit.area, 'home');
      assert.deepEqual(unit.routes, ['/home']);
      assert.equal(unit.files[0], PAGE, `${unit.id} starts with the page file`);
      assert.equal(unit.estTokens, tokensFor(unit.files.reduce((sum, file) => sum + bytes(file), 0)));
      assert.ok(unit.estTokens <= maxTokens);
    }
    const found = byId(units);
    assert.deepEqual(found['area-home-people'].files.slice(0, 3), [PAGE, ...PEOPLE]);
    assert.deepEqual(found['area-home-tasks'].files.slice(0, 3), [PAGE, ...TASKS]);
    assert.deepEqual(found['area-home-editor'].files, [PAGE, 'src/components/Editor/Editor.tsx'], 'src/components/<key> is its own feature');
  });

  test('stores and hooks are never features; they join a unit only when its own files import them and budget remains', () => {
    const units = byId(plan({ maxTokens: 600 }));
    assert.deepEqual(units['area-home-people'].files, [PAGE, ...PEOPLE, 'src/hooks/useSession.ts', 'src/stores/usePeopleStore.ts']);
    assert.deepEqual(units['area-home-tasks'].files, [PAGE, ...TASKS, 'src/hooks/useSession.ts', 'src/stores/useTaskStore.ts']);
    assert.deepEqual(units['area-home-notebook'].files, [PAGE, 'src/pages/home/notebook/NotebookView.tsx']);
    const all = Object.values(units).flatMap((unit) => unit.files);
    assert.ok(!all.includes('src/stores/useAppStore.ts'), 'what only the page imports is not added to any view');
    assert.ok(!units['area-home-people'].files.includes('src/stores/useTaskStore.ts'));

    const tight = byId(plan({ maxTokens: Math.floor((bytes(PAGE) + bytes(PEOPLE[0]) + bytes(PEOPLE[1])) / 4) + 1 }));
    assert.deepEqual(tight['area-home-people'].files, [PAGE, ...PEOPLE], 'no room left for infra');
    assert.deepEqual(tight['area-home-tasks'].files, [PAGE, ...TASKS, 'src/hooks/useSession.ts'], 'a store that does not fit is skipped, a smaller hook still fits');
  });

  test('a feature bigger than the budget is split into -2, -3 parts', () => {
    const maxTokens = tokensFor(bytes(PAGE) + bytes(PEOPLE[0]));
    const units = plan({ maxTokens });
    assert.deepEqual(units.filter((unit) => unit.title.startsWith('Home · People')).map((unit) => [unit.id, unit.title, unit.files.slice(0, 2)]), [
      ['area-home-people', 'Home · People (part 1 of 2)', [PAGE, PEOPLE[0]]],
      ['area-home-people-2', 'Home · People (part 2 of 2)', [PAGE, PEOPLE[1]]],
    ]);
    assert.ok(units.some((unit) => unit.id === 'area-home-tasks-2'));
    assert.equal(new Set(units.map((unit) => unit.id)).size, units.length, 'ids are unique');
  });

  test('small features are merged into one "Other parts" unit, which is split when too big', () => {
    const minViewTokens = 100;
    assert.ok(bytes(PEOPLE[0]) + bytes(PEOPLE[1]) >= minViewTokens * 4 && bytes(TASKS[0]) + bytes(TASKS[1]) >= minViewTokens * 4);
    const units = planUnits(spa, { maxTokens: 600, minViewTokens });
    assert.deepEqual(units.map((unit) => [unit.id, unit.title]), [
      ['area-home-people', 'Home · People'],
      ['area-home-tasks', 'Home · Tasks'],
      ['area-home-other-parts', 'Home · Other parts'],
    ]);
    assert.deepEqual(units[2].files, [PAGE, 'src/pages/home/notebook/NotebookView.tsx', 'src/components/Editor/Editor.tsx']);

    const split = planUnits(spa, { maxTokens: tokensFor(bytes(PAGE) + bytes('src/pages/home/notebook/NotebookView.tsx')), minViewTokens });
    assert.deepEqual(split.filter((unit) => unit.id.startsWith('area-home-other-parts')).map((unit) => [unit.id, unit.title]), [
      ['area-home-other-parts', 'Home · Other parts (part 1 of 2)'],
      ['area-home-other-parts-2', 'Home · Other parts (part 2 of 2)'],
    ]);

    const lone = planUnits(spa, { maxTokens: 600, minViewTokens: 30 });
    assert.ok(lone.some((unit) => unit.id === 'area-home-editor'), 'a single small feature keeps its own name');
    assert.ok(!lone.some((unit) => unit.id === 'area-home-other-parts'));
  });

  test('ordering and ids are deterministic: biggest first, ties by name', (t) => {
    const first = JSON.stringify(plan({ maxTokens: 600 }));
    assert.equal(JSON.stringify(plan({ maxTokens: 600 })), first);
    const copy = project(t);
    fs.cpSync(SPA, copy, { recursive: true });
    assert.equal(JSON.stringify(planUnits(buildInventory(copy, DEFAULT_CONFIG), { maxTokens: 600, minViewTokens: 0 })), first);

    const tied = handBuilt({
      pages: [['/p', 'src/pages/p/P.tsx', 'p']],
      imports: { 'src/pages/p/P.tsx': ['src/pages/p/beta/B.tsx', 'src/pages/p/alpha/A.tsx'] },
      sizes: { 'src/pages/p/P.tsx': 4, 'src/pages/p/beta/B.tsx': 40, 'src/pages/p/alpha/A.tsx': 40 },
    });
    assert.deepEqual(planUnits(tied, { maxTokens: 20, minViewTokens: 0 }).map((unit) => unit.id), ['area-p-alpha', 'area-p-beta']);
  });

  test('feature keys come from the page folder, container folders, or the file name', () => {
    const inventory = handBuilt({
      pages: [['/p', 'web/src/pages/p/P.tsx', 'p']],
      imports: {
        'web/src/pages/p/P.tsx': [
          'web/src/pages/p/components/Side/Side.tsx', 'web/src/pages/p/Extras.tsx', 'web/src/features/billing/Plan.tsx',
          'web/src/pages/other/components/Deep/D.tsx', 'web/src/components/Widget.tsx', 'web/src/utils/format.ts',
        ],
      },
      sizes: Object.fromEntries([
        'web/src/pages/p/P.tsx', 'web/src/pages/p/components/Side/Side.tsx', 'web/src/pages/p/Extras.tsx', 'web/src/features/billing/Plan.tsx',
        'web/src/pages/other/components/Deep/D.tsx', 'web/src/components/Widget.tsx', 'web/src/utils/format.ts',
      ].map((file) => [file, 40])),
    });
    const units = planUnits(inventory, { maxTokens: 30, minViewTokens: 0 });
    assert.deepEqual(units.map((unit) => unit.title).sort(), [
      'P · Billing', 'P · Extras', 'P · Other', 'P · Side', 'P · Widget',
    ]);
    assert.ok(units.every((unit) => !unit.files.includes('web/src/utils/format.ts') || unit.files.length > 1));
  });

  test('gap units cut into views are numbered gap-1, gap-2, …', () => {
    const units = plan({ maxTokens: 600, routes: ['/home'], kind: 'gap' });
    assert.deepEqual(units.map((unit) => unit.id), ['gap-1', 'gap-2', 'gap-3', 'gap-4']);
    assert.equal(units[0].title, 'Home · People');
  });
});

describe('coverage', () => {
  const inventory = handBuilt({
    pages: [
      ['/', 'src/pages/Home.tsx', 'home'],
      ['/shop', 'src/pages/Shop.tsx', 'shop'],
      ['/shop/:param', 'src/pages/Product.tsx', 'shop'],
      ['/checkout', 'src/pages/Checkout.tsx', 'checkout'],
      ['/account', 'src/pages/Account.tsx', 'account'],
      ['/login', 'src/pages/Login.tsx', 'login'],
    ],
    imports: {
      'src/pages/Checkout.tsx': ['src/components/CartForm.tsx'],
      'src/components/CartForm.tsx': ['src/components/Field.tsx'],
      'src/components/Field.tsx': ['src/components/Deep.tsx'],
      'src/pages/Login.tsx': ['src/components/LoginForm.tsx'],
    },
    items: [
      { kind: 'form', file: 'src/components/CartForm.tsx', line: 1, detail: '<form>' },
      { kind: 'form', file: 'src/components/Field.tsx', line: 1, detail: '<form>' },
      { kind: 'form', file: 'src/components/Deep.tsx', line: 1, detail: '<form>' },
      { kind: 'form', file: 'src/components/LoginForm.tsx', line: 1, detail: '<form>' },
      { kind: 'form', file: 'src/pages/Account.tsx', line: 1, detail: '<form>' },
      { kind: 'endpoint', file: 'server/routes.ts', line: 3, detail: 'POST /api/orders' },
      { kind: 'endpoint', file: 'server/routes.ts', line: 5, detail: 'GET /api/products' },
      { kind: 'endpoint', file: 'server/other.ts', line: 2, detail: 'GET /api/x' },
      { kind: 'api-call', file: 'src/api.ts', line: 1, detail: 'GET /api/x' },
    ],
  });
  const step = (id, screen, anchor, detail) => ({ id, say: id, screen, anchor, next: [], ...(detail ? { detail } : {}) });
  const doc = (...steps) => ({ version: 1, app: 'x', journeys: [{ id: 'j', title: 'J', steps }] });

  test('counts covered pages, forms and endpoints and lists what is missing', () => {
    const result = coverage(
      doc(
        step('s1', '/shop/', { type: 'route', value: '/shop' }),
        step('s2', null, { type: 'file', value: './src/pages/Account.tsx' }, { files: ['server/routes.ts'] }),
        step('s3', '/shop/:id', { type: 'route', value: '/checkout/' }),
      ),
      inventory,
    );
    assert.deepEqual(result.pages, { covered: 4, total: 6, missing: ['/', '/login'] });
    assert.deepEqual(result.forms, { covered: 3, total: 5, missing: ['src/components/Deep.tsx', 'src/components/LoginForm.tsx'] });
    assert.deepEqual(result.endpoints, { covered: 2, total: 3, missing: ['server/other.ts: GET /api/x'] });
    assert.equal(result.percent, 67);
  });

  test('a file anchor or detail.files that names the page file covers the page', () => {
    const result = coverage(
      doc(
        step('s1', null, { type: 'file', value: 'src/pages/Home.tsx' }),
        step('s2', null, { type: 'file', value: 'README.md' }, { files: ['src\\pages\\Login.tsx'] }),
      ),
      inventory,
    );
    assert.deepEqual(result.pages.missing, ['/account', '/checkout', '/shop', '/shop/:param']);
    assert.equal(result.percent, 33);
    assert.deepEqual(result.forms.missing, [
      'src/components/CartForm.tsx', 'src/components/Deep.tsx', 'src/components/Field.tsx', 'src/pages/Account.tsx',
    ]);
  });

  test('forms count as covered only within two import hops of a covered page', () => {
    const result = coverage(doc(step('s1', '/checkout', { type: 'route', value: '/checkout' })), inventory);
    assert.deepEqual(result.forms.missing, ['src/components/Deep.tsx', 'src/components/LoginForm.tsx', 'src/pages/Account.tsx']);
  });

  test('an empty map covers nothing; an empty inventory is fully covered', () => {
    const none = coverage({ version: 1, app: 'x', journeys: [] }, inventory);
    assert.equal(none.percent, 0);
    assert.equal(none.pages.covered, 0);
    assert.deepEqual(none.pages.missing, ['/', '/account', '/checkout', '/login', '/shop', '/shop/:param']);
    assert.deepEqual(coverage(doc(), handBuilt()), {
      pages: { covered: 0, total: 0, missing: [] },
      forms: { covered: 0, total: 0, missing: [] },
      endpoints: { covered: 0, total: 0, missing: [] },
      percent: 100,
    });
  });

  test('works on a real inventory', () => {
    const result = coverage(
      doc(
        step('home', '/', { type: 'route', value: '/' }),
        step('buy', '/checkout', { type: 'route', value: '/checkout' }, { files: ['server/routes.ts'] }),
      ),
      rich,
    );
    assert.deepEqual(result.pages.covered, 2);
    assert.equal(result.pages.total, 7);
    assert.equal(result.percent, 29);
    assert.deepEqual(result.forms, { covered: 1, total: 1, missing: [] });
    assert.deepEqual(result.endpoints, { covered: 2, total: 2, missing: [] });
  });
});

describe('diffInventory', () => {
  const before = handBuilt({
    pages: [['/', 'a.tsx', 'home'], ['/old', 'old.tsx', 'old']],
    sizes: { 'a.tsx': 1, 'old.tsx': 2, 'same.ts': 3, 'edit.ts': 4 },
    head: 'aaa',
  });

  test('lists new and removed pages, changed files and a moved head, all sorted', () => {
    const after = handBuilt({
      pages: [['/', 'a.tsx', 'home'], ['/zed', 'z.tsx', 'zed'], ['/new', 'new.tsx', 'new']],
      sizes: { 'a.tsx': 1, 'z.tsx': 9, 'same.ts': 3, 'edit.ts': 5, 'new.tsx': 1 },
      head: 'bbb',
    });
    assert.deepEqual(diffInventory(before, after), {
      newPages: ['/new', '/zed'],
      removedPages: ['/old'],
      changedFiles: ['edit.ts', 'new.tsx', 'old.tsx', 'z.tsx'],
      headChanged: true,
    });
  });

  test('identical inventories have no differences, and a missing before means everything is new', () => {
    assert.deepEqual(diffInventory(before, structuredClone(before)), { newPages: [], removedPages: [], changedFiles: [], headChanged: false });
    assert.deepEqual(diffInventory(null, before), {
      newPages: ['/', '/old'],
      removedPages: [],
      changedFiles: ['a.tsx', 'edit.ts', 'old.tsx', 'same.ts'],
      headChanged: true,
    });
    assert.equal(diffInventory({ ...before, head: null }, { ...before, head: null }).headChanged, false);
  });

  test('detects a real edit between two scans', (t) => {
    const dir = project(t, { 'src/router.tsx': "export const r = [{ path: '/a' }];\n", 'src/keep.ts': 'export {};\n' });
    const first = buildInventory(dir, DEFAULT_CONFIG);
    fs.writeFileSync(path.join(dir, 'src', 'router.tsx'), "export const r = [{ path: '/a' }, { path: '/b' }];\n");
    const second = buildInventory(dir, DEFAULT_CONFIG);
    assert.deepEqual(diffInventory(first, second), { newPages: ['/b'], removedPages: [], changedFiles: ['src/router.tsx'], headChanged: false });
  });
});

describe('multi-app inventory', () => {
  const apps = findApps(MULTI);
  const multi = buildInventory(MULTI, DEFAULT_CONFIG, { apps, minFeatureTokens: 0 });
  const ALL_FEATURES = { minFeatureTokens: 0 };
  const app = (id, kind, root) => ({ id, title: { web: 'Web app', desktop: 'Desktop app', server: 'Backend' }[kind], kind, root });
  const featureSummary = (inventory) => inventory.features.map((feature) => [feature.app, feature.key, feature.files.map((file) => file.replace(/^packages\/[^/]+\//, ''))]);
  const DESKTOP = 'packages/desktop';

  test('apps are recorded and pages and items carry the id of the app they belong to', () => {
    assert.deepEqual(multi.apps, [app('desktop', 'desktop', DESKTOP), app('server', 'server', 'packages/server'), app('web', 'web', 'packages/web')]);
    assert.deepEqual(multi.pages.map((page) => [page.route, page.app, page.file]), [
      ['/', 'web', 'packages/web/src/pages/Home.tsx'],
      ['/pricing', 'web', 'packages/web/src/pages/Pricing.tsx'],
    ]);
    for (const item of multi.items) assert.equal(item.app, appForFile(apps, item.file), item.file);
    assert.deepEqual(multi.links, [{ from: 'packages/web/src/pages/Home.tsx', to: '/pricing' }]);
    assert.deepEqual(multi.areas.map((area) => area.id), ['home', 'pricing']);
  });

  test('window, menu and ipc items of the desktop app', () => {
    const desktopItems = multi.items.filter((item) => ['window', 'menu', 'ipc'].includes(item.kind));
    assert.deepEqual(desktopItems.map((item) => [item.kind, item.file.replace(`${DESKTOP}/`, ''), item.line, item.detail]), [
      ['window', 'main.js', 6, 'window loads http://localhost:5173'],
      ['menu', 'main.js', 13, 'tray icon'],
      ['menu', 'main.js', 15, 'Open Acme, Connect iMessage, Quit'],
      ['ipc', 'main.js', 24, 'connect-imessage'],
      ['ipc', 'main.js', 25, 'open-settings'],
      ['ipc', 'preload.js', 3, 'acme'],
    ]);
  });

  test('window, menu and ipc variants: load targets, labels outside the call, parentheses in labels', (t) => {
    const inventory = scan(t, {
      'src/windows.js': [
        'const a = new BrowserWindow({});',
        "a.loadFile(path.join(__dirname, 'index.html'));",
        'const b = new BrowserWindow({ width: 1 });',
        'const c = new BrowserWindow({});',
        "c.loadURL(isDev ? 'http://localhost:3000' : `file://${x}`);",
      ].join('\n'),
      'src/menus.js': [
        "Menu.buildFromTemplate([{ label: 'Inline (x)', submenu: [{ label: 'Deep' }] }, { type: 'separator' }]);",
        'new Tray(icon);',
      ].join('\n'),
      'src/menu-var.js': [
        "const template = [{ label: 'File' }, { label: 'Quit (Cmd+Q)' }];",
        'Menu.setApplicationMenu(Menu.buildFromTemplate(template));',
        'Menu.buildFromTemplate(fromElsewhere());',
      ].join('\n'),
      'src/ipc.ts': "ipcMain.once('a:b', f);\nipcMain.handleOnce(`c`, f);\nipcRenderer.on('not-main', f);\nipcMain.on('a:b', g);\n",
    });
    assert.deepEqual(details(inventory, 'window'), ['window loads index.html', 'window', 'window loads http://localhost:3000']);
    assert.deepEqual(details(inventory, 'menu'), ['File, Quit (Cmd+Q)', 'Inline (x), Deep', 'tray icon']);
    assert.deepEqual(details(inventory, 'ipc'), ['a:b', 'c']);
  });

  test('features are the code no page reaches, grouped by feature folder with stem merging; tests and utilities are left out', () => {
    assert.deepEqual(featureSummary(multi), [
      ['desktop', 'beeper', ['agent/beeper/beeper.go', 'agent/cmd/agent/beeper.go']],
      ['desktop', 'imessage', ['agent/imessage/imessage.go']],
      ['desktop', 'main', ['agent/cmd/agent/main.go', 'main.js']],
      ['desktop', 'preload', ['preload.js']],
      ['desktop', 'tray', ['src/tray.js']],
      ['desktop', 'updater', ['src/updater.js']],
      ['desktop', 'windows', ['src/windows.js']],
      ['server', 'billing', ['src/services/billing/invoice.ts']],
      ['server', 'emails', ['src/emails/welcome.ts']],
      ['server', 'jobs', ['src/jobs/nightly.ts']],
    ]);
    assert.ok(multi.features.every((feature) => feature.title === feature.key.charAt(0).toUpperCase() + feature.key.slice(1)));
    assert.ok(!Object.hasOwn(multi.files, `${DESKTOP}/agent/imessage/imessage_test.go`), 'Go tests are not scanned');
    assert.ok(Object.hasOwn(multi.files, `${DESKTOP}/agent/internal/log/log.go`), 'but utility code is scanned');
    assert.ok(!multi.features.some((feature) => feature.files.some((file) => file.includes('/log/') || file.includes('/routes/') || file.includes('/search/'))));
    assert.ok(!multi.features.some((feature) => feature.app === 'web'), 'web apps have no features');
  });

  test('files in other languages are scanned for sizes but not parsed', () => {
    const go = `${DESKTOP}/agent/beeper/beeper.go`;
    assert.ok(multi.files[go].bytes > 0);
    assert.ok(!Object.hasOwn(multi.imports, go));
    assert.ok(multi.items.every((item) => !item.file.endsWith('.go')));
  });

  test('a desktop app is scanned whole (any language, no tests or build output); web apps keep to sourceGlobs', (t) => {
    const inventory = scan(
      t,
      {
        'mac/package.json': '{}',
        'mac/agent/ok.go': 'package ok',
        'mac/tool/run.py': 'x = 1',
        'mac/lib/x.rb': 'x',
        'mac/Sources/App.swift': 'x',
        'mac/app/Main.kt': 'x',
        'mac/src/a.ts': 'x',
        'mac/agent/a_test.go': 'x',
        'mac/tool/test_run.py': 'x',
        'mac/src/__tests__/q.ts': 'x',
        'mac/src/a.test.ts': 'x',
        'mac/testdata/t.go': 'x',
        'mac/fixtures/f.go': 'x',
        'mac/mocks/m.go': 'x',
        'mac/dist/out.js': 'x',
        'mac/build/gen.go': 'x',
        'mac/vendor/dep.go': 'x',
        'mac/notes.md': 'x',
        'site/other/not-in-globs.go': 'x',
        'site/other/not-in-globs.ts': 'x',
        'site/src/b.ts': 'x',
      },
      DEFAULT_CONFIG,
      [app('mac', 'desktop', 'mac'), app('site', 'web', 'site')],
    );
    assert.deepEqual(Object.keys(inventory.files), [
      'mac/Sources/App.swift', 'mac/agent/ok.go', 'mac/app/Main.kt', 'mac/lib/x.rb', 'mac/src/a.ts', 'mac/tool/run.py', 'site/src/b.ts',
    ]);
  });

  test('two apps with an area of the same name keep them apart as <app>-<area>; other areas keep their name', (t) => {
    const router = (...paths) => `export const r = [${paths.map((path_) => `{ path: '${path_}' }`).join(', ')}];\n`;
    const inventory = scan(
      t,
      {
        'web/src/router.tsx': router('/settings', '/billing'),
        'admin/src/router.tsx': router('/settings/team', '/users'),
      },
      DEFAULT_CONFIG,
      [app('admin', 'web', 'admin'), app('web', 'web', 'web')],
    );
    assert.deepEqual(inventory.areas.map((area) => [area.id, area.title, area.routes]), [
      ['admin-settings', 'Admin settings', ['/settings/team']],
      ['billing', 'Billing', ['/billing']],
      ['users', 'Users', ['/users']],
      ['web-settings', 'Web settings', ['/settings']],
    ]);
    assert.deepEqual(inventory.pages.map((page) => [page.route, page.area, page.app]), [
      ['/billing', 'billing', 'web'],
      ['/settings', 'web-settings', 'web'],
      ['/settings/team', 'admin-settings', 'admin'],
      ['/users', 'users', 'admin'],
    ]);
    const units = planUnits(inventory);
    assert.deepEqual(units.map((unit) => [unit.id, unit.app]), [
      ['area-admin-settings', 'admin'], ['area-billing', 'web'], ['area-users', 'admin'], ['area-web-settings', 'web'],
    ]);
  });

  test('a file belongs to the app with the longest matching root', (t) => {
    const inventory = scan(
      t,
      { 'o/main.js': 'x', 'o/inner/src/jobs/a.ts': 'cron.schedule("* * * * *", f);', 'o/lib/b.ts': 'x' },
      DEFAULT_CONFIG,
      [app('o', 'desktop', 'o'), app('inner', 'server', 'o/inner')],
      ALL_FEATURES,
    );
    assert.deepEqual(inventory.items.map((item) => [item.file, item.app]), [['o/inner/src/jobs/a.ts', 'inner']]);
    assert.deepEqual(featureSummary(inventory), [
      ['inner', 'jobs', ['o/inner/src/jobs/a.ts']],
      ['o', 'b', ['o/lib/b.ts']],
      ['o', 'main', ['o/main.js']],
    ]);
  });

  test('a single plain web app gives the same inventory with or without apps', () => {
    const single = [{ id: 'app', title: 'Web app', kind: 'web', root: '.' }];
    assert.equal(JSON.stringify(buildInventory(RICH, RICH_CONFIG, { apps: single })), JSON.stringify(rich));
    assert.ok(!('apps' in rich) && !('features' in rich));
  });

  test('a single desktop app at the root gets features but no app tags', (t) => {
    const dir = project(t, {
      'main.js': "ipcMain.handle('ping', f);\n",
      'agent/sync/sync.go': 'package sync',
    });
    const inventory = buildInventory(dir, DEFAULT_CONFIG, { apps: [{ id: 'app', title: 'Desktop app', kind: 'desktop', root: '.' }], ...ALL_FEATURES });
    assert.ok(!('apps' in inventory));
    assert.deepEqual(inventory.items, [{ kind: 'ipc', file: 'main.js', line: 1, detail: 'ping' }]);
    assert.deepEqual(inventory.features.map((feature) => [feature.app, feature.key]), [['app', 'main'], ['app', 'sync']]);
  });

  test('feature units: one per feature, files first, kind feature with the app, no routes', () => {
    const units = planUnits(multi);
    const features = units.filter((unit) => unit.kind === 'feature');
    assert.deepEqual(units.slice(0, 2).map((unit) => [unit.id, unit.kind, unit.app]), [['area-home', 'area', 'web'], ['area-pricing', 'area', 'web']]);
    assert.deepEqual(features.map((unit) => [unit.id, unit.app, unit.area, unit.title, unit.routes]), [
      ['feature-desktop-beeper', 'desktop', 'beeper', 'Desktop app · Beeper', []],
      ['feature-desktop-imessage', 'desktop', 'imessage', 'Desktop app · Imessage', []],
      ['feature-desktop-main', 'desktop', 'main', 'Desktop app · Main', []],
      ['feature-desktop-preload', 'desktop', 'preload', 'Desktop app · Preload', []],
      ['feature-desktop-tray', 'desktop', 'tray', 'Desktop app · Tray', []],
      ['feature-desktop-updater', 'desktop', 'updater', 'Desktop app · Updater', []],
      ['feature-desktop-windows', 'desktop', 'windows', 'Desktop app · Windows', []],
      ['feature-server-billing', 'server', 'billing', 'Backend · Billing', []],
      ['feature-server-emails', 'server', 'emails', 'Backend · Emails', []],
      ['feature-server-jobs', 'server', 'jobs', 'Backend · Jobs', []],
    ]);
    assert.deepEqual(features[0].files, [`${DESKTOP}/agent/beeper/beeper.go`, `${DESKTOP}/agent/cmd/agent/beeper.go`]);
    for (const unit of features) assert.equal(unit.estTokens, Math.ceil(unit.files.reduce((sum, file) => sum + multi.files[file].bytes, 0) / 4));
  });

  test('a feature over budget is split into -2 parts; direct imports follow the feature files while budget remains', (t) => {
    const inventory = scan(
      t,
      {
        'api/src/jobs/a.ts': "import { fmt } from '../util/fmt';\nimport { big } from '../util/big';\ncron.schedule('* * * * *', fmt);\n",
        'api/src/jobs/b.ts': 'export const b = 1;\n',
        'api/src/util/fmt.ts': 'export const fmt = 1;\n',
        'api/src/util/big.ts': `export const big = '${'x'.repeat(2000)}';\n`,
      },
      DEFAULT_CONFIG,
      [app('api', 'server', 'api')],
    );
    const bytes = (file) => inventory.files[file].bytes;
    const jobs = planUnits(inventory, { maxTokens: 100 }).filter((unit) => unit.kind === 'feature');
    assert.deepEqual(jobs.map((unit) => [unit.id, unit.files]), [
      ['feature-api-jobs', ['api/src/jobs/a.ts', 'api/src/jobs/b.ts', 'api/src/util/fmt.ts']],
    ]);
    assert.ok(bytes('api/src/util/big.ts') > 400, 'precondition: big.ts does not fit in the budget');

    const tight = planUnits(inventory, { maxTokens: Math.ceil(bytes('api/src/jobs/a.ts') / 4) }).filter((unit) => unit.kind === 'feature');
    assert.deepEqual(tight.map((unit) => [unit.id, unit.title, unit.files[0]]), [
      ['feature-api-jobs', 'Backend · Jobs (part 1 of 2)', 'api/src/jobs/a.ts'],
      ['feature-api-jobs-2', 'Backend · Jobs (part 2 of 2)', 'api/src/jobs/b.ts'],
    ]);
  });

  test('feature units are only added to the area plan, not to gap or route-limited plans', () => {
    assert.deepEqual(planUnits(multi, { routes: ['/pricing'], kind: 'gap' }).map((unit) => [unit.id, unit.app]), [['gap-1', 'web']]);
    assert.ok(planUnits(multi, { routes: ['/pricing'] }).every((unit) => unit.kind === 'area'));
    assert.ok(planUnits(rich).every((unit) => unit.kind === 'area' && !('app' in unit)));
  });

  test('coverage counts features, covered when any of their files is a step anchor or in detail.files', () => {
    const step = (id, anchor, detail) => ({ id, say: id, screen: null, anchor, next: [], ...(detail ? { detail } : {}) });
    const doc = {
      version: 1,
      app: 'x',
      journeys: [{
        id: 'j',
        title: 'J',
        steps: [
          step('a', { type: 'file', value: `${DESKTOP}/agent/imessage/imessage.go` }),
          step('b', { type: 'route', value: '/' }, { files: ['packages/server/src/jobs/nightly.ts', 'packages/server/src/routes/users.ts'] }),
        ],
      }],
    };
    const result = coverage(doc, multi);
    assert.deepEqual(result.features, {
      covered: 2,
      total: 10,
      missing: ['desktop/beeper', 'desktop/main', 'desktop/preload', 'desktop/tray', 'desktop/updater', 'desktop/windows', 'server/billing', 'server/emails'],
    });
    assert.equal(result.percent, 50, 'percent stays page-based');
    assert.ok(!('features' in coverage(doc, rich)), 'inventories without features have no features bucket');
    assert.deepEqual(coverage(doc, { ...rich, features: [] }).features, { covered: 0, total: 0, missing: [] });
  });

  test('small files in a container root form one "shell" feature; a big one keeps its own; small features fold into "other"', () => {
    const size = (file) => multi.files[`${DESKTOP}/${file}`].bytes;
    const threshold = Math.floor(Math.min(size('main.js'), size('src/updater.js')) / 4);
    for (const small of ['preload.js', 'src/tray.js', 'src/windows.js']) assert.ok(size(small) < threshold * 4, `precondition: ${small} is small`);
    const folded = buildInventory(MULTI, DEFAULT_CONFIG, { apps, minFeatureTokens: threshold });
    assert.deepEqual(folded.features.map((feature) => [feature.app, feature.key, feature.title, feature.files.map((file) => file.replace(/^packages\/[^/]+\//, ''))]), [
      ['desktop', 'main', 'Main', ['agent/cmd/agent/main.go', 'main.js']],
      ['desktop', 'other', 'Desktop app · other parts', ['agent/beeper/beeper.go', 'agent/cmd/agent/beeper.go', 'agent/imessage/imessage.go']],
      ['desktop', 'shell', 'Desktop app shell', ['preload.js', 'src/tray.js', 'src/windows.js']],
      ['desktop', 'updater', 'Updater', ['src/updater.js']],
      ['server', 'other', 'Backend · other parts', ['src/emails/welcome.ts', 'src/jobs/nightly.ts', 'src/services/billing/invoice.ts']],
    ]);
  });

  test('with the default 3000-token threshold every feature of the fixture is tiny: a shell and an "other" per app', () => {
    const folded = buildInventory(MULTI, DEFAULT_CONFIG, { apps });
    assert.deepEqual(folded.features.map((feature) => [feature.app, feature.key]), [['desktop', 'other'], ['desktop', 'shell'], ['server', 'other']]);
    assert.deepEqual(folded.features[1].files.map((file) => file.replace(`${DESKTOP}/`, '')), ['main.js', 'preload.js', 'src/tray.js', 'src/updater.js', 'src/windows.js']);
    assert.ok(folded.features[0].files.includes(`${DESKTOP}/agent/cmd/agent/main.go`), 'a file under cmd/<binary>/ is not part of the shell');
  });

  test('a lone small feature keeps its own name instead of being folded; the shell is never folded into "other"', (t) => {
    const inventory = scan(
      t,
      { 'm/src/tray.js': 'x', 'm/agent/sync/sync.go': 'package sync', 'm/agent/big/big.go': `package big // ${'x'.repeat(2000)}` },
      DEFAULT_CONFIG,
      [app('m', 'desktop', 'm')],
      { minFeatureTokens: 100 },
    );
    assert.deepEqual(inventory.features.map((feature) => [feature.key, feature.title]), [
      ['big', 'Big'],
      ['shell', 'Desktop app shell'],
      ['sync', 'Sync'],
    ]);
  });

  test('feature units of the folded features: titles name the app once, and "other" is split when over budget', () => {
    const folded = buildInventory(MULTI, DEFAULT_CONFIG, { apps });
    const features = planUnits(folded).filter((unit) => unit.kind === 'feature');
    assert.deepEqual(features.map((unit) => [unit.id, unit.title]), [
      ['feature-desktop-other', 'Desktop app · other parts'],
      ['feature-desktop-shell', 'Desktop app shell'],
      ['feature-server-other', 'Backend · other parts'],
    ]);
    const split = planUnits(folded, { maxTokens: 60 }).filter((unit) => unit.id.startsWith('feature-desktop-other'));
    assert.deepEqual(split.map((unit) => [unit.id, unit.title, unit.files.length]), [
      ['feature-desktop-other', 'Desktop app · other parts (part 1 of 2)', 2],
      ['feature-desktop-other-2', 'Desktop app · other parts (part 2 of 2)', 2],
    ]);
  });

  test('is deterministic, also from a copy in another folder', (t) => {
    assert.equal(JSON.stringify(buildInventory(MULTI, DEFAULT_CONFIG, { apps, ...ALL_FEATURES })), JSON.stringify(multi));
    const copy = project(t);
    fs.cpSync(MULTI, copy, { recursive: true });
    const other = buildInventory(copy, DEFAULT_CONFIG, { apps: findApps(copy), ...ALL_FEATURES });
    assert.equal(JSON.stringify({ ...other, head: null }), JSON.stringify({ ...multi, head: null }));
    assert.equal(JSON.stringify(planUnits(other)), JSON.stringify(planUnits(multi)));
  });
});
