import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildViewModel, escapeJsonForHtml, renderHtml, viewModelHash } from '../lib/render.mjs';
import { LIMITS, OTHER_AREA_ID } from '../lib/types.mjs';

const TEMPLATE_PATH = fileURLToPath(new URL('../templates/journeys.html', import.meta.url));
const SAMPLE = JSON.parse(readFileSync(new URL('../fixtures/sample-journeys.json', import.meta.url), 'utf8'));

/**
 * Makes a minimal step.
 *
 * @param {string} id - Step id.
 * @param {string[]} [next] - Following step ids.
 * @param {object} [extra] - Extra step fields.
 * @returns {object} Step.
 */
function step(id, next = [], extra = {}) {
  return { id, say: `Step ${id}`, screen: `/${id}`, anchor: { type: 'route', value: `/${id}` }, next, ...extra };
}

/**
 * Makes a minimal journey.
 *
 * @param {string} id - Journey id.
 * @param {string|undefined} area - Area id.
 * @param {object[]} steps - Steps.
 * @returns {object} Journey.
 */
function journey(id, area, steps) {
  const out = { id, title: `Journey ${id}`, steps };
  if (area) out.area = area;
  return out;
}

/**
 * A small doc: two areas, a journey with no area, and a sub-flow-only journey.
 *
 * @returns {object} JourneysDoc.
 */
function smallDoc() {
  return {
    version: 1,
    app: 'Test app',
    areas: [
      { id: 'buy', title: 'Buying' },
      { id: 'empty', title: 'Nothing here' },
      { id: 'acct', title: 'Account' },
    ],
    journeys: [
      journey('checkout', 'buy', [step('cart', ['pay']), step('pay', ['done'], { subflow: 'card' }), step('done')]),
      journey('login', 'acct', [step('form')]),
      journey('loose', undefined, [step('only')]),
      journey('card', undefined, [step('enter', ['bank']), step('bank')]),
    ],
  };
}

/**
 * Collects every node of a view-model tree.
 *
 * @param {object} node - Root node.
 * @returns {object[]} Nodes, depth first.
 */
function allNodes(node) {
  return [node, ...node.children.flatMap(allNodes)];
}

/**
 * Finds a step node by its node id in vm.journeys.
 *
 * @param {object} vm - View model.
 * @param {string} id - "<journeyId>/<stepId>".
 * @returns {object|undefined} Step node.
 */
function stepNode(vm, id) {
  return vm.journeys[id.split('/')[0]].children.find((child) => child.id === id);
}

describe('buildViewModel: tree structure', () => {
  it('builds app → areas → journeys → steps in doc order, skipping empty areas and adding Other last', () => {
    const vm = buildViewModel({ mode: 'canonical', doc: smallDoc() });
    assert.equal(vm.mode, 'canonical');
    assert.equal(vm.app, 'Test app');
    assert.equal(vm.root.kind, 'app');
    assert.equal(vm.root.title, 'Test app');
    assert.deepEqual(vm.root.children.map((area) => area.id), ['buy', 'acct', OTHER_AREA_ID]);
    assert.deepEqual(vm.root.children.map((area) => area.kind), ['area', 'area', 'area']);
    assert.equal(vm.root.children[2].title, 'Other');
    assert.deepEqual(vm.root.children[0].children.map((j) => j.id), ['checkout']);
    assert.deepEqual(vm.root.children[2].children.map((j) => j.id), ['loose']);
    const checkout = vm.root.children[0].children[0];
    assert.equal(checkout.kind, 'journey');
    assert.deepEqual(checkout.children.map((s) => s.id), ['checkout/cart', 'checkout/pay', 'checkout/done']);
    assert.deepEqual(checkout.edges, [['checkout/cart', 'checkout/pay'], ['checkout/pay', 'checkout/done']]);
    assert.equal(checkout.children[1].subflow, 'card');
    assert.equal(checkout.children[1].screen, '/pay');
    assert.deepEqual(checkout.children[2].children, []);
  });

  it('leaves out Other when every journey has an area or is a sub-flow', () => {
    const doc = smallDoc();
    doc.journeys = doc.journeys.filter((j) => j.id !== 'loose');
    const vm = buildViewModel({ mode: 'canonical', doc });
    assert.deepEqual(vm.root.children.map((area) => area.id), ['buy', 'acct']);
  });

  it('puts journeys with an unknown area id into Other', () => {
    const doc = smallDoc();
    doc.journeys[1].area = 'nope';
    const vm = buildViewModel({ mode: 'canonical', doc });
    const other = vm.root.children.find((area) => area.id === OTHER_AREA_ID);
    assert.deepEqual(other.children.map((j) => j.id), ['login', 'loose']);
  });

  it('keeps a sub-flow-only journey off the rings but in vm.journeys', () => {
    const vm = buildViewModel({ mode: 'canonical', doc: smallDoc() });
    const ringJourneys = vm.root.children.flatMap((area) => area.children.map((j) => j.id));
    assert.ok(!ringJourneys.includes('card'));
    assert.deepEqual(Object.keys(vm.journeys), ['checkout', 'login', 'loose', 'card']);
    assert.equal(vm.journeys.card.kind, 'journey');
    assert.deepEqual(vm.journeys.card.children.map((s) => s.id), ['card/enter', 'card/bank']);
  });

  it('places a sub-flow journey that has its own area on its ring as usual', () => {
    const doc = smallDoc();
    doc.journeys[3].area = 'buy';
    const vm = buildViewModel({ mode: 'canonical', doc });
    assert.deepEqual(vm.root.children[0].children.map((j) => j.id), ['checkout', 'card']);
  });

  it('shares journey nodes between the tree and vm.journeys', () => {
    const vm = buildViewModel({ mode: 'canonical', doc: smallDoc() });
    assert.equal(vm.root.children[0].children[0], vm.journeys.checkout);
  });

  it('builds the sample fixture with Card payment as a sub-flow and Join the newsletter in Other', () => {
    const vm = buildViewModel({ mode: 'canonical', doc: SAMPLE });
    assert.deepEqual(vm.root.children.map((area) => area.id), ['shop', 'account', 'studio', OTHER_AREA_ID]);
    assert.ok(vm.journeys['card-payment']);
    assert.ok(!vm.root.children.some((area) => area.children.some((j) => j.id === 'card-payment')));
    assert.equal(stepNode(vm, 'checkout/pay').subflow, 'card-payment');
    assert.equal(stepNode(vm, 'checkout/receipt').screen, null);
  });

  it('copies only known step detail fields', () => {
    const doc = smallDoc();
    doc.journeys[1].steps[0].detail = { sees: 'A form', rules: ['One', 2, ''], files: [], junk: 'x' };
    const vm = buildViewModel({ mode: 'canonical', doc });
    assert.deepEqual(stepNode(vm, 'login/form').detail, { sees: 'A form', rules: ['One'] });
  });
});

describe('buildViewModel: nested areas and layout', () => {
  /**
   * A doc with three levels of areas: contacts → follow-ups → overdue, plus a sibling section.
   *
   * @returns {object} JourneysDoc.
   */
  function nestedDoc() {
    return {
      version: 1,
      app: 'CRM',
      areas: [
        { id: 'contacts', title: 'Contacts' },
        { id: 'follow-ups', title: 'Follow-ups', parent: 'contacts' },
        { id: 'overdue', title: 'Overdue', parent: 'follow-ups' },
        { id: 'empty-section', title: 'Nothing yet', parent: 'contacts' },
        { id: 'import', title: 'Import', parent: 'contacts' },
        { id: 'settings', title: 'Settings' },
      ],
      journeys: [
        journey('add-contact', 'contacts', [step('form')]),
        journey('finish-follow-up', 'follow-ups', [step('open', ['done']), step('done')]),
        journey('chase', 'overdue', [step('remind')]),
        journey('csv', 'import', [step('upload')]),
        journey('stray', 'no-such-area', [step('x')]),
        journey('loose', undefined, [step('y')]),
      ],
    };
  }

  it('nests sections three levels deep, sections before the area journeys', () => {
    const vm = buildViewModel({ mode: 'canonical', doc: nestedDoc() });
    assert.deepEqual(vm.root.children.map((a) => a.id), ['contacts', OTHER_AREA_ID]);
    const contacts = vm.root.children[0];
    assert.deepEqual(contacts.children.map((c) => [c.kind, c.id]), [['area', 'follow-ups'], ['area', 'import'], ['journey', 'add-contact']]);
    const followUps = contacts.children[0];
    assert.deepEqual(followUps.children.map((c) => [c.kind, c.id]), [['area', 'overdue'], ['journey', 'finish-follow-up']]);
    const overdue = followUps.children[0];
    assert.deepEqual(overdue.children.map((c) => c.id), ['chase']);
    assert.equal(overdue.children[0], vm.journeys.chase);
  });

  it('skips areas and sections with no journeys anywhere beneath them', () => {
    const vm = buildViewModel({ mode: 'canonical', doc: nestedDoc() });
    const ids = allNodes(vm.root).filter((n) => n.kind === 'area').map((n) => n.id);
    assert.ok(!ids.includes('empty-section'));
    assert.ok(!ids.includes('settings'));
  });

  it('sends journeys with a missing or unknown area to Other', () => {
    const vm = buildViewModel({ mode: 'canonical', doc: nestedDoc() });
    const other = vm.root.children.find((a) => a.id === OTHER_AREA_ID);
    assert.deepEqual(other.children.map((j) => j.id), ['stray', 'loose']);
  });

  it('treats an area whose parent is unknown or loops as top-level', () => {
    const doc = nestedDoc();
    doc.areas.push({ id: 'orphan', title: 'Orphan', parent: 'gone' }, { id: 'p', title: 'P', parent: 'q' }, { id: 'q', title: 'Q', parent: 'p' });
    doc.journeys.push(journey('o1', 'orphan', [step('a')]), journey('p1', 'p', [step('a')]), journey('q1', 'q', [step('a')]));
    const vm = buildViewModel({ mode: 'canonical', doc });
    assert.deepEqual(vm.root.children.map((a) => a.id), ['contacts', 'orphan', 'p', 'q', OTHER_AREA_ID]);
  });

  it('rolls a deep change up through every section to the app', () => {
    const vm = buildViewModel({
      mode: 'session',
      doc: nestedDoc(),
      sinceStart: { states: { 's:chase/remind': 'changed' }, removedJourneys: [], removedSteps: [] },
    });
    const contacts = vm.root.children[0];
    const followUps = contacts.children[0];
    assert.equal(followUps.children[0].rollup, 'changed');
    assert.equal(followUps.rollup, 'changed');
    assert.equal(contacts.rollup, 'changed');
    assert.equal(contacts.children.find((c) => c.id === 'import').rollup, 'stable');
    assert.equal(vm.root.rollup, 'changed');
  });

  it('gives the sample fixture an area with two sections and a journey of its own', () => {
    const vm = buildViewModel({ mode: 'canonical', doc: SAMPLE });
    const studio = vm.root.children.find((a) => a.id === 'studio');
    assert.deepEqual(studio.children.map((c) => [c.kind, c.id]), [['area', 'studio-orders'], ['area', 'studio-catalogue'], ['journey', 'weekly-sales']]);
  });

  /**
   * A doc with one area holding `count` journeys (and optionally sections).
   *
   * @param {number} count - Journeys directly in the area.
   * @returns {object} JourneysDoc.
   */
  function crowdedDoc(count) {
    const journeys = Array.from({ length: count }, (_, i) => ({ ...journey(`j${String(i).padStart(3, '0')}`, 'big', [step('s')]), title: `Journey ${String.fromCharCode(90 - (i % 26))}${i}` }));
    return { version: 1, app: 'Big', areas: [{ id: 'big', title: 'Big' }], journeys };
  }

  it('uses a ring up to 24 children and a grid from 25', () => {
    const ring = buildViewModel({ mode: 'canonical', doc: crowdedDoc(24) });
    assert.equal(ring.root.layout, 'ring');
    assert.equal(ring.root.children[0].layout, 'ring');
    assert.deepEqual(ring.root.children[0].children.map((j) => j.id), crowdedDoc(24).journeys.map((j) => j.id));
    const grid = buildViewModel({ mode: 'canonical', doc: crowdedDoc(25) });
    assert.equal(grid.root.layout, 'ring');
    assert.equal(grid.root.children[0].layout, 'grid');
    assert.equal(grid.root.children[0].children.length, 25);
    assert.equal('layout' in grid.journeys.j000, false);
  });

  it('orders a grid sections first, then by rollup strength, then by title', () => {
    const doc = crowdedDoc(30);
    doc.areas.push({ id: 'sub-b', title: 'b section', parent: 'big' }, { id: 'sub-a', title: 'A section', parent: 'big' });
    doc.journeys.push(journey('in-b', 'sub-b', [step('s')]), journey('in-a', 'sub-a', [step('s')]));
    const vm = buildViewModel({
      mode: 'session',
      doc,
      sinceStart: { states: { 'j:j010': 'new', 'j:j020': 'changed', 'j:in-b': 'changed' }, removedJourneys: [], removedSteps: [] },
      conflicts: [{ screen: '/s', planJourney: 'j005', otherJourneys: [], kind: 'touches' }],
    });
    const big = vm.root.children[0];
    assert.equal(big.layout, 'grid');
    const kids = big.children;
    assert.deepEqual(kids.slice(0, 2).map((c) => c.id), ['sub-b', 'sub-a']);
    assert.deepEqual(kids.slice(2, 5).map((c) => [c.id, c.rollup]), [['j005', 'conflict'], ['j020', 'changed'], ['j010', 'new']]);
    const stableTitles = kids.slice(5).map((c) => c.title.toLowerCase());
    assert.deepEqual(stableTitles, [...stableTitles].sort());
  });

  it('builds identical output for the same nested input', () => {
    const a = buildViewModel({ mode: 'canonical', doc: crowdedDoc(40) });
    const b = buildViewModel({ mode: 'canonical', doc: crowdedDoc(40) });
    assert.equal(viewModelHash(a), viewModelHash(b));
    assert.equal(renderHtml(a, { templatePath: TEMPLATE_PATH }), renderHtml(b, { templatePath: TEMPLATE_PATH }));
  });
});

describe('buildViewModel: step labels', () => {
  /**
   * Builds one journey whose steps have the given sentences (and optional labels) and returns its step nodes.
   *
   * @param {Array<string | { say: string, label?: string }>} specs - Step sentences or { say, label }.
   * @returns {object[]} Step nodes.
   */
  function stepsFor(specs) {
    const steps = specs.map((spec, i) => {
      const { say, label } = typeof spec === 'string' ? { say: spec } : spec;
      return { ...step(`s${i}`), say, ...(label === undefined ? {} : { label }) };
    });
    return buildViewModel({ mode: 'canonical', doc: { version: 1, app: 'A', journeys: [journey('j', 'x', steps)] } }).journeys.j.children;
  }

  it('shows a given label and keeps the full sentence for the card', () => {
    const [node] = stepsFor([{ say: 'A popup says "Waiting for authentication..." and tells the person to finish signing in', label: 'Finish signing in' }]);
    assert.equal(node.title, 'Finish signing in');
    assert.equal(node.say, 'A popup says "Waiting for authentication..." and tells the person to finish signing in');
    assert.equal('derivedLabel' in node, false);
  });

  it('derives a label from the first clause when there is none', () => {
    const nodes = stepsFor([
      'Fills in name, email and password',
      'Opens the app and signs in',
      'Picks a sign-in method — Google or email',
      'Confirms with the bank; a code arrives by text',
      'Lands on the page. Then waits',
    ]);
    assert.deepEqual(nodes.map((n) => n.title), ['Fills in name', 'Opens the app', 'Picks a sign-in method', 'Confirms with the bank', 'Lands on the page']);
    assert.ok(nodes.every((n) => n.derivedLabel === true));
    assert.equal(nodes[0].say, 'Fills in name, email and password');
  });

  it('cuts a long single clause at a word boundary with an ellipsis, within 48 characters', () => {
    const [node] = stepsFor(['Reviews every single item in the basket before deciding whether to continue to checkout']);
    assert.equal(node.title, 'Reviews every single item in the basket before…');
    assert.ok([...node.title].length <= LIMITS.LABEL);
  });

  it('keeps a clause of exactly 48 characters whole, and cuts one of 49', () => {
    const exact = 'Checks the delivery address against the postcode';
    assert.equal(exact.length, 48);
    const [whole, cut] = stepsFor([exact, `${exact}s`]);
    assert.equal(whole.title, exact);
    assert.equal(cut.title, 'Checks the delivery address against the…');
    assert.ok([...cut.title].length <= 48);
  });

  it('falls back to the step id when there is no sentence and shortens over-long given labels', () => {
    const [empty, long] = stepsFor([{ say: '' }, { say: 'x', label: 'Open the very long settings page for notification preferences' }]);
    assert.equal(empty.title, 's0');
    assert.equal('say' in empty, false);
    assert.equal(long.title, 'Open the very long settings page for…');
    assert.equal('derivedLabel' in long, false);
  });

  it('labels most sample steps and derives the one without a label', () => {
    const vm = buildViewModel({ mode: 'canonical', doc: SAMPLE });
    const handOver = stepNode(vm, 'fulfil-orders/hand-over');
    assert.equal(handOver.title, 'Hands it to the courier');
    assert.equal(handOver.derivedLabel, true);
    assert.equal(stepNode(vm, 'checkout/pay').title, 'Pay for the order');
  });

  it('escapes hostile labels when rendering', () => {
    const doc = smallDoc();
    doc.journeys[0].steps[0].label = '</script><img src=x onerror=alert(1)>';
    const html = renderHtml(buildViewModel({ mode: 'canonical', doc }), { templatePath: TEMPLATE_PATH });
    assert.ok(!html.includes('</script><img'));
  });
});

describe('buildViewModel: apps', () => {
  /**
   * smallDoc with apps; `checkout` is in both apps, `login` only on the desktop.
   *
   * @param {object[]} [apps] - JourneysDoc.apps.
   * @returns {object} JourneysDoc.
   */
  function appsDoc(apps = [{ id: 'web', title: 'Web app', kind: 'web', root: 'web' }, { id: 'mac', title: 'Mac app', kind: 'desktop', root: 'mac' }]) {
    const doc = smallDoc();
    doc.apps = apps;
    doc.journeys[0].apps = ['mac', 'web', 'ghost'];
    doc.journeys[1].apps = ['mac'];
    return doc;
  }

  it('carries the apps and each journey node its app ids in the apps order', () => {
    const vm = buildViewModel({ mode: 'canonical', doc: appsDoc() });
    assert.deepEqual(vm.apps, [{ id: 'web', title: 'Web app', kind: 'web' }, { id: 'mac', title: 'Mac app', kind: 'desktop' }]);
    assert.deepEqual(vm.journeys.checkout.apps, ['web', 'mac']);
    assert.deepEqual(vm.journeys.login.apps, ['mac']);
    assert.deepEqual(vm.journeys.loose.apps, []);
    assert.equal('apps' in stepNode(vm, 'checkout/cart'), false);
    assert.equal(vm.root.rollup, 'stable');
  });

  it('gives the app and every area its layout per app', () => {
    const vm = buildViewModel({ mode: 'canonical', doc: appsDoc() });
    assert.deepEqual(vm.root.layouts, { web: 'ring', mac: 'ring' });
    for (const area of vm.root.children) assert.deepEqual(Object.keys(area.layouts), ['web', 'mac']);
    const doc = appsDoc();
    for (let i = 0; i < 30; i++) doc.journeys.push({ ...journey(`big${i}`, 'buy', [step('s')]), apps: i < 26 ? ['web'] : ['mac'] });
    const buy = buildViewModel({ mode: 'canonical', doc }).root.children.find((a) => a.id === 'buy');
    assert.equal(buy.layout, 'grid');
    assert.deepEqual(buy.layouts, { web: 'grid', mac: 'ring' });
  });

  it('shows no apps, tags or per-app layouts on a single-app map', () => {
    for (const apps of [null, [{ id: 'web', title: 'Web app', kind: 'web', root: '.' }]]) {
      const doc = appsDoc(apps);
      if (apps === null) delete doc.apps;
      const vm = buildViewModel({ mode: 'canonical', doc });
      assert.equal('apps' in vm, false);
      assert.equal('apps' in vm.journeys.checkout, false);
      assert.equal('layouts' in vm.root, false);
    }
  });

  it('defaults unknown kinds to web, skips duplicate ids and stays deterministic', () => {
    const doc = appsDoc([{ id: 'a', title: 'A', kind: 'toaster' }, { id: 'a', title: 'Again' }, { id: 'b', title: 'B', kind: 'server' }]);
    const vm = buildViewModel({ mode: 'canonical', doc });
    assert.deepEqual(vm.apps, [{ id: 'a', title: 'A', kind: 'web' }, { id: 'b', title: 'B', kind: 'server' }]);
    assert.equal(viewModelHash(vm), viewModelHash(buildViewModel({ mode: 'canonical', doc: appsDoc([{ id: 'a', title: 'A', kind: 'toaster' }, { id: 'a', title: 'Again' }, { id: 'b', title: 'B', kind: 'server' }]) })));
  });

  it('escapes hostile app titles when rendering', () => {
    const doc = appsDoc([{ id: 'x', title: '</script><img src=x onerror=alert(1)>', kind: 'web' }, { id: 'y', title: 'Y', kind: 'agent' }]);
    const html = renderHtml(buildViewModel({ mode: 'canonical', doc }), { templatePath: TEMPLATE_PATH });
    assert.ok(!html.includes('</script><img'));
  });

  it('tags the sample with a web app and a Mac app, one journey in both', () => {
    const vm = buildViewModel({ mode: 'canonical', doc: SAMPLE });
    assert.deepEqual(vm.apps.map((a) => a.title), ['Web app', 'Mac app']);
    assert.deepEqual(vm.journeys['track-order'].apps, ['web', 'mac']);
    assert.deepEqual(vm.journeys['fulfil-orders'].apps, ['mac']);
  });
});

describe('buildViewModel: flow logic', () => {
  /**
   * One journey from raw steps; returns the view model.
   *
   * @param {object[]} steps - Steps.
   * @param {object[]} [extra] - More journeys.
   * @returns {object} View model.
   */
  function vmFor(steps, extra = []) {
    return buildViewModel({ mode: 'canonical', doc: { version: 1, app: 'A', journeys: [journey('j', 'x', steps), ...extra] } });
  }

  it('keeps conditions on edges as a third element, accepting ids and { to, when } links', () => {
    const vm = vmFor([
      step('ask', [{ to: 'yes', when: 'Approved' }, 'no', { to: 'no', when: 'dup' }, { to: 'ghost', when: 'x' }, { when: 'no target' }], { kind: 'decision' }),
      step('yes'),
      step('no'),
    ]);
    assert.deepEqual(vm.journeys.j.edges, [['j/ask', 'j/yes', 'Approved'], ['j/ask', 'j/no']]);
    assert.deepEqual(vm.journeys.j.children.map((s) => s.depth), [0, 1, 1]);
  });

  it('carries decision, outcome and background logic on step nodes', () => {
    const vm = vmFor([
      step('ask', ['ok', 'bad', 'quit', 'end'], { kind: 'decision' }),
      step('ok', [], { kind: 'outcome', result: 'success' }),
      step('bad', [], { kind: 'outcome', result: 'failure' }),
      step('quit', [], { kind: 'outcome', result: 'abandoned' }),
      step('end', [], { kind: 'outcome', result: 'maybe' }),
      step('job', [], { kind: 'background', trigger: `Every hour ${'and then some more '.repeat(5)}` }),
      step('plain', [], { kind: 'nonsense', result: 'success' }),
    ]);
    const [ask, ok, bad, quit, end, job, plain] = vm.journeys.j.children;
    assert.equal(ask.stepKind, 'decision');
    assert.deepEqual([ok, bad, quit].map((n) => [n.stepKind, n.result]), [['outcome', 'success'], ['outcome', 'failure'], ['outcome', 'abandoned']]);
    assert.equal(end.stepKind, 'outcome');
    assert.equal('result' in end, false);
    assert.equal(job.stepKind, 'background');
    assert.ok(job.trigger.startsWith('Every hour') && [...job.trigger].length <= 60);
    assert.equal('stepKind' in plain, false);
    assert.equal('result' in plain, false);
  });

  it('links continues only to another journey that is on the map', () => {
    const vm = vmFor(
      [step('a', [], { continues: 'pay' }), step('b', [], { continues: 'nowhere' }), step('c', [], { continues: 'j' })],
      [journey('pay', 'x', [step('p')])],
    );
    const [a, b, c] = vm.journeys.j.children;
    assert.equal(a.continues, 'pay');
    assert.equal('continues' in b, false);
    assert.equal('continues' in c, false);
  });

  it('makes up to two short rule chips and counts the rest', () => {
    const rules = ['Card declined → the error stays on the page and nothing is charged', 'Three wrong codes cancel', 'One', 'Two', 'Three'];
    const [many, few, none] = vmFor([step('a', [], { detail: { rules } }), step('b', [], { detail: { rules: ['Only rule'] } }), step('c')]).journeys.j.children;
    assert.equal(many.ruleChips.length, 2);
    assert.ok(many.ruleChips[0].endsWith('…') && [...many.ruleChips[0]].length <= 30);
    assert.equal(many.ruleChips[1], 'Three wrong codes cancel');
    assert.equal(many.moreRules, 3);
    assert.deepEqual(many.detail.rules, rules);
    assert.deepEqual(few.ruleChips, ['Only rule']);
    assert.equal('moreRules' in few, false);
    assert.equal('ruleChips' in none, false);
  });

  it('shows the sample decision, its conditions, every outcome kind, a continues link and a background trigger', () => {
    const vm = buildViewModel({ mode: 'canonical', doc: SAMPLE });
    assert.equal(stepNode(vm, 'card-payment/bank-check').stepKind, 'decision');
    assert.ok(vm.journeys['card-payment'].edges.some((e) => e[2] === 'Card declined' || e[2] === 'Declined'));
    const results = Object.values(vm.journeys).flatMap((j) => j.children).filter((n) => n.stepKind === 'outcome').map((n) => n.result).sort();
    assert.deepEqual([...new Set(results)], ['abandoned', 'failure', 'success']);
    assert.equal(stepNode(vm, 'browse/bouquet').continues, 'checkout');
    assert.equal(stepNode(vm, 'newsletter/weekly-send').trigger, 'Every Friday at 9:00');
  });
});

describe('buildViewModel: findings', () => {
  const FINDINGS = [
    { id: 'f-low', check: 'complex-journey', severity: 'low', target: 'j:checkout', message: 'Long' },
    { id: 'f-high', check: 'dead-end', severity: 'high', target: 's:checkout/done', message: 'Stops', evidence: ['a.ts', 3, ''] },
    { id: 'f-med', check: 'no-recovery', severity: 'medium', target: 's:checkout/pay', message: 'No retry' },
    { id: 'f-page', check: 'orphan-page', severity: 'medium', target: 'page:/admin', message: 'Unreached' },
    { id: 'f-sub', check: 'dead-end', severity: 'bogus', target: 's:card/bank', message: 'Sub-flow' },
    { id: 'f-high', check: 'dup', severity: 'low', target: 'j:login', message: 'Duplicate id' },
    { check: 'no-id', severity: 'high', target: 'j:login', message: 'Dropped' },
  ];

  it('lists findings cleaned and ordered by severity, target and id', () => {
    const vm = buildViewModel({ mode: 'canonical', doc: smallDoc(), findings: FINDINGS });
    assert.deepEqual(vm.findings.map((f) => [f.id, f.severity]), [['f-high', 'high'], ['f-page', 'medium'], ['f-med', 'medium'], ['f-low', 'low'], ['f-sub', 'low']]);
    assert.deepEqual(vm.findings[0].evidence, ['a.ts']);
  });

  it('marks steps, journeys, areas and the app with counts and the strongest severity', () => {
    const vm = buildViewModel({ mode: 'canonical', doc: smallDoc(), findings: FINDINGS });
    assert.deepEqual([stepNode(vm, 'checkout/done').findingCount, stepNode(vm, 'checkout/done').findingSeverity], [1, 'high']);
    assert.deepEqual([stepNode(vm, 'checkout/pay').findingCount, stepNode(vm, 'checkout/pay').findingSeverity], [1, 'medium']);
    assert.equal('findingCount' in stepNode(vm, 'checkout/cart'), false);
    assert.deepEqual([vm.journeys.checkout.findingCount, vm.journeys.checkout.findingSeverity], [3, 'high']);
    const buy = vm.root.children.find((a) => a.id === 'buy');
    assert.deepEqual([buy.findingCount, buy.findingSeverity], [3, 'high']);
    assert.deepEqual([vm.root.findingCount, vm.root.findingSeverity], [3, 'high']);
    assert.deepEqual([vm.journeys.card.findingCount, stepNode(vm, 'card/bank').findingSeverity], [1, 'low']);
    assert.equal('findingCount' in vm.journeys.login, false);
  });

  it('adds nothing without findings and an empty list when given none', () => {
    const plain = buildViewModel({ mode: 'canonical', doc: smallDoc() });
    assert.equal('findings' in plain, false);
    assert.equal('findingCount' in plain.root, false);
    const empty = buildViewModel({ mode: 'canonical', doc: smallDoc(), findings: [] });
    assert.deepEqual(empty.findings, []);
  });

  it('escapes hostile finding text and stays deterministic', () => {
    const hostile = [{ id: 'x', check: '</script><b>', severity: 'high', target: 'page:</script><img src=x onerror=alert(1)>', message: '</script><img src=x onerror=alert(1)>', evidence: ['</script>'] }];
    const html = renderHtml(buildViewModel({ mode: 'canonical', doc: smallDoc(), findings: hostile }), { templatePath: TEMPLATE_PATH });
    assert.ok(!html.includes('</script><img'));
    assert.ok(!html.includes('</script><b>'));
    const unique = FINDINGS.slice(0, 5);
    const a = buildViewModel({ mode: 'canonical', doc: SAMPLE, findings: unique });
    const b = buildViewModel({ mode: 'canonical', doc: SAMPLE, findings: [...unique].reverse() });
    assert.equal(viewModelHash(a), viewModelHash(b));
  });
});

describe('buildViewModel: depth', () => {
  it('uses the longest path from entry steps, across a branch', () => {
    const doc = {
      version: 1,
      app: 'A',
      journeys: [journey('j', 'x', [step('a', ['b', 'c']), step('b', ['d']), step('c', ['e']), step('e', ['d']), step('d')])],
    };
    const vm = buildViewModel({ mode: 'canonical', doc });
    const depths = Object.fromEntries(vm.journeys.j.children.map((s) => [s.id, s.depth]));
    assert.deepEqual(depths, { 'j/a': 0, 'j/b': 1, 'j/c': 1, 'j/e': 2, 'j/d': 3 });
  });

  it('guards cycles, self-loops and dangling next ids', () => {
    const doc = {
      version: 1,
      app: 'A',
      journeys: [
        journey('j', 'x', [step('enter', ['check', 'ghost']), step('check', ['result']), step('result', ['enter', 'result'])]),
        journey('ring', 'x', [step('p', ['q']), step('q', ['r']), step('r', ['p'])]),
      ],
    };
    const vm = buildViewModel({ mode: 'canonical', doc });
    assert.deepEqual(vm.journeys.j.children.map((s) => s.depth), [0, 1, 2]);
    assert.deepEqual(vm.journeys.j.edges, [
      ['j/enter', 'j/check'],
      ['j/check', 'j/result'],
      ['j/result', 'j/enter'],
      ['j/result', 'j/result'],
    ]);
    assert.deepEqual(vm.journeys.ring.children.map((s) => s.depth), [0, 1, 2]);
  });

  it('keeps the first step as the entry when a retry loop points back to it', () => {
    const doc = {
      version: 1,
      app: 'A',
      journeys: [journey('pay', 'x', [step('card', ['bank']), step('wallet', ['result']), step('bank', ['result']), step('result', ['card'])])],
    };
    const vm = buildViewModel({ mode: 'canonical', doc });
    const depths = Object.fromEntries(vm.journeys.pay.children.map((s) => [s.id, s.depth]));
    assert.deepEqual(depths, { 'pay/card': 0, 'pay/wallet': 0, 'pay/bank': 1, 'pay/result': 2 });
  });

  it('computes depths for the sample card payment loop', () => {
    const vm = buildViewModel({ mode: 'canonical', doc: SAMPLE });
    const depths = Object.fromEntries(vm.journeys['card-payment'].children.map((s) => [s.id.split('/')[1], s.depth]));
    assert.deepEqual(depths, { 'card-details': 0, 'bank-check': 1, declined: 2, paid: 2, 'gave-up': 3 });
  });
});

describe('buildViewModel: session mode', () => {
  /**
   * Session input over smallDoc with a deep change in the sub-flow.
   *
   * @param {object} [overrides] - RenderInput overrides.
   * @returns {object} RenderInput.
   */
  function sessionInput(overrides = {}) {
    return {
      mode: 'session',
      doc: smallDoc(),
      sinceStart: { states: {}, removedJourneys: [], removedSteps: [] },
      sinceLast: { states: {}, removedJourneys: [], removedSteps: [] },
      plannedKeys: new Set(),
      conflicts: [],
      anchors: {},
      flags: {},
      banners: [],
      chips: [],
      ...overrides,
    };
  }

  it('shows removed journeys in their area and removed steps in their journey', () => {
    const removedJourney = journey('wishlist', 'buy', [step('heart', ['list']), step('list')]);
    const vm = buildViewModel(sessionInput({
      sinceStart: {
        states: { 'j:login': 'changed' },
        removedJourneys: [removedJourney],
        removedSteps: [{ journeyId: 'login', step: step('remember', ['form']) }],
      },
    }));
    const buy = vm.root.children.find((area) => area.id === 'buy');
    assert.deepEqual(buy.children.map((j) => [j.id, j.state]), [['checkout', 'stable'], ['wishlist', 'removed']]);
    assert.deepEqual(vm.journeys.wishlist.children.map((s) => s.state), ['removed', 'removed']);
    const login = vm.journeys.login;
    assert.deepEqual(login.children.map((s) => [s.id, s.state]), [['login/form', 'stable'], ['login/remember', 'removed']]);
    assert.deepEqual(login.edges, [['login/remember', 'login/form']]);
    assert.equal(login.state, 'changed');
    assert.equal(vm.journeys.wishlist.rollup, 'changed');
    assert.equal(buy.rollup, 'changed');
  });

  it('propagates a deep step change up to its journey, area and the app', () => {
    const vm = buildViewModel(sessionInput({ sinceStart: { states: { 's:login/form': 'new' }, removedJourneys: [], removedSteps: [] } }));
    const acct = vm.root.children.find((area) => area.id === 'acct');
    assert.equal(stepNode(vm, 'login/form').rollup, 'new');
    assert.equal(vm.journeys.login.state, 'stable');
    assert.equal(vm.journeys.login.rollup, 'new');
    assert.equal(acct.rollup, 'new');
    assert.equal(vm.root.rollup, 'new');
    assert.equal(vm.root.children.find((area) => area.id === 'buy').rollup, 'stable');
  });

  it('propagates a change inside a sub-flow through the step that opens it', () => {
    const vm = buildViewModel(sessionInput({ sinceStart: { states: { 's:card/bank': 'changed' }, removedJourneys: [], removedSteps: [] } }));
    assert.equal(vm.journeys.card.rollup, 'changed');
    assert.equal(stepNode(vm, 'checkout/pay').state, 'stable');
    assert.equal(stepNode(vm, 'checkout/pay').rollup, 'changed');
    assert.equal(vm.journeys.checkout.rollup, 'changed');
    assert.equal(vm.root.rollup, 'changed');
  });

  it('survives sub-flows that open each other', () => {
    const doc = smallDoc();
    doc.journeys[3].steps[1].subflow = 'checkout';
    const vm = buildViewModel(sessionInput({ doc, sinceStart: { states: { 's:card/enter': 'new' }, removedJourneys: [], removedSteps: [] } }));
    assert.equal(vm.journeys.card.rollup, 'new');
    assert.equal(vm.journeys.checkout.rollup, 'new');
  });

  it('ranks rollups conflict > changed > new > broken > stable', () => {
    const vm = buildViewModel(sessionInput({
      sinceStart: { states: { 's:checkout/cart': 'new', 's:checkout/done': 'changed' }, removedJourneys: [], removedSteps: [] },
      anchors: { 's:login/form': 'broken', 's:checkout/pay': 'broken' },
      conflicts: [{ screen: '/form', planJourney: 'loose', otherJourneys: ['login'], kind: 'touches' }],
    }));
    assert.equal(stepNode(vm, 'checkout/pay').rollup, 'broken');
    assert.equal(vm.journeys.checkout.rollup, 'changed');
    assert.equal(stepNode(vm, 'login/form').rollup, 'conflict');
    assert.equal(vm.journeys.login.rollup, 'conflict');
    assert.equal(vm.root.rollup, 'conflict');
  });

  it('sets latest, planned, anchors and flags from the inputs', () => {
    const vm = buildViewModel(sessionInput({
      sinceStart: { states: { 'j:checkout': 'changed', 's:checkout/cart': 'changed' }, removedJourneys: [], removedSteps: [] },
      sinceLast: { states: { 's:checkout/cart': 'changed', 's:checkout/done': 'stable' }, removedJourneys: [], removedSteps: [] },
      plannedKeys: new Set(['s:checkout/done']),
      anchors: { 's:checkout/cart': 'unverified', 's:checkout/pay': 'ok', 's:checkout/done': 'bogus' },
      flags: { 'j:checkout': ['two-chats', 'not-a-flag'], 's:checkout/cart': ['unconfirmed', 'unconfirmed'] },
    }));
    const cart = stepNode(vm, 'checkout/cart');
    assert.equal(cart.latest, true);
    assert.equal(stepNode(vm, 'checkout/done').latest, false);
    assert.equal(stepNode(vm, 'checkout/done').planned, true);
    assert.equal(cart.planned, false);
    assert.equal(cart.anchor, 'unverified');
    assert.equal(stepNode(vm, 'checkout/pay').anchor, 'ok');
    assert.equal('anchor' in stepNode(vm, 'checkout/done'), false);
    assert.deepEqual(vm.journeys.checkout.flags, ['two-chats']);
    assert.deepEqual(cart.flags, ['unconfirmed']);
    assert.equal(stepNode(vm, 'login/form').state, 'stable');
  });

  it('marks a removed journey as latest when it was removed in the latest turn', () => {
    const removed = journey('gone', 'acct', [step('x')]);
    const vm = buildViewModel(sessionInput({
      sinceStart: { states: {}, removedJourneys: [removed], removedSteps: [] },
      sinceLast: { states: {}, removedJourneys: [removed], removedSteps: [] },
    }));
    assert.equal(vm.journeys.gone.latest, true);
    assert.equal(vm.journeys.gone.children[0].latest, true);
  });

  it('flags the plan journey, the other journeys and the steps on the conflict screen', () => {
    const doc = smallDoc();
    doc.journeys[2].steps.push(step('cart'));
    const vm = buildViewModel(sessionInput({
      doc,
      conflicts: [{ screen: '/cart', planJourney: 'loose', otherJourneys: ['checkout'], kind: 'change' }],
    }));
    assert.deepEqual(vm.journeys.loose.flags, ['conflict']);
    assert.deepEqual(vm.journeys.checkout.flags, ['conflict']);
    assert.deepEqual(stepNode(vm, 'loose/cart').flags, ['conflict']);
    assert.deepEqual(stepNode(vm, 'checkout/cart').flags, ['conflict']);
    assert.deepEqual(stepNode(vm, 'checkout/pay').flags, []);
    assert.deepEqual(vm.journeys.login.flags, []);
    assert.equal(vm.root.children.find((area) => area.id === 'buy').rollup, 'conflict');
  });

  it('carries banners, chips, plan summary and approval', () => {
    const vm = buildViewModel(sessionInput({ banners: ['Planned, not built yet: X'], chips: ['Share link out of date'], planSummary: 'Add X', approval: 'pending' }));
    assert.deepEqual(vm.banners, ['Planned, not built yet: X']);
    assert.deepEqual(vm.chips, ['Share link out of date']);
    assert.equal(vm.planSummary, 'Add X');
    assert.equal(vm.approval, 'pending');
  });

  it('treats a missing diff as all stable', () => {
    const vm = buildViewModel({ mode: 'session', doc: smallDoc() });
    assert.ok(allNodes(vm.root).every((node) => node.state === 'stable' && node.rollup === 'stable' && !node.latest));
  });
});

describe('buildViewModel: canonical mode', () => {
  it('strips every bit of session state', () => {
    const removed = journey('wishlist', 'buy', [step('heart')]);
    const vm = buildViewModel({
      mode: 'canonical',
      doc: smallDoc(),
      sinceStart: { states: { 'j:checkout': 'changed', 's:checkout/cart': 'new' }, removedJourneys: [removed], removedSteps: [{ journeyId: 'login', step: step('gone') }] },
      sinceLast: { states: { 'j:checkout': 'changed' }, removedJourneys: [], removedSteps: [] },
      plannedKeys: new Set(['j:checkout']),
      conflicts: [{ screen: '/cart', planJourney: 'checkout', otherJourneys: ['login'], kind: 'change' }],
      anchors: { 's:checkout/cart': 'broken' },
      flags: { 'j:checkout': ['unconfirmed'] },
      banners: ['banner'],
      chips: ['chip'],
      planSummary: 'plan',
      approval: 'pending',
    });
    const nodes = [...allNodes(vm.root), ...Object.values(vm.journeys).flatMap(allNodes)];
    for (const node of nodes) {
      assert.equal(node.state, 'stable', node.id);
      assert.equal(node.latest, false, node.id);
      assert.equal(node.planned, false, node.id);
      assert.deepEqual(node.flags, [], node.id);
      assert.equal(node.rollup, 'stable', node.id);
      assert.equal('anchor' in node, false, node.id);
    }
    assert.equal(vm.journeys.wishlist, undefined);
    assert.equal(stepNode(vm, 'login/form') !== undefined, true);
    assert.equal(vm.journeys.login.children.length, 1);
    assert.deepEqual(vm.banners, []);
    assert.deepEqual(vm.chips, []);
    assert.equal('planSummary' in vm, false);
    assert.equal('approval' in vm, false);
  });
});

describe('escapeJsonForHtml', () => {
  it('escapes <, >, &, U+2028 and U+2029 and still round-trips', () => {
    const value = { a: '</script><!-- & -->', b: 'line\u2028sep\u2029end' };
    const out = escapeJsonForHtml(value);
    assert.doesNotMatch(out, /[<>&\u2028\u2029]/);
    assert.ok(out.includes('\\u003c/script\\u003e'));
    assert.ok(out.includes('\\u0026'));
    assert.ok(out.includes('\\u2028') && out.includes('\\u2029'));
    assert.deepEqual(JSON.parse(out), value);
  });

  it('returns null for undefined', () => {
    assert.equal(escapeJsonForHtml(undefined), 'null');
  });
});

describe('renderHtml', () => {
  const HOSTILE = '</script><img src=x onerror=alert(1)>';

  it('names the page after the app, escaped', () => {
    const titleOf = (app) => renderHtml(buildViewModel({ mode: 'canonical', doc: { version: 1, app, journeys: [] } })).match(/<title>([^<]*)<\/title>/)[1];
    assert.equal(titleOf('PineChat'), 'PineChat · Journey map');
    assert.equal(titleOf(''), 'Journey map');
    assert.equal(titleOf('A & B <x>'), 'A &amp; B &lt;x&gt; · Journey map');
  });

  /**
   * Pulls the embedded JSON back out of rendered HTML.
   *
   * @param {string} html - Rendered page.
   * @returns {unknown} Parsed view model.
   */
  function embedded(html) {
    const match = html.match(/<script type="application\/json" id="jm-data">([\s\S]*?)<\/script>/);
    assert.ok(match, 'jm-data script present');
    return JSON.parse(match[1]);
  }

  it('embeds hostile labels without breaking out of the data script', () => {
    const doc = smallDoc();
    doc.app = HOSTILE;
    doc.journeys[0].title = HOSTILE;
    doc.journeys[0].steps[0].say = HOSTILE;
    const vm = buildViewModel({ mode: 'canonical', doc });
    const html = renderHtml(vm, { templatePath: TEMPLATE_PATH });
    assert.ok(!html.includes('</script><img'));
    assert.ok(!html.includes('<img src=x'));
    assert.deepEqual(embedded(html), vm);
  });

  it('is deterministic and replaces only the data slot and the title', () => {
    const vm = buildViewModel({ mode: 'canonical', doc: SAMPLE });
    const a = renderHtml(vm, { templatePath: TEMPLATE_PATH });
    const b = renderHtml(buildViewModel({ mode: 'canonical', doc: SAMPLE }), { templatePath: TEMPLATE_PATH });
    assert.equal(a, b);
    const template = readFileSync(TEMPLATE_PATH, 'utf8');
    const normalised = a
      .replace(/(id="jm-data">)[\s\S]*?(<\/script>)/, '$1null$2')
      .replace(/<title>[^<]*<\/title>/, '<title>Journey map</title>');
    assert.equal(normalised, template);
  });

  it('does not expand $ patterns in the data', () => {
    const doc = smallDoc();
    doc.app = "$& $' $` $1";
    const vm = buildViewModel({ mode: 'canonical', doc });
    assert.equal(embedded(renderHtml(vm)).app, "$& $' $` $1");
  });

  it('throws when the template has no data slot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-render-'));
    const path = join(dir, 'bad.html');
    writeFileSync(path, '<html><body>no slot</body></html>');
    assert.throws(() => renderHtml(buildViewModel({ mode: 'canonical', doc: smallDoc() }), { templatePath: path }), /jm-data/);
  });
});

describe('viewModelHash', () => {
  it('is a stable sha1 that ignores key order and changes with content', () => {
    const vm = buildViewModel({ mode: 'canonical', doc: SAMPLE });
    const hash = viewModelHash(vm);
    assert.match(hash, /^[0-9a-f]{40}$/);
    assert.equal(viewModelHash(buildViewModel({ mode: 'canonical', doc: SAMPLE })), hash);
    const reordered = Object.fromEntries(Object.entries(vm).reverse());
    assert.equal(viewModelHash(reordered), hash);
    const changed = structuredClone(SAMPLE);
    changed.journeys[0].title = 'Something else';
    assert.notEqual(viewModelHash(buildViewModel({ mode: 'canonical', doc: changed })), hash);
  });
});

describe('templates/journeys.html', () => {
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  const script = template.slice(template.lastIndexOf('<script>'));

  it('never uses innerHTML or other HTML-string sinks', () => {
    assert.ok(!template.includes('innerHTML'));
    assert.ok(!template.includes('outerHTML'));
    assert.ok(!template.includes('insertAdjacentHTML'));
    assert.ok(!template.includes('document.write'));
  });

  it('makes no external requests', () => {
    assert.doesNotMatch(template, /https?:\/\//);
    assert.doesNotMatch(template, /<link\b/i);
    assert.doesNotMatch(template, /\bsrc\s*=/i);
    assert.doesNotMatch(template, /@import/);
    assert.doesNotMatch(template, /url\((?!#)/);
    assert.doesNotMatch(script, /\bfetch\(|XMLHttpRequest|import\(/);
  });

  it('reads its data from the jm-data script', () => {
    assert.ok(template.includes('<script type="application/json" id="jm-data">null</script>'));
    assert.ok(template.includes("JSON.parse(document.getElementById('jm-data').textContent)"));
  });

  it('draws grid levels from the view model flag and routes areas at any depth', () => {
    assert.ok(script.includes("layoutOf(node) === 'grid'"));
    assert.ok(script.includes('node.layouts[appFilter]'));
    assert.ok(script.includes("seg.t === 'a' && (node.kind === 'app' || node.kind === 'area')"));
    assert.ok(script.includes("'class': 'tile ' + nodeClass(node), tabindex: '0', role: 'button'"));
  });

  it('has a labelled zoom bar, a described canvas and the gesture hint in the footer', () => {
    for (const [id, label] of [['jm-zoom-out', 'Zoom out'], ['jm-zoom-in', 'Zoom in'], ['jm-zoom-fit', 'Fit to screen']]) {
      assert.match(template, new RegExp(`<button id="${id}" [^>]*type="button" aria-label="${label}"`));
    }
    assert.match(template, /<output id="jm-zoom-level" aria-label="Zoom level">/);
    assert.match(template, /role="toolbar" aria-label="Zoom"/);
    assert.match(template, /id="jm-view"[^>]*aria-description="[^"]*Command or Control and scroll[^"]*"/);
    assert.ok(template.includes('Drag or scroll to move · ⌘/Ctrl + scroll or pinch to zoom · double-click to open'));
    assert.match(template, /\.zoombar button \{[^}]*width: 32px; height: 32px;/);
  });

  it('pans and zooms one world container with pointer events, wheel and keys', () => {
    assert.ok(script.includes("addEventListener('wheel'"));
    assert.ok(script.includes('{ passive: false }'));
    assert.ok(script.includes('setPointerCapture'));
    assert.ok(script.includes("addEventListener('pointerdown'"));
    assert.ok(script.includes("event.key === '+' || event.key === '='"));
    assert.equal((script.match(/function isMouseWheel\(/g) ?? []).length, 1);
    assert.ok(script.includes('event.ctrlKey || event.metaKey || mouse'));
    assert.ok(script.includes("c.world.style.transform = 'translate("));
    assert.ok(script.includes('reducedMotion()'));
  });

  it('shows step labels on boxes and the full sentence on hover and in the card', () => {
    assert.ok(script.includes("node.kind === 'step' ? [node.say || node.title] : [node.title]"));
    assert.ok(script.includes('var BW = stepBoxWidth(steps)'));
    assert.ok(script.includes("h('p', { 'class': 'card-say' }, txt(step.say))"));
    assert.ok(script.includes("(node.derivedLabel ? ' derived' : '')"));
  });

  it('has an app filter in the header and app tags, with the filter kept in the hash', () => {
    assert.match(template, /<div id="jm-apps" class="appfilter" role="group" aria-label="Show journeys in" hidden><\/div>/);
    assert.ok(script.includes("'aria-pressed': 'false'"));
    assert.ok(script.includes("var prefix = /^app=([^/]*)/.exec(raw);"));
    assert.ok(script.includes("'#' + (app ? 'app=' + encodeURIComponent(app) : '') + '/'"));
    assert.ok(script.includes("'class': 'appbadge ak-' + kindOf(app)"));
    for (const kind of ['web', 'desktop', 'mobile', 'server', 'agent']) assert.ok(template.includes(`.ak-${kind} {`));
  });

  it('draws decisions, outcomes, conditions and chips, and has a findings layer', () => {
    assert.ok(script.includes("if (step.stepKind === 'decision') {"));
    assert.ok(script.includes("'class': 'res-badge res-' + res"));
    assert.ok(script.includes('function drawConditions(layer, placed, edge, mid, maxW)'));
    assert.ok(script.includes("cls: 'chip-continue'"));
    assert.ok(script.includes("icon: 'clock'"));
    assert.match(template, /<button id="jm-findings-toggle" class="ftoggle" type="button" aria-pressed="false" aria-controls="jm-findings" hidden><\/button>/);
    assert.match(template, /<aside id="jm-findings" class="fpanel" aria-label="Findings" hidden>/);
    assert.match(template, /<button id="jm-findings-close" class="fpanel-close" type="button" aria-label="Hide findings">/);
    assert.ok(script.includes("h('p', { 'class': 'fmsg' }, txt(finding.message))"));
  });

  it('has the empty-state message, focusable nodes and reduced-motion support', () => {
    assert.ok(template.includes('No journeys mapped yet. In Claude Code, run /chefs-table:map-app to draw your whole app.'));
    assert.ok(script.includes("tabindex: '0', role: 'button', 'aria-label'"));
    assert.ok(template.includes('prefers-reduced-motion'));
    assert.ok(template.includes('prefers-color-scheme: dark'));
  });
});
