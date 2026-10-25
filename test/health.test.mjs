import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  countFindings, findingsPath, healthChecks, loadFindings, saveFindings,
} from '../lib/health.mjs';

const step = (id, extra = {}) => ({ id, say: `Step ${id}`, screen: null, anchor: { type: 'file', value: `src/${id}.ts` }, next: [], ...extra });
const journey = (id, steps, extra = {}) => ({ id, title: `Journey ${id}`, steps, ...extra });
const doc = (...journeys) => ({ version: 1, app: 'Demo', journeys });
const outcome = (id, result, extra = {}) => step(id, { kind: 'outcome', result, ...extra });
const targets = (findings, check) => findings.filter((finding) => finding.check === check).map((finding) => finding.target);
const tempDirs = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('dead-end', () => {
  it('flags a step with nowhere to go that is not an outcome, as high', () => {
    const found = healthChecks(doc(journey('j', [step('a', { next: ['b'] }), step('b')])));
    assert.deepEqual(targets(found, 'dead-end'), ['s:j/b']);
    assert.equal(found.find((f) => f.check === 'dead-end').severity, 'high');
    assert.match(found.find((f) => f.check === 'dead-end').message, /"Step b" in "Journey j" has nowhere to go next/);
  });

  it('does not flag outcomes, steps that hand over to another journey, or steps with an arrow (in either shape)', () => {
    const found = healthChecks(doc(journey('j', [step('a', { next: [{ to: 'b', when: 'Yes' }, 'c'] }), outcome('b', 'success'), step('c', { continues: 'k' })]), journey('k', [outcome('x', 'success')])));
    assert.deepEqual(targets(found, 'dead-end'), []);
  });

  it('counts arrows to steps that do not exist as no way on', () => {
    assert.deepEqual(targets(healthChecks(doc(journey('j', [step('a', { next: ['ghost'] })]))), 'dead-end'), ['s:j/a']);
  });
});

describe('no-recovery', () => {
  const decision = (failure) => journey('j', [
    step('d', { kind: 'decision', next: [{ to: 'ok', when: 'Paid' }, { to: 'bad', when: 'Declined' }] }),
    outcome('ok', 'success'),
    { ...outcome('bad', 'failure'), ...failure },
  ]);

  it('flags a failure with no way back when the only other branch is another ending', () => {
    const found = healthChecks(doc(decision({})));
    assert.deepEqual(targets(found, 'no-recovery'), ['s:j/bad']);
    assert.equal(found.find((f) => f.check === 'no-recovery').severity, 'medium');
  });

  it('is quiet when the failure leads back, hands over, or the failing step offers another route', () => {
    assert.deepEqual(targets(healthChecks(doc(decision({ next: ['d'] }))), 'no-recovery'), []);
    assert.deepEqual(targets(healthChecks(doc(decision({ continues: 'k' }), journey('k', [outcome('x', 'success')]))), 'no-recovery'), []);
    const withAlternative = journey('j', [
      step('d', { kind: 'decision', next: [{ to: 'bad', when: 'Declined' }, { to: 'other', when: 'Pay another way' }] }),
      outcome('bad', 'failure'),
      outcome('other', 'success', { next: [] }),
    ]);
    withAlternative.steps[2] = step('other', { next: ['done'] });
    withAlternative.steps.push(outcome('done', 'success'));
    assert.deepEqual(targets(healthChecks(doc(withAlternative)), 'no-recovery'), []);
  });

  it('only looks at failures', () => {
    assert.deepEqual(targets(healthChecks(doc(journey('j', [step('a', { next: ['b'] }), outcome('b', 'abandoned')]))), 'no-recovery'), []);
  });
});

describe('no-success', () => {
  it('is high when a journey has endings but none is a success', () => {
    const found = healthChecks(doc(journey('j', [step('a', { next: ['b', 'c'] }), outcome('b', 'failure'), outcome('c', 'abandoned')])));
    const hit = found.find((f) => f.check === 'no-success');
    assert.deepEqual([hit.target, hit.severity], ['j:j', 'high']);
    assert.deepEqual(hit.evidence, ['s:j/b', 's:j/c']);
  });

  it('is low when a journey never says how it ends', () => {
    const hit = healthChecks(doc(journey('j', [step('a', { next: ['b'] }), step('b', { next: [] })]))).find((f) => f.check === 'no-success');
    assert.deepEqual([hit.target, hit.severity], ['j:j', 'low']);
  });

  it('is quiet with a success, or when the journey carries on elsewhere', () => {
    assert.deepEqual(targets(healthChecks(doc(journey('j', [outcome('a', 'success')]))), 'no-success'), []);
    assert.deepEqual(targets(healthChecks(doc(journey('j', [step('a', { continues: 'k' })]), journey('k', [outcome('x', 'success')]))), 'no-success'), []);
    assert.deepEqual(targets(healthChecks(doc(journey('j', []))), 'no-success'), [], 'an empty journey has nothing to check');
  });
});

describe('unreachable', () => {
  it('flags a step nothing leads to, and follows arrows of both shapes', () => {
    const found = healthChecks(doc(journey('j', [step('a', { next: [{ to: 'b', when: 'x' }] }), step('b', { next: ['c'] }), outcome('c', 'success'), step('lost', { next: ['c'] })])));
    assert.deepEqual(targets(found, 'unreachable'), ['s:j/lost']);
    assert.equal(found.find((f) => f.check === 'unreachable').severity, 'medium');
  });

  it('does not flag background steps, which start by themselves', () => {
    const found = healthChecks(doc(journey('j', [outcome('a', 'success'), step('sync', { kind: 'background', trigger: 'Every hour' })])));
    assert.deepEqual(targets(found, 'unreachable'), []);
  });
});

describe('rules-disagree', () => {
  const shared = (rulesA, rulesB, overrides = {}) => doc(
    journey('a', [step('s', { screen: '/signup', detail: { rules: rulesA } })]),
    journey('b', [step('t', { screen: '/signup', anchor: { type: 'file', value: 'src/s.ts' }, detail: { rules: rulesB }, ...overrides })]),
  );

  it('flags different numbers for the same noun on the same file and screen', () => {
    const found = healthChecks(shared(['Free plan: at most 5 contacts'], ['A person can add up to 10 contacts']));
    const hit = found.find((f) => f.check === 'rules-disagree');
    assert.deepEqual([hit.severity, hit.target], ['low', 's:a/s']);
    assert.match(hit.message, /don't agree: different numbers for "contact"/);
    assert.equal(hit.evidence.length, 1);
    assert.match(hit.evidence[0], /"Free plan: at most 5 contacts" \("Journey a"\) vs "A person can add up to 10 contacts" \("Journey b"\)/);
  });

  it('flags "required" against "optional" for the same thing', () => {
    const hit = healthChecks(shared(['Phone number is required'], ['Phone number is optional'])).find((f) => f.check === 'rules-disagree');
    assert.match(hit.evidence[0], /one says it is required, the other says it is optional/);
  });

  it('is quiet when the numbers agree, the nouns differ, the screens or files differ, or it is one journey', () => {
    assert.deepEqual(targets(healthChecks(shared(['Up to 5 contacts'], ['Up to 5 contacts'])), 'rules-disagree'), []);
    assert.deepEqual(targets(healthChecks(shared(['Up to 5 contacts'], ['Up to 10 emails'])), 'rules-disagree'), []);
    assert.deepEqual(targets(healthChecks(shared(['Phone is required'], ['Name is optional'])), 'rules-disagree'), []);
    assert.deepEqual(targets(healthChecks(shared(['Up to 5 contacts'], ['Up to 10 contacts'], { screen: '/other' })), 'rules-disagree'), []);
    assert.deepEqual(targets(healthChecks(shared(['Up to 5 contacts'], ['Up to 10 contacts'], { anchor: { type: 'file', value: 'src/z.ts' } })), 'rules-disagree'), []);
    const same = doc(journey('a', [step('s', { detail: { rules: ['Up to 5 contacts'] } }), step('t', { anchor: { type: 'file', value: 'src/s.ts' }, detail: { rules: ['Up to 10 contacts'] } })]));
    assert.deepEqual(targets(healthChecks(same), 'rules-disagree'), []);
  });
});

describe('orphans from coverage', () => {
  const coverage = { pages: { covered: 1, total: 3, missing: ['/a', '/b'] }, features: { covered: 0, total: 1, missing: ['desktop/imessage'] }, forms: { covered: 0, total: 0, missing: [] }, endpoints: { covered: 0, total: 0, missing: [] }, percent: 33 };

  it('turns missing pages and features into medium findings', () => {
    const found = healthChecks(doc(), null, coverage);
    assert.deepEqual(found.map((f) => [f.check, f.severity, f.target]), [
      ['orphan-feature', 'medium', 'feature:desktop/imessage'], ['orphan-page', 'medium', 'page:/a'], ['orphan-page', 'medium', 'page:/b'],
    ]);
    assert.match(found[0].message, /The imessage feature of desktop is in the code but not on the map\./);
    assert.match(found[1].message, /The page \/a is in the code but not on the map\./);
  });

  it('is quiet without coverage or when nothing is missing', () => {
    assert.deepEqual(healthChecks(doc(), null, null), []);
    assert.deepEqual(healthChecks(doc(), null, { pages: { missing: [] } }), []);
  });
});

describe('size and sharing', () => {
  const many = (count, build) => Array.from({ length: count }, (_, i) => build(i));

  it('flags a journey that touches 12 or more distinct files, counting the pages its routes point at', () => {
    const files = (n) => doc(journey('big', many(n, (i) => step(`s${i}`))));
    assert.deepEqual(targets(healthChecks(files(12)), 'complex-journey'), ['j:big']);
    assert.deepEqual(targets(healthChecks(files(11)), 'complex-journey'), []);
    const inventory = { pages: [{ route: '/a', file: 'app/a/page.tsx' }, { route: '/b/:param', file: 'app/b/page.tsx' }] };
    const viaRoutes = doc(journey('routes', [
      ...many(10, (i) => step(`s${i}`)), step('a', { screen: '/a' }), step('b', { screen: null, anchor: { type: 'route', value: '/b/123' } }),
    ]));
    assert.deepEqual(targets(healthChecks(viaRoutes, null), 'complex-journey'), []);
    assert.deepEqual(targets(healthChecks(viaRoutes, inventory), 'complex-journey'), ['j:routes']);
  });

  it('flags a file that 8 or more journeys use, with up to six of them as evidence', () => {
    const using = (n) => doc(...many(n, (i) => journey(`j${i}`, [step('s', { anchor: { type: 'file', value: 'src/layout.ts' } })])));
    const found = healthChecks(using(8));
    const hit = found.find((f) => f.check === 'shared-hotspot');
    assert.deepEqual([hit.target, hit.severity], ['file:src/layout.ts', 'low']);
    assert.match(hit.message, /src\/layout\.ts is used by 8 journeys/);
    assert.deepEqual(hit.evidence, ['j:j0', 'j:j1', 'j:j2', 'j:j3', 'j:j4', 'j:j5']);
    assert.deepEqual(targets(healthChecks(using(7)), 'shared-hotspot'), []);
  });

  it('counts a file once per journey, however many steps use it', () => {
    const one = doc(journey('j', many(9, (i) => step(`s${i}`, { anchor: { type: 'file', value: 'src/same.ts' } }))));
    assert.deepEqual(targets(healthChecks(one), 'shared-hotspot'), []);
  });

  it('flags a step with 6 or more rules', () => {
    const rules = (n) => doc(journey('j', [outcome('s', 'success', { detail: { rules: many(n, (i) => `Rule ${i}`) } })]));
    assert.deepEqual(targets(healthChecks(rules(6)), 'logic-heavy'), ['s:j/s']);
    assert.deepEqual(targets(healthChecks(rules(5)), 'logic-heavy'), []);
  });
});

describe('the list as a whole', () => {
  const messy = () => doc(
    journey('a', [step('s1', { next: ['s2'] }), step('s2'), step('lost')]),
    journey('b', [step('x', { kind: 'decision', next: [{ to: 'y', when: 'Declined' }] }), outcome('y', 'failure')]),
  );

  it('is the same every time, whichever way the input was built', () => {
    const first = healthChecks(messy(), null, { pages: { missing: ['/z'] } });
    assert.deepEqual(healthChecks(JSON.parse(JSON.stringify(messy())), null, { pages: { missing: ['/z'] } }), first);
  });

  it('lists the most serious first, then by check, target and id, with unique ids and short plain messages', () => {
    const found = healthChecks(messy(), null, { pages: { missing: ['/z'] } });
    const rank = { high: 0, medium: 1, low: 2 };
    for (let i = 1; i < found.length; i += 1) assert.ok(rank[found[i - 1].severity] <= rank[found[i].severity], `${found[i - 1].id} before ${found[i].id}`);
    assert.equal(new Set(found.map((f) => f.id)).size, found.length);
    assert.ok(found.every((f) => f.id === `${f.check}:${f.target}` && f.message.length <= 160 && !/[{}]/.test(f.message)));
    assert.deepEqual(found.map((f) => f.check).filter((c, i, all) => all.indexOf(c) === i), ['dead-end', 'no-success', 'no-recovery', 'orphan-page', 'unreachable']);
  });

  it('cuts a very long title so the message still fits', () => {
    const found = healthChecks(doc(journey('j', [step('a')], { title: 'T'.repeat(200) })));
    assert.ok(found.every((f) => f.message.length <= 160));
  });

  it('copes with a document that is not a map', () => {
    for (const junk of [null, {}, { journeys: 'no' }, { journeys: [null, 5, {}] }]) assert.deepEqual(healthChecks(junk).filter((f) => f.severity === 'high'), []);
  });

  it('counts by severity', () => {
    assert.deepEqual(countFindings(healthChecks(messy())), { high: 3, medium: 2, low: 1 });
  });
});

describe('storing findings', () => {
  it('writes sorted, indented JSON and reads it back; nothing stored reads as an empty list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-health-'));
    tempDirs.push(dir);
    assert.deepEqual(loadFindings(dir), []);
    const found = healthChecks(doc(journey('j', [step('a')])));
    saveFindings(dir, found);
    assert.deepEqual(loadFindings(dir), found);
    assert.ok(findingsPath(dir).endsWith(join('.journeys', 'findings.json')));
  });
});
