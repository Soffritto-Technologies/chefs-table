import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffDocs, findConflicts, needsApproval, planKeys, strongestRollup } from '../lib/diff.mjs';
import { DEFAULT_CONFIG } from '../lib/types.mjs';

const step = (id, screen = null, overrides = {}) => ({
  id,
  say: `Step ${id}`,
  screen,
  anchor: { type: 'route', value: screen ?? '/x' },
  next: [],
  ...overrides,
});
const journey = (id, steps, overrides = {}) => ({ id, title: `Journey ${id}`, steps, ...overrides });
const doc = (journeys) => ({ version: 1, app: 'Demo', journeys });
const plan = (upsert = [], remove = [], touches) => ({ summary: 'plan', upsert, remove, ...(touches ? { touches } : {}) });
const config = { ...DEFAULT_CONFIG };

const payDoc = () =>
  doc([
    journey('pay', [step('cart', '/cart', { next: ['checkout'] }), step('checkout', '/checkout', { next: ['done'] }), step('done', '/done')]),
    journey('home', [step('landing', '/')]),
  ]);

describe('diffDocs', () => {
  it('treats a missing base as everything stable', () => {
    for (const base of [null, undefined]) {
      assert.deepEqual(diffDocs(base, payDoc()), { states: {}, removedJourneys: [], removedSteps: [] });
    }
  });

  it('omits stable keys when nothing changed', () => {
    assert.deepEqual(diffDocs(payDoc(), payDoc()), { states: {}, removedJourneys: [], removedSteps: [] });
  });

  it('marks a journey that only exists in current as new, with its steps', () => {
    const current = payDoc();
    current.journeys.push(journey('book', [step('start', '/book')]));
    const { states, removedJourneys } = diffDocs(payDoc(), current);
    assert.deepEqual(states, { 'j:book': 'new', 's:book/start': 'new' });
    assert.deepEqual(removedJourneys, []);
  });

  it('marks a journey that only exists in base as removed and carries the base object', () => {
    const base = payDoc();
    const current = doc([base.journeys[0]]);
    const { states, removedJourneys, removedSteps } = diffDocs(base, current);
    assert.deepEqual(states, { 'j:home': 'removed', 's:home/landing': 'removed' });
    assert.deepEqual(removedJourneys, [base.journeys[1]]);
    assert.deepEqual(removedSteps, []);
  });

  it('marks a changed step and the journey that holds it', () => {
    const current = payDoc();
    current.journeys[0].steps[1].say = 'Pay with a card';
    assert.deepEqual(diffDocs(payDoc(), current).states, { 's:pay/checkout': 'changed', 'j:pay': 'changed' });
  });

  it('marks a new step in an existing journey', () => {
    const current = payDoc();
    current.journeys[0].steps.push(step('receipt', '/receipt'));
    assert.deepEqual(diffDocs(payDoc(), current).states, { 's:pay/receipt': 'new', 'j:pay': 'changed' });
  });

  it('records a removed step with the base object', () => {
    const base = payDoc();
    const current = payDoc();
    current.journeys[0].steps.pop();
    const { states, removedSteps } = diffDocs(base, current);
    assert.deepEqual(states, { 's:pay/done': 'removed', 'j:pay': 'changed' });
    assert.deepEqual(removedSteps, [{ journeyId: 'pay', step: base.journeys[0].steps[2] }]);
  });

  it('marks a journey changed when only its title, area or who differs', () => {
    for (const patch of [{ title: 'New title' }, { area: 'buy' }, { who: 'Admin' }]) {
      const current = payDoc();
      Object.assign(current.journeys[1], patch);
      assert.deepEqual(diffDocs(payDoc(), current).states, { 'j:home': 'changed' }, JSON.stringify(patch));
    }
  });

  it('marks a step changed when any of say, screen, anchor, next, detail or subflow differs', () => {
    const patches = [
      { say: 'Different' },
      { screen: '/elsewhere' },
      { anchor: { type: 'file', value: 'src/a.js' } },
      { next: ['done'] },
      { detail: { sees: 'A form' } },
      { subflow: 'home' },
    ];
    for (const patch of patches) {
      const current = payDoc();
      Object.assign(current.journeys[0].steps[0], patch);
      assert.equal(diffDocs(payDoc(), current).states['s:pay/cart'], 'changed', JSON.stringify(patch));
    }
  });

  it('ignores key order inside anchors and details', () => {
    const base = payDoc();
    base.journeys[0].steps[0].anchor = { type: 'route', value: '/cart' };
    base.journeys[0].steps[0].detail = { sees: 'a', does: 'b' };
    const current = structuredClone(base);
    current.journeys[0].steps[0].anchor = { value: '/cart', type: 'route' };
    current.journeys[0].steps[0].detail = { does: 'b', sees: 'a' };
    assert.deepEqual(diffDocs(base, current).states, {});
  });
});

describe('planKeys', () => {
  it('lists new, changed and removed journeys and steps', () => {
    const changedPay = journey('pay', [step('cart', '/cart', { next: ['checkout'] }), step('checkout', '/checkout', { say: 'Changed' })]);
    const keys = planKeys(payDoc(), plan([changedPay, journey('book', [step('start', '/book')])], ['home']));
    assert.deepEqual([...keys].sort(), ['j:book', 'j:home', 'j:pay', 's:book/start', 's:home/landing', 's:pay/checkout', 's:pay/done']);
  });

  it('is empty when the plan changes nothing', () => {
    assert.equal(planKeys(payDoc(), plan([payDoc().journeys[0]])).size, 0);
  });
});

describe('findConflicts', () => {
  it('flags a new journey that adds a step on a screen another journey uses', () => {
    const book = journey('book-call', [step('pick', '/checkout')]);
    assert.deepEqual(findConflicts(payDoc(), plan([book]), config), [
      { screen: '/checkout', planJourney: 'book-call', otherJourneys: ['pay'], kind: 'add' },
    ]);
  });

  it('does not flag screens no other journey uses', () => {
    assert.deepEqual(findConflicts(payDoc(), plan([journey('book', [step('pick', '/book')])]), config), []);
  });

  it('does not flag a step without a screen', () => {
    assert.deepEqual(findConflicts(payDoc(), plan([journey('mail', [step('email', null)])]), config), []);
  });

  it('does not flag adding a step on a shared screen', () => {
    assert.deepEqual(findConflicts(payDoc(), plan([journey('book', [step('start', '/')])]), config), []);
  });

  it('flags changing an existing step on a shared screen', () => {
    const base = doc([journey('a', [step('s', '/')]), journey('b', [step('t', '/')])]);
    const edited = journey('a', [step('s', '/', { say: 'Changed' })]);
    assert.deepEqual(findConflicts(base, plan([edited]), config), [{ screen: '/', planJourney: 'a', otherJourneys: ['b'], kind: 'change' }]);
  });

  it('flags removing a step on a shared screen', () => {
    const base = doc([journey('a', [step('s', '/'), step('t', '/x')]), journey('b', [step('u', '/')])]);
    const trimmed = journey('a', [step('t', '/x')]);
    assert.deepEqual(findConflicts(base, plan([trimmed]), config), [{ screen: '/', planJourney: 'a', otherJourneys: ['b'], kind: 'remove' }]);
  });

  it('checks both the old and the new screen when a step moves', () => {
    const base = doc([journey('a', [step('s', '/one')]), journey('b', [step('t', '/one'), step('u', '/two')])]);
    const moved = journey('a', [step('s', '/two')]);
    assert.deepEqual(findConflicts(base, plan([moved]), config), [
      { screen: '/one', planJourney: 'a', otherJourneys: ['b'], kind: 'change' },
      { screen: '/two', planJourney: 'a', otherJourneys: ['b'], kind: 'change' },
    ]);
  });

  it('does not flag journeys that are upserted in the same plan', () => {
    const upserts = [journey('pay', [step('checkout', '/checkout', { say: 'Changed' })]), journey('book-call', [step('pick', '/checkout')])];
    assert.deepEqual(findConflicts(payDoc(), plan(upserts), config), []);
  });

  it('does not flag journeys that the plan removes', () => {
    const base = doc([journey('a', [step('s', '/x')]), journey('b', [step('t', '/x')])]);
    assert.deepEqual(findConflicts(base, plan([journey('c', [step('u', '/x')])], ['a', 'b']), config), []);
  });

  it('reports each screen, plan journey and kind once', () => {
    const book = journey('book', [step('one', '/checkout'), step('two', '/checkout')]);
    assert.equal(findConflicts(payDoc(), plan([book]), config).length, 1);
  });

  it('flags the screens of a removed journey that other journeys still use', () => {
    const base = doc([journey('pay', [step('a', '/checkout'), step('b', '/solo')]), journey('refund', [step('c', '/checkout')])]);
    assert.deepEqual(findConflicts(base, plan([], ['pay']), config), [
      { screen: '/checkout', planJourney: 'pay', otherJourneys: ['refund'], kind: 'remove' },
    ]);
  });

  it('ignores removal of an id that is not in the document', () => {
    assert.deepEqual(findConflicts(payDoc(), plan([], ['ghost']), config), []);
  });

  it('flags touched screens that other journeys use, under the first upserted journey', () => {
    const conflicts = findConflicts(payDoc(), plan([journey('book', [step('start', '/book')])], [], ['/checkout', '/nobody']), config);
    assert.deepEqual(conflicts, [{ screen: '/checkout', planJourney: 'book', otherJourneys: ['pay'], kind: 'touches' }]);
  });

  it('uses an empty plan journey when only touching, and ignores shared screens', () => {
    const conflicts = findConflicts(payDoc(), plan([], [], ['/checkout', '/']), config);
    assert.deepEqual(conflicts, [{ screen: '/checkout', planJourney: '', otherJourneys: ['pay'], kind: 'touches' }]);
  });

  it('uses the shared list from the config it is given', () => {
    const book = journey('book', [step('pick', '/checkout')]);
    assert.deepEqual(findConflicts(payDoc(), plan([book]), { ...config, shared: ['/checkout'] }), []);
  });

  it('sorts by screen, plan journey, then kind', () => {
    const base = doc([journey('x', [step('a', '/b'), step('c', '/a')])]);
    const upserts = [journey('z', [step('p', '/b')]), journey('y', [step('q', '/b'), step('r', '/a')])];
    const order = findConflicts(base, plan(upserts, [], ['/a']), config).map(({ screen, planJourney, kind }) => `${screen} ${planJourney} ${kind}`);
    assert.deepEqual(order, ['/a y add', '/a z touches', '/b y add', '/b z add']);
  });
});

describe('needsApproval', () => {
  it('is true when there are conflicts', () => {
    const conflict = { screen: '/x', planJourney: 'a', otherJourneys: ['b'], kind: 'add' };
    assert.equal(needsApproval(plan([journey('a', [])]), [conflict]), true);
  });

  it('is true when the plan touches more than one journey, counting removals', () => {
    assert.equal(needsApproval(plan([journey('a', []), journey('b', [])]), []), true);
    assert.equal(needsApproval(plan([journey('a', [])], ['b']), []), true);
  });

  it('is false for a single journey without conflicts', () => {
    assert.equal(needsApproval(plan([journey('a', [])]), []), false);
    assert.equal(needsApproval(plan([], ['a']), []), false);
  });
});

describe('strongestRollup', () => {
  it('returns stable for an empty list', () => {
    assert.equal(strongestRollup([]), 'stable');
  });

  it('follows the rollup order', () => {
    assert.equal(strongestRollup(['stable', 'new']), 'new');
    assert.equal(strongestRollup(['broken', 'stable']), 'broken');
    assert.equal(strongestRollup(['new', 'changed']), 'changed');
    assert.equal(strongestRollup(['broken', 'changed', 'conflict', 'new']), 'conflict');
  });
});
