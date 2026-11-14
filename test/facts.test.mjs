import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { buildFacts, factsOf, hasFacts, loadTypeScript, readBytes, withFacts } from '../lib/facts.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ts = loadTypeScript([REPO], { CHEFS_TABLE_TYPESCRIPT: process.env.CHEFS_TABLE_TEST_TYPESCRIPT });
const needsTs = { skip: ts ? false : 'no TypeScript compiler (npm install --no-save typescript, or set CHEFS_TABLE_TEST_TYPESCRIPT)' };
const tempDirs = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const ACCOUNT_PAGE = `
import { deleteAccount } from '../api/account';
import { useNavigate } from 'react-router-dom';
export const TABS = ['profile', 'billing'] as const;
export function AccountPage({ isAdmin }) {
  const navigate = useNavigate();
  const [step, setStep] = useState('idle');
  const items = [{ label: 'Download your data', onClick: download }];
  const handleResync = () => resync();
  const row = { onSync: () => handleResync() };
  if (!isAdmin) return <Redirect to="/home" />;
  return (
    <Page title="Account">
      <h1>Your account</h1>
      {step === 'confirm' && <Dialog>Are you sure?</Dialog>}
      <Button onClick={() => { setStep('confirm'); }}>Delete my account</Button>
      <Button onClick={async () => { await deleteAccount(); setSuccessText('Account deleted'); navigate('/goodbye'); setStep('done'); }}>Yes, delete</Button>
      <a href="/help">Get help</a>
    </Page>
  );
}
`;

/**
 * The lines of a facts sheet, keyed by their label.
 *
 * @param {string} sheet - A sheet from factsOf.
 * @returns {Record<string, string>} Label → rest of the line.
 */
function linesOf(sheet) {
  return Object.fromEntries(sheet.split('\n').slice(1).map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]));
}

describe('factsOf', () => {
  it('in CI, a compiler is installed so these tests run', { skip: !process.env.CI }, () => {
    assert.ok(ts, 'CI installs typescript before the tests');
  });

  it('summarises what a person sees and does on a page', needsTs, () => {
    const facts = factsOf(ts, 'src/pages/AccountPage.tsx', ACCOUNT_PAGE);
    const lines = linesOf(facts.sheet);
    assert.equal(facts.sheet.split('\n')[0], '### src/pages/AccountPage.tsx');
    assert.match(lines['defines'], /AccountPage/);
    assert.match(lines['on screen'], /Your account/);
    assert.match(lines['on screen'], /Account/);
    assert.match(lines['buttons'], /"Delete my account" → \(\) => \{ setStep\('confirm'\); \}/);
    assert.match(lines['buttons'], /"Download your data" \(menu item\)/);
    assert.match(lines['goes to'], /\/home/);
    assert.match(lines['goes to'], /'\/goodbye'/);
    assert.match(lines['goes to'], /\/help/);
    assert.match(lines['calls'], /deleteAccount/);
    assert.match(lines['messages'], /Account deleted/);
    assert.match(lines['changes'], /step → idle, confirm, done/);
    assert.match(lines['lists'], /TABS: profile, billing/);
    assert.match(lines['only when'], /step === 'confirm'/);
    assert.match(lines['only when'], /if !isAdmin/);
    assert.match(lines['uses'], /Button/);
    assert.match(lines['handles'], /handleResync/);
    assert.match(lines['handlers'], /onSync: \(\) => handleResync\(\)/);
    assert.equal(facts.readFull, null);
    assert.deepEqual(facts.actions.map((action) => action.label), ['Download your data', 'Delete my account', 'Yes, delete', 'Get help']);
  });

  it('keeps every entry on one short line, without control characters', needsTs, () => {
    const long = 'word '.repeat(60);
    const facts = factsOf(ts, 'src/Long.tsx', `export const A = () => <p title="${long}\u0007">x</p>;`);
    for (const line of facts.sheet.split('\n')) assert.ok(!/\u0007/.test(line));
    const title = linesOf(facts.sheet)['on screen'].split(' | ').find((entry) => entry.startsWith('word'));
    assert.ok(title.length <= 80, `capped: ${title.length}`);
  });

  it('asks for a full read when a reducer decides the steps', needsTs, () => {
    const facts = factsOf(ts, 'src/useFlow.ts', 'export function useFlow() { return useReducer(reduce, { step: 1 }); }');
    assert.equal(facts.readFull, 'its steps are decided by a reducer or state machine');
  });

  it('skips files that are not JavaScript or TypeScript', needsTs, () => {
    assert.equal(factsOf(ts, 'agent/main.go', 'package main'), null);
    assert.equal(factsOf(ts, 'prisma/schema.prisma', 'model User {}'), null);
  });

  it('parses .ts files without JSX, so type assertions still work', needsTs, () => {
    const facts = factsOf(ts, 'src/api/pay.ts', 'export const pay = (x) => fetch("/api/pay", <RequestInit>{ method: "POST" });');
    assert.match(linesOf(facts.sheet)['calls'], /fetch \/api\/pay/);
  });
});

describe('loadTypeScript', () => {
  it('is off when CHEFS_TABLE_FACTS=off', () => {
    assert.equal(loadTypeScript([REPO], { CHEFS_TABLE_FACTS: 'off', CHEFS_TABLE_TYPESCRIPT: process.env.CHEFS_TABLE_TEST_TYPESCRIPT }), null);
  });

  it('returns null when no compiler can be found', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-nots-'));
    tempDirs.push(dir);
    assert.equal(loadTypeScript([dir], {}), null);
  });
});

describe('buildFacts and withFacts', () => {
  it('records summary sizes, labelled actions and keeps items sorted', needsTs, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-facts-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'A.tsx'), 'export const A = () => <button onClick={go}>Start trial</button>;\r\n');
    writeFileSync(join(dir, 'src', 'main.go'), 'package main');
    const inventory = {
      items: [{ kind: 'form', file: 'src/A.tsx', line: 5, detail: 'form' }],
      files: { 'src/A.tsx': { bytes: 900, sha1: 'a' }, 'src/main.go': { bytes: 12, sha1: 'b' }, 'src/Gone.tsx': { bytes: 5, sha1: 'c' } },
    };
    const scan = buildFacts(dir, inventory, ts);
    assert.deepEqual(Object.keys(scan.sheets), ['src/A.tsx']);
    assert.equal(scan.files['src/A.tsx'].facts, Buffer.byteLength(scan.sheets['src/A.tsx']));
    assert.deepEqual(scan.actions, [{ kind: 'action', file: 'src/A.tsx', line: 1, detail: 'Start trial' }]);

    const merged = withFacts(inventory, scan);
    assert.equal(merged.files['src/A.tsx'].facts, scan.files['src/A.tsx'].facts);
    assert.equal(merged.files['src/main.go'].facts, undefined);
    assert.deepEqual(merged.items.map((item) => item.kind), ['action', 'form']);
    assert.deepEqual(withFacts(merged, scan).items.map((item) => item.kind), ['action', 'form'], 'a second scan replaces the actions');
    assert.ok(hasFacts(merged));
    assert.equal(hasFacts(inventory), false);
    assert.equal(withFacts(inventory, null), inventory);
  });
});

describe('readBytes', () => {
  it('counts the summary, unless the file must be read in full or has none', () => {
    assert.equal(readBytes({ bytes: 1000, facts: 60 }), 60);
    assert.equal(readBytes({ bytes: 1000, facts: 60, readFull: 'why' }), 1000);
    assert.equal(readBytes({ bytes: 1000 }), 1000);
    assert.equal(readBytes(undefined), 0);
  });
});
