import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { areaLinks, guessOrder, journeyLinks, orderContainers } from '../lib/order.mjs';
import { validateDoc } from '../lib/model.mjs';
import { orderDoc } from '../lib/mapjob.mjs';

const step = (id, extra = {}) => ({ id, say: `Step ${id}`, screen: null, anchor: { type: 'file', value: `src/${id}.ts` }, next: [], ...extra });
const journey = (id, extra = {}, steps = [step('a')]) => ({ id, title: `Journey ${id}`, steps, ...extra });
const doc = (journeys, areas) => ({ version: 1, app: 'Demo', ...(areas ? { areas } : {}), journeys });

describe('journeyLinks', () => {
  it('reads next and continues, with next winning a duplicate and conditions from the step result', () => {
    const links = journeyLinks(doc([
      journey('a', { next: ['b', { to: 'c', when: 'has account' }] }, [step('s', { continues: 'b' }), step('t', { continues: 'd', kind: 'outcome', result: 'failure' })]),
      journey('b'), journey('c'), journey('d'),
    ]));
    assert.deepEqual(links, [
      { from: 'a', to: 'b', when: '', source: 'next' },
      { from: 'a', to: 'c', when: 'has account', source: 'next' },
      { from: 'a', to: 'd', when: 'if it fails', source: 'continues' },
    ]);
  });

  it('uses "if they stop" for abandoned and ignores self-links and unknown ids', () => {
    const links = journeyLinks(doc([
      journey('a', { next: ['a', 'ghost'] }, [step('s', { continues: 'b', kind: 'outcome', result: 'abandoned' }), step('t', { continues: 'a' })]),
      journey('b'),
    ]));
    assert.deepEqual(links, [{ from: 'a', to: 'b', when: 'if they stop', source: 'continues' }]);
  });
});

describe('areaLinks', () => {
  it('keeps existing, distinct, non-self targets', () => {
    const links = areaLinks({ areas: [{ id: 'x', title: 'X', next: ['y', 'y', 'x', 'nope'] }, { id: 'y', title: 'Y', next: [{ to: 'x', when: 'not now' }] }], journeys: [] });
    assert.deepEqual(links, [{ from: 'x', to: 'y', when: '' }, { from: 'y', to: 'x', when: 'not now' }]);
  });
});

describe('guessOrder', () => {
  const item = (key, title, say) => ({ key, title, say });
  it('chains start items, leads them into core and pay items, and sets anytime aside', () => {
    const guess = guessOrder([
      item('settings', 'Settings'), item('signup', 'Sign up'), item('onb', 'Getting started'), item('book', 'Book a call'), item('billing', 'Billing'), item('help', 'Help centre'),
    ]);
    assert.deepEqual(guess.edges, [{ from: 'signup', to: 'onb' }, { from: 'onb', to: 'book' }, { from: 'onb', to: 'billing' }]);
    assert.deepEqual(guess.anytime, ['settings', 'help']);
  });

  it('chains items in display order without a start item, and checks start before anytime', () => {
    assert.deepEqual(guessOrder([item('a', 'Book'), item('b', 'Pricing')]).edges, [{ from: 'a', to: 'b' }]);
    assert.deepEqual(guessOrder([item('p', 'Checkout'), item('a', 'Book'), item('b', 'Browse')]).edges, [{ from: 'a', to: 'b' }, { from: 'b', to: 'p' }]);
    assert.deepEqual(guessOrder([item('a', 'Account settings')]), { edges: [], anytime: ['a'] });
    const guess = guessOrder([item('a', 'Create an account'), item('b', 'Sign up', 'create your account'), item('c', 'Book')]);
    assert.deepEqual(guess, { edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }], anytime: [] });
  });

  it('matches whole words only, case-insensitively', () => {
    assert.deepEqual(guessOrder([item('a', 'PROFILE'), item('b', 'Payroll'), item('c', 'Paying')]).anytime, ['a']);
    assert.equal(guessOrder([item('a', 'Register'), item('b', 'Plans')]).edges.length, 1);
  });
});

describe('orderContainers', () => {
  it('lifts journey links onto sibling areas and lists sub-areas before journeys', () => {
    const areas = [{ id: 'top1', title: 'One' }, { id: 'top2', title: 'Two' }, { id: 'sub', title: 'Sub', parent: 'top1' }];
    const containers = orderContainers(doc([journey('a', { area: 'sub', next: ['b'] }), journey('b', { area: 'top2' }), journey('c', { area: 'top1' })], areas));
    const top = containers.find((container) => container.id === null);
    assert.deepEqual(top.links, [{ from: 'a:top1', to: 'a:top2', when: '' }]);
    assert.deepEqual(containers.find((container) => container.id === 'top1').children.map((child) => child.key), ['a:sub', 'j:c']);
  });
});

describe('orderContainers lifting', () => {
  it('lifts journey links to areas at every level', () => {
    const areas = [{ id: 'start', title: 'Start' }, { id: 'daily', title: 'Daily' }, { id: 'deep', title: 'Deep', parent: 'daily' }];
    const containers = orderContainers(doc([
      journey('join', { area: 'start', next: [{ to: 'brief', when: 'account made' }] }),
      journey('brief', { area: 'deep' }, [step('s', { continues: 'reply' })]),
      journey('reply', { area: 'daily' }),
    ], areas));
    assert.deepEqual(containers.find((c) => c.id === null).links, [{ from: 'a:start', to: 'a:daily', when: 'account made' }]);
    assert.deepEqual(containers.find((c) => c.id === 'daily').links, [{ from: 'a:deep', to: 'j:reply', when: '' }]);
  });
});

describe('orderDoc', () => {
  const base = doc([journey('a', { area: 'x' }), journey('b', { area: 'x' })], [{ id: 'x', title: 'X' }]);
  it('merges only next and anytime, drops self-links and counts links', () => {
    const result = orderDoc(base, { areas: { x: { anytime: true } }, journeys: { a: { next: [{ to: 'b', when: 'not now' }, 'a'], title: 'Hacked' } } });
    assert.equal(result.ok, true);
    assert.deepEqual([result.areas, result.journeys, result.links], [1, 1, 1]);
    assert.equal(result.doc.journeys[0].title, 'Journey a');
    assert.deepEqual(result.doc.journeys[0].next, [{ to: 'b', when: 'not now' }]);
    assert.equal(result.doc.areas[0].anytime, true);
  });

  it('reports unknown ids and unknown targets', () => {
    assert.equal(orderDoc(base, { journeys: { zzz: { next: [] } } }).ok, false);
    assert.equal(orderDoc(base, { journeys: { a: { next: ['ghost'] } } }).ok, false);
    assert.equal(orderDoc(base, []).ok, false);
  });
});

describe('validation of next and anytime', () => {
  it('cleans area and journey next like step next, and rejects bad shapes', () => {
    const good = validateDoc(doc([journey('a', { area: 'x', next: ['b', 'b', { to: 'b', when: 'x'.repeat(60) }], anytime: false }), journey('b', { area: 'x' })], [{ id: 'x', title: 'X', next: [] }]));
    assert.equal(good.ok, true);
    assert.deepEqual(good.doc.journeys[0].next, ['b']);
    assert.equal('anytime' in good.doc.journeys[0], false);
    assert.equal('next' in good.doc.areas[0], false);
    assert.equal(validateDoc(doc([journey('a', { next: ['ghost'] })])).ok, false);
    assert.equal(validateDoc(doc([journey('a', { anytime: 'yes' })])).ok, false);
    assert.equal(validateDoc(doc([journey('a')], [{ id: 'x', title: 'X', next: ['nope'] }])).ok, false);
  });
});

describe('orderContainers: journeys with no area', () => {
  it('puts them in an "other" level of their own, outside the top level, and leaves sub-flow-only journeys out', () => {
    const containers = orderContainers(doc([
      journey('a', { next: ['b'] }, [step('s', { subflow: 'card' })]),
      journey('b'),
      journey('card'),
      journey('c', { area: 'shop' }),
    ], [{ id: 'shop', title: 'Shop' }]));
    assert.deepEqual(containers.map((c) => c.id), [null, 'shop', 'other']);
    assert.deepEqual(containers[0].children.map((c) => c.key), ['a:shop']);
    const other = containers.find((c) => c.id === 'other');
    assert.deepEqual(other.children.map((c) => c.key), ['j:a', 'j:b']);
    assert.deepEqual(other.links, [{ from: 'j:a', to: 'j:b', when: '' }]);
  });

  it('adds no "other" level when every journey has an area', () => {
    const containers = orderContainers(doc([journey('a', { area: 'shop' })], [{ id: 'shop', title: 'Shop' }]));
    assert.deepEqual(containers.map((c) => c.id), [null, 'shop']);
  });
});
