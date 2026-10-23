import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildViewModel, escapeJsonForHtml, renderHtml, viewModelHash } from '../lib/render.mjs';
import { OTHER_AREA_ID } from '../lib/types.mjs';

const TEMPLATE_PATH = fileURLToPath(new URL('../templates/journeys.html', import.meta.url));
const SAMPLE = JSON.parse(readFileSync(new URL('./fixtures/sample-journeys.json', import.meta.url), 'utf8'));

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
    assert.deepEqual(vm.journeys['card-payment'].children.map((s) => s.depth), [0, 1, 2]);
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

  it('is deterministic and replaces only the data slot', () => {
    const vm = buildViewModel({ mode: 'canonical', doc: SAMPLE });
    const a = renderHtml(vm, { templatePath: TEMPLATE_PATH });
    const b = renderHtml(buildViewModel({ mode: 'canonical', doc: SAMPLE }), { templatePath: TEMPLATE_PATH });
    assert.equal(a, b);
    const template = readFileSync(TEMPLATE_PATH, 'utf8');
    assert.equal(a.replace(/(id="jm-data">)[\s\S]*?(<\/script>)/, '$1null$2'), template);
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

  it('has the empty-state message, focusable nodes and reduced-motion support', () => {
    assert.ok(template.includes('No journeys mapped yet. In Claude Code, run /chefs-table:map-app to draw your whole app.'));
    assert.ok(script.includes("tabindex: '0', role: 'button', 'aria-label'"));
    assert.ok(template.includes('prefers-reduced-motion'));
    assert.ok(template.includes('prefers-color-scheme: dark'));
  });
});
