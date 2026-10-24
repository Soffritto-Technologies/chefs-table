import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appForFile, findApps, groupFeatures, hasFeatures, humanize, slugify } from '../lib/apps.mjs';

const MULTI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'multi-app');

/** Creates a temp repo (relative posix path to contents), removed when the test ends. */
function repo(t, files = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ct-apps-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const fileAbs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
    fs.writeFileSync(fileAbs, typeof contents === 'string' ? contents : `${JSON.stringify(contents)}\n`);
  }
  return dir;
}

const pkg = (name, deps = {}, extra = {}) => ({ name, dependencies: deps, ...extra });
const kinds = (apps) => Object.fromEntries(apps.map((app) => [app.id, app.kind]));

describe('findApps', () => {
  test('multi-app fixture: web, desktop and backend; the shared types library is skipped', () => {
    assert.deepEqual(findApps(MULTI), [
      { id: 'desktop', title: 'Desktop app', kind: 'desktop', root: 'packages/desktop' },
      { id: 'server', title: 'Backend', kind: 'server', root: 'packages/server' },
      { id: 'web', title: 'Web app', kind: 'web', root: 'packages/web' },
    ]);
  });

  test('kinds come from dependencies and manifests', (t) => {
    const dir = repo(t, {
      'package.json': { private: true, workspaces: ['packages/*', 'apps/*', 'services/*'] },
      'packages/next-site/package.json': pkg('next-site', { next: '14', react: '18' }),
      'packages/vue-site/package.json': pkg('vue-site', { vue: '3' }),
      'packages/svelte-site/package.json': pkg('svelte-site', {}, { devDependencies: { '@sveltejs/kit': '2' } }),
      'packages/phone/package.json': pkg('phone', { expo: '51', react: '18', 'react-native': '0.74' }),
      'packages/tauri-app/package.json': pkg('tauri-app', { react: '18' }, { devDependencies: { '@tauri-apps/cli': '1' } }),
      'packages/nest-api/package.json': pkg('nest-api', { '@nestjs/core': '10' }),
      'packages/fast-api/package.json': pkg('fast-api', { fastify: '4' }),
      'packages/lambda-fns/package.json': pkg('lambda-fns', {}),
      'packages/lambda-fns/serverless.yml': 'service: x\n',
      'packages/cli-tool/package.json': pkg('cli-tool', {}, { bin: { tool: 'bin/tool.js' } }),
      'packages/react-only/package.json': pkg('react-only', { react: '18', 'react-dom': '18' }, { main: 'index.js' }),
      'packages/react-only/index.html': '<div id="root"></div>',
      'apps/go-agent/go.mod': 'module x/agent\n\ngo 1.22\n',
      'apps/go-api/go.mod': 'module x/api\n\nrequire github.com/gin-gonic/gin v1.9.0\n',
      'apps/rust-agent/Cargo.toml': '[package]\nname = "agent"\n\n[dependencies]\nserde = "1"\n',
      'apps/rust-ui/Cargo.toml': '[package]\nname = "ui"\n\n[dependencies]\ntauri = "1"\n',
      'services/py-api/pyproject.toml': '[project]\nname = "api"\ndependencies = ["fastapi"]\n',
      'services/py-worker/pyproject.toml': '[project]\nname = "worker"\ndependencies = ["celery"]\n',
    });
    assert.deepEqual(kinds(findApps(dir)), {
      'cli-tool': 'agent',
      'fast-api': 'server',
      'go-agent': 'agent',
      'go-api': 'server',
      'lambda-fns': 'server',
      'nest-api': 'server',
      'next-site': 'web',
      phone: 'mobile',
      'py-api': 'server',
      'py-worker': 'agent',
      'react-only': 'web',
      'rust-agent': 'agent',
      'rust-ui': 'desktop',
      'svelte-site': 'web',
      'tauri-app': 'desktop',
      'vue-site': 'web',
    });
  });

  test('a desktop dependency beats web ones, and a bundler beats a server library', (t) => {
    const dir = repo(t, {
      'packages/mac/package.json': pkg('mac', { electron: '30', react: '18' }, { devDependencies: { vite: '5' } }),
      'packages/site/package.json': pkg('site', { express: '4', react: '18' }, { devDependencies: { vite: '5' } }),
      'packages/api/package.json': pkg('api', { express: '4', react: '18' }),
    });
    assert.deepEqual(kinds(findApps(dir)), { api: 'server', mac: 'desktop', site: 'web' });
  });

  test('pure libraries are skipped: no entry point, or a shared/types/utils/ui-kit style name without one', (t) => {
    const dir = repo(t, {
      'packages/app/package.json': pkg('app', { vite: '5', react: '18' }),
      'packages/shared-types/package.json': pkg('@acme/shared-types', {}, { main: 'index.ts' }),
      'packages/ui-kit/package.json': pkg('ui-kit', { react: '18' }),
      'packages/utils/package.json': pkg('@acme/utils', { lodash: '4' }),
      'packages/plain/package.json': pkg('plain', {}),
      'packages/schemas/package.json': pkg('schemas', { zod: '3' }, { bin: { gen: 'gen.js' } }),
      'packages/go-shared/go.mod': 'module x/shared\n',
    });
    assert.deepEqual(kinds(findApps(dir)), { app: 'web', schemas: 'agent' });
  });

  test('an app inside a desktop app belongs to it, even when a workspace glob reaches it', (t) => {
    const dir = repo(t, {
      'package.json': { workspaces: ['packages/**'] },
      'packages/desktop/package.json': pkg('desktop', { electron: '30' }),
      'packages/desktop/agent/go.mod': 'module x/agent\n',
      'packages/desktop/helper/package.json': pkg('helper', { express: '4' }),
      'packages/web/package.json': pkg('web', { vite: '5' }),
      'packages/web/e2e/package.json': pkg('e2e', { vite: '5' }),
    });
    assert.deepEqual(findApps(dir).map((app) => [app.id, app.root]), [
      ['desktop', 'packages/desktop'],
      ['e2e', 'packages/web/e2e'],
      ['web', 'packages/web'],
    ]);
  });

  test('workspaces as { packages }, pnpm-workspace.yaml with quotes, comments and exclusions', (t) => {
    const dir = repo(t, {
      'package.json': { workspaces: { packages: ['web-*'] } },
      'pnpm-workspace.yaml': "# workspaces\npackages:\n  - 'tools/*'\n  - \"!tools/skip\"\n  - extras/one # trailing\nother: true\n",
      'web-a/package.json': pkg('web-a', { vite: '5' }),
      'tools/cli/package.json': pkg('cli', {}, { bin: 'cli.js' }),
      'tools/skip/package.json': pkg('skip', {}, { bin: 'skip.js' }),
      'extras/one/go.mod': 'module x/one\n',
      'extras/two/go.mod': 'module x/two\n',
    });
    assert.deepEqual(findApps(dir).map((app) => app.root), ['tools/cli', 'extras/one', 'web-a']);
  });

  test('two apps of one kind get their folder name in the title, and ids stay unique', (t) => {
    const dir = repo(t, {
      'apps/web/package.json': pkg('a', { vite: '5' }),
      'packages/web/package.json': pkg('b', { vite: '5' }),
      'packages/adminPanel/package.json': pkg('c', { vite: '5' }),
      'packages/api/package.json': pkg('d', { express: '4' }),
    });
    assert.deepEqual(findApps(dir).map((app) => [app.id, app.title]), [
      ['admin-panel', 'Web app · Admin Panel'],
      ['api', 'Backend'],
      ['packages-web', 'Web app · Web'],
      ['web', 'Web app · Web'],
    ]);
  });

  test('a repo without workspaces or packages is one app with root "."', (t) => {
    assert.deepEqual(findApps(repo(t, { 'package.json': pkg('site', { vite: '5' }), 'src/main.tsx': '' })), [
      { id: 'app', title: 'Web app', kind: 'web', root: '.' },
    ]);
    assert.deepEqual(findApps(repo(t, { 'package.json': pkg('mac', { electron: '30' }) }))[0], { id: 'app', title: 'Desktop app', kind: 'desktop', root: '.' });
    assert.deepEqual(findApps(repo(t, { 'go.mod': 'module x\n' }))[0], { id: 'app', title: 'Background agent', kind: 'agent', root: '.' });
    assert.deepEqual(findApps(repo(t, { 'README.md': 'x' })), [{ id: 'app', title: 'Web app', kind: 'web', root: '.' }]);
  });

  test('workspaces that hold only libraries fall back to one app', (t) => {
    const dir = repo(t, {
      'package.json': { name: 'site', workspaces: ['packages/*'], dependencies: { vite: '5' } },
      'packages/shared/package.json': pkg('shared', {}),
    });
    assert.deepEqual(findApps(dir), [{ id: 'app', title: 'Web app', kind: 'web', root: '.' }]);
  });

  test('ignores node_modules and dot folders when expanding patterns', (t) => {
    const dir = repo(t, {
      'packages/real/package.json': pkg('real', { vite: '5' }),
      'packages/node_modules/package.json': pkg('hidden', { vite: '5' }),
      'packages/.cache/package.json': pkg('cache', { vite: '5' }),
    });
    assert.deepEqual(findApps(dir).map((app) => app.id), ['real']);
  });

  test('is deterministic', () => {
    assert.equal(JSON.stringify(findApps(MULTI)), JSON.stringify(findApps(MULTI)));
  });
});

describe('appForFile', () => {
  const apps = [
    { id: 'web', title: 'Web app', kind: 'web', root: 'packages/web' },
    { id: 'e2e', title: 'E2E', kind: 'web', root: 'packages/web/e2e' },
    { id: 'desktop', title: 'Desktop app', kind: 'desktop', root: 'packages/desktop' },
  ];

  test('picks the app with the longest matching root', () => {
    assert.equal(appForFile(apps, 'packages/web/src/main.tsx'), 'web');
    assert.equal(appForFile(apps, 'packages/web/e2e/run.ts'), 'e2e');
    assert.equal(appForFile(apps, 'packages/desktop/agent/main.go'), 'desktop');
    assert.equal(appForFile(apps, 'packages\\desktop\\main.js'), 'desktop');
    assert.equal(appForFile(apps, './packages/web/a.ts'), 'web');
  });

  test('does not match a sibling that only shares a prefix, and returns null when nothing matches', () => {
    assert.equal(appForFile(apps, 'packages/web2/a.ts'), null);
    assert.equal(appForFile(apps, 'docs/readme.md'), null);
    assert.equal(appForFile([], 'a.ts'), null);
  });

  test('a root of "." matches everything but loses to a longer root', () => {
    const single = [{ id: 'app', title: 'Web app', kind: 'web', root: '.' }];
    assert.equal(appForFile(single, 'src/a.ts'), 'app');
    assert.equal(appForFile([...single, apps[0]], 'packages/web/a.ts'), 'web');
    assert.equal(appForFile([...single, apps[0]], 'other/a.ts'), 'app');
  });
});

describe('groupFeatures', () => {
  const desktop = { id: 'desktop', title: 'Desktop app', kind: 'desktop', root: 'packages/desktop' };
  const server = { id: 'server', title: 'Backend', kind: 'server', root: 'packages/server' };
  const entry = (rel, noticed = false) => ({ file: `x/${rel}`, rel, noticed });
  const summary = (features) => features.map((feature) => [feature.key, feature.title, feature.files.map((file) => file.slice(2))]);

  test('the key is the folder below the containers; cmd/<binary>/ files are keyed by name and merge with a folder of that name', () => {
    const features = groupFeatures(desktop, [
      entry('agent/imessage/imessage.go'),
      entry('agent/imessage/db/read.go'),
      entry('agent/beeper/beeper.go'),
      entry('agent/cmd/pinechat-agent/beeper.go'),
      entry('agent/cmd/pinechat-agent/whatsapplocal.go'),
      entry('src/modules/billing/plan.ts'),
      entry('src/features/Chat/Chat.tsx'),
      entry('pkg/sync/sync.go'),
      entry('main.js'),
    ]);
    assert.deepEqual(summary(features), [
      ['beeper', 'Beeper', ['agent/beeper/beeper.go', 'agent/cmd/pinechat-agent/beeper.go']],
      ['billing', 'Billing', ['src/modules/billing/plan.ts']],
      ['chat', 'Chat', ['src/features/Chat/Chat.tsx']],
      ['imessage', 'Imessage', ['agent/imessage/db/read.go', 'agent/imessage/imessage.go']],
      ['main', 'Main', ['main.js']],
      ['sync', 'Sync', ['pkg/sync/sync.go']],
      ['whatsapplocal', 'Whatsapplocal', ['agent/cmd/pinechat-agent/whatsapplocal.go']],
    ]);
    assert.ok(features.every((feature) => feature.app === 'desktop'));
  });

  test('utility folders and config files are not features; titles split camelCase and snake_case', () => {
    const features = groupFeatures(desktop, [
      entry('agent/internal/log/log.go'),
      entry('agent/util/strings.go'),
      entry('src/utils/format.ts'),
      entry('src/types/index.ts'),
      entry('src/config/env.ts'),
      entry('agent/telemetry/send.go'),
      entry('agent/version/version.go'),
      entry('webpack.config.js'),
      entry('src/global.d.ts'),
      entry('src/voiceNotes/record.ts'),
      entry('src/quick_capture/open.ts'),
    ]);
    assert.deepEqual(features.map((feature) => [feature.key, feature.title]), [
      ['quick-capture', 'Quick capture'],
      ['voice-notes', 'Voice notes'],
    ]);
  });

  test('a server only offers files that send emails or run jobs, or sit in folders like emails and jobs', () => {
    const features = groupFeatures(server, [
      entry('src/routes/users.ts'),
      entry('src/services/search/search.ts'),
      entry('src/services/billing/invoice.ts', true),
      entry('src/emails/welcome.ts'),
      entry('src/Jobs/nightly.ts'),
      entry('lambda/webhooks/stripe.ts'),
      entry('src/notifications/push.ts'),
    ]);
    assert.deepEqual(features.map((feature) => feature.key), ['billing', 'emails', 'jobs', 'notifications', 'webhooks']);
  });

  test('with minTokens, small files directly in a container root form one shell; a file of minTokens or more keeps its own feature', () => {
    const sized = (rel, bytes) => ({ file: `x/${rel}`, rel, noticed: false, bytes });
    const features = groupFeatures(
      desktop,
      [
        sized('src/tray.js', 100),
        sized('src/windows.js', 200),
        sized('src/updater.js', 4000),
        sized('main.js', 300),
        sized('agent/main.go', 50),
        sized('agent/imessage/imessage.go', 5000),
        sized('agent/cmd/app/whatsapplocal.go', 6000),
      ],
      { minTokens: 1000 },
    );
    assert.deepEqual(summary(features), [
      ['imessage', 'Imessage', ['agent/imessage/imessage.go']],
      ['shell', 'Desktop app shell', ['agent/main.go', 'main.js', 'src/tray.js', 'src/windows.js']],
      ['updater', 'Updater', ['src/updater.js']],
      ['whatsapplocal', 'Whatsapplocal', ['agent/cmd/app/whatsapplocal.go']],
    ]);
  });

  test('with minTokens, features under it fold into "other"; one alone, the shell and big ones stay; stem merging still happens first', () => {
    const sized = (rel, bytes) => ({ file: `x/${rel}`, rel, noticed: false, bytes });
    const entries = [
      sized('agent/beeper/beeper.go', 2500),
      sized('agent/cmd/app/beeper.go', 2500),
      sized('agent/small/a.go', 100),
      sized('agent/tiny/b.go', 100),
      sized('agent/cmd/app/odd.go', 100),
      sized('agent/internal/log/log.go', 100),
      sized('src/shell1.js', 100),
    ];
    const features = groupFeatures(desktop, entries, { minTokens: 1000 });
    assert.deepEqual(summary(features), [
      ['beeper', 'Beeper', ['agent/beeper/beeper.go', 'agent/cmd/app/beeper.go']],
      ['other', 'Desktop app · other parts', ['agent/cmd/app/odd.go', 'agent/small/a.go', 'agent/tiny/b.go']],
      ['shell', 'Desktop app shell', ['src/shell1.js']],
    ]);
    const lone = groupFeatures(desktop, [sized('agent/small/a.go', 100), sized('agent/big/b.go', 9000)], { minTokens: 1000 });
    assert.deepEqual(lone.map((feature) => feature.key), ['big', 'small']);
  });

  test('a server has no shell; its small features fold into "other"', () => {
    const sized = (rel, bytes) => ({ file: `x/${rel}`, rel, noticed: true, bytes });
    const features = groupFeatures(server, [sized('src/mailer.ts', 100), sized('src/jobs/a.ts', 100), sized('src/emails/b.ts', 9000)], { minTokens: 1000 });
    assert.deepEqual(features.map((feature) => [feature.key, feature.title]), [['emails', 'Emails'], ['other', 'Backend · other parts']]);
  });

  test('web and mobile apps have no features', () => {
    assert.deepEqual(groupFeatures({ id: 'w', title: 'Web app', kind: 'web', root: 'w' }, [entry('src/a/b.ts')]), []);
    assert.deepEqual(groupFeatures({ id: 'm', title: 'Mobile app', kind: 'mobile', root: 'm' }, [entry('src/a/b.ts')]), []);
    assert.deepEqual([desktop, server, { ...desktop, kind: 'agent' }].map(hasFeatures), [true, true, true]);
    assert.equal(hasFeatures({ ...desktop, kind: 'web' }), false);
  });
});

describe('slugify and humanize', () => {
  test('split camelCase and punctuation', () => {
    assert.equal(slugify('ContactsSidebar'), 'contacts-sidebar');
    assert.equal(slugify('AICoachTopBar'), 'ai-coach-top-bar');
    assert.equal(slugify('  --  ', 'view'), 'view');
    assert.equal(humanize('account-settings'), 'Account settings');
    assert.equal(humanize('AICoachTopBar'), 'AI Coach Top Bar');
    assert.equal(humanize('quick_capture'), 'Quick capture');
  });
});
