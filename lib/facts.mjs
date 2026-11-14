/**
 * Facts scan: turns each JS/TS file into a short summary (what is on screen, what each button does, where links go,
 * which data it calls, when parts show) so map helpers read a few hundred tokens per file instead of the whole file.
 *
 * It parses with the TypeScript compiler that the project itself has installed; Chef's Table ships no parser. Without
 * one (or with CHEFS_TABLE_FACTS=off) nothing changes: helpers read the files as before. Map runs only; hooks never load it.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeText, shortenText } from './model.mjs';

/** @typedef {import('./types.mjs').Inventory} Inventory */
/** @typedef {import('./types.mjs').InventoryItem} InventoryItem */

/**
 * @typedef {object} FileFacts
 * @property {string} sheet                The summary, a few lines of plain text.
 * @property {string|null} readFull        Why the helper should read the whole file anyway, or null.
 * @property {Array<{ line: number, label: string }>} actions  Buttons, links and menu items with the words on them.
 */

/**
 * @typedef {object} FactsScan
 * @property {Record<string, string>} sheets  Summary per repo-relative file.
 * @property {Record<string, { facts: number, readFull?: string }>} files  Summary size in bytes (and why to read in full).
 * @property {InventoryItem[]} actions     'action' items: one per labelled button, link or menu item.
 */

const CODE_FILE = /\.[cm]?[jt]sx?$/;
const TS_ONLY = /\.[cm]?ts$/;
const TEXT_ATTRS = /^(label|title|placeholder|aria-label|alt|helperText|tooltip|description|subtitle|subheader|primary|secondary|confirmText|cancelText|text|heading|emptyText|message|caption|cta)$/;
const TEXT_KEYS = /^(label|title|description|heading|subtitle|placeholder|text|cta|caption|tooltip|helperText|emptyText|message|name)$/;
const NAV_KEYS = /^(path|href|to|route|url)$/;
const ACTION_ATTRS = /^on(Click|Press|Select|Submit|Confirm)$/;
const ACTION_KEYS = /^(onClick|onSelect|onPress|action|handler)$/;
const NAV_CALL = /^(navigate|router\.(push|replace)|history\.(push|replace)|window\.location\.(assign|replace)|redirect)$/;
const MESSAGE_CALL = /(^|\.)(set\w*(Text|Error|Message|Notice)|toast(\.\w+)?|alert|confirm|notify|enqueueSnackbar|showMessage)$/i;
const HTTP_CALL = /(^fetch$|\.(get|post|put|patch|delete)$)/;
const DATA_MODULE = /(^|\/)(api|apis|services?|clients?|queries|mutations|actions|server|trpc|graphql)(\/|$)|\.api$/;
const HANDLER_NAME = /^(handle|on)[A-Z]/;
const MAX_PER_LIST = 30;
const MAX_ENTRY = 80;

const LISTS = [
  ['defines', 'defines'],
  ['text', 'on screen'],
  ['messages', 'messages'],
  ['buttons', 'buttons'],
  ['handlers', 'handlers'],
  ['handles', 'handles'],
  ['nav', 'goes to'],
  ['calls', 'calls'],
  ['changes', 'changes'],
  ['lists', 'lists'],
  ['when', 'only when'],
  ['uses', 'uses'],
];

/**
 * Loads the TypeScript compiler the project has installed, so Chef's Table can parse code without shipping a parser.
 *
 * Looks in CHEFS_TABLE_TYPESCRIPT (a path) first, then resolves "typescript" from each root. Loading it runs that
 * package's code, the same code the project's own build runs.
 *
 * @param {string[]} roots - Absolute folders to resolve from (the project, then each app's folder).
 * @param {NodeJS.ProcessEnv} [env] - Environment (CHEFS_TABLE_FACTS=off turns the scan off).
 * @returns {object|null} The compiler module, or null when there is none or it is turned off.
 */
export function loadTypeScript(roots, env = process.env) {
  if (env.CHEFS_TABLE_FACTS === 'off') return null;
  const tries = [env.CHEFS_TABLE_TYPESCRIPT, ...roots.map((root) => ['typescript', root])].filter(Boolean);
  for (const attempt of tries) {
    try {
      const [name, root] = Array.isArray(attempt) ? attempt : [attempt, process.cwd()];
      const ts = createRequire(join(root, 'package.json'))(name);
      if (typeof ts?.createSourceFile === 'function' && typeof ts.forEachChild === 'function') return ts;
    } catch {
      // Not installed there; try the next place.
    }
  }
  return null;
}

/**
 * Cleans one piece of text from the code for a brief: no control characters, one line, at most MAX_ENTRY characters.
 *
 * @param {string} text - Raw text.
 * @returns {string} The cleaned text ('' when nothing is left).
 */
function clean(text) {
  return shortenText(sanitizeText(String(text).replace(/\s+/g, ' ')), MAX_ENTRY);
}

/**
 * The string inside a string literal, or null for any other node.
 *
 * @param {object} ts - The compiler.
 * @param {object|undefined} node - A node.
 * @returns {string|null} The literal's text.
 */
function literal(ts, node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

/**
 * The words a person sees on an element: its text children, else its label-like attributes.
 *
 * @param {object} ts - The compiler.
 * @param {object} element - A JsxElement or JsxSelfClosingElement.
 * @param {object} sf - The source file.
 * @returns {string} The words, cleaned ('' when there are none).
 */
function visibleWords(ts, element, sf) {
  const parts = [];
  const collect = (node) => {
    if (ts.isJsxText(node)) parts.push(node.text.trim());
    else if (ts.isJsxExpression(node) && literal(ts, node.expression)) parts.push(literal(ts, node.expression));
    ts.forEachChild(node, collect);
  };
  if (ts.isJsxElement(element)) element.children.forEach(collect);
  const words = clean(parts.filter(Boolean).join(' '));
  if (words) return words;
  const attrs = (ts.isJsxElement(element) ? element.openingElement : element).attributes.properties;
  for (const attr of attrs) {
    if (ts.isJsxAttribute(attr) && /^(label|title|aria-label|text)$/.test(attr.name.getText(sf))) {
      const value = literal(ts, attr.initializer) ?? (attr.initializer && ts.isJsxExpression(attr.initializer) ? literal(ts, attr.initializer.expression) : null);
      if (value) return clean(value);
    }
  }
  return '';
}

/**
 * Reads one file's summary with the TypeScript compiler.
 *
 * @param {object} ts - The compiler from loadTypeScript.
 * @param {string} file - Repo-relative path (decides JSX or not).
 * @param {string} text - The file's contents.
 * @returns {FileFacts|null} The facts, or null for files that are not JS/TS.
 */
export function factsOf(ts, file, text) {
  if (!CODE_FILE.test(file)) return null;
  const kind = TS_ONLY.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.TSX;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const lists = Object.fromEntries(LISTS.map(([key]) => [key, new Set()]));
  const setters = new Map();
  const dataNames = new Set();
  const actions = [];
  let reducer = false;
  const add = (key, value) => {
    const cleaned = clean(value);
    if (cleaned) lists[key].add(cleaned);
  };
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const textOf = (node) => node.getText(sf);

  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !DATA_MODULE.test(literal(ts, statement.moduleSpecifier) ?? '')) continue;
    const { name, namedBindings } = statement.importClause;
    if (name) dataNames.add(name.text);
    if (namedBindings && ts.isNamedImports(namedBindings)) namedBindings.elements.forEach((element) => dataNames.add(element.name.text));
  }

  const clickable = (node, attrs) => {
    for (const attr of attrs) {
      if (!ts.isJsxAttribute(attr) || !attr.initializer) continue;
      const name = attr.name.getText(sf);
      if (!ACTION_ATTRS.test(name) && !/^(to|href)$/.test(name)) continue;
      const label = visibleWords(ts, node, sf);
      if (!label) return;
      const target = ts.isJsxExpression(attr.initializer) ? textOf(attr.initializer.expression ?? attr.initializer) : textOf(attr.initializer);
      actions.push({ line: lineOf(node), label });
      add('buttons', `"${label}" → ${shortenText(target.replace(/\s+/g, ' '), 40)}`);
      return;
    }
  };

  const walk = (node) => {
    if (ts.isJsxText(node)) {
      if (node.text.trim()) add('text', node.text);
    } else if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = textOf(opening.tagName);
      if (/^[A-Z]/.test(tag)) lists.uses.add(tag);
      clickable(node, opening.attributes.properties);
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      const value = literal(ts, node.initializer) ?? (ts.isJsxExpression(node.initializer) ? literal(ts, node.initializer.expression) : null);
      if (TEXT_ATTRS.test(name) && value) add('text', value);
      if (/^on[A-Z]/.test(name) && ts.isJsxExpression(node.initializer) && node.initializer.expression) add('handlers', `${name}: ${shortenText(textOf(node.initializer.expression).replace(/\s+/g, ' '), 50)}`);
      if (/^(to|href)$/.test(name)) add('nav', value ?? textOf(node.initializer).replace(/^\{|\}$/g, ''));
    } else if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      const key = node.name.text;
      const value = literal(ts, node.initializer);
      if (/^on[A-Z]/.test(key) && (ts.isArrowFunction(node.initializer) || ts.isIdentifier(node.initializer))) add('handlers', `${key}: ${shortenText(textOf(node.initializer).replace(/\s+/g, ' '), 50)}`);
      if (value && TEXT_KEYS.test(key) && /[A-Za-z]{2}/.test(value)) add('text', value);
      if (value && NAV_KEYS.test(key) && value.startsWith('/')) add('nav', value);
    } else if (ts.isObjectLiteralExpression(node)) {
      const props = new Map(node.properties.filter((prop) => ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)).map((prop) => [prop.name.text, prop.initializer]));
      const label = [...props].find(([key, value]) => /^(label|title|text)$/.test(key) && literal(ts, value))?.[1];
      if (label && [...props.keys()].some((key) => ACTION_KEYS.test(key))) {
        actions.push({ line: lineOf(node), label: clean(literal(ts, label)) });
        add('buttons', `"${literal(ts, label)}" (menu item)`);
      }
    } else if (ts.isCallExpression(node)) {
      const callee = textOf(node.expression).replace(/\s+/g, '');
      const first = literal(ts, node.arguments[0]);
      if (NAV_CALL.test(callee)) add('nav', node.arguments.map(textOf).join(', '));
      if (dataNames.has(callee.split('.')[0])) add('calls', callee);
      if (HTTP_CALL.test(callee) && first && /^(\/|https?:)/.test(first)) add('calls', `${callee === 'fetch' ? 'fetch' : callee.split('.').at(-1).toUpperCase()} ${first}`);
      if (MESSAGE_CALL.test(callee)) node.arguments.forEach((arg) => { const message = literal(ts, arg); if (message) add('messages', message); });
      if (/^(t|i18n\.t|intl\.formatMessage)$/.test(callee) && first) add('text', `«${first}»`);
      if (/^use[A-Z]/.test(callee)) {
        if (!/^use(State|Effect|Memo|Callback|Ref|Context|LayoutEffect|Id|Transition|DeferredValue|ImperativeHandle|SyncExternalStore)$/.test(callee)) lists.uses.add(callee);
        if (callee === 'useReducer') reducer = true;
      }
      if (/^(createMachine|setup)$/.test(callee) || /^(createSlice)$/.test(callee)) reducer = true;
      const setter = !MESSAGE_CALL.test(callee) && callee.match(/^set([A-Z]\w*)$/);
      const arg = node.arguments[0];
      const remember = (state, value) => setters.set(state, new Set([...(setters.get(state) ?? []), value]));
      if (setter && arg && (first !== null || ts.isPropertyAccessExpression(arg))) remember(setter[1][0].toLowerCase() + setter[1].slice(1), first ?? textOf(arg));
      const binding = node.parent && ts.isVariableDeclaration(node.parent) && ts.isArrayBindingPattern(node.parent.name) ? node.parent.name.elements[0] : null;
      if (callee === 'useState' && first !== null && binding && ts.isBindingElement(binding) && ts.isIdentifier(binding.name)) remember(binding.name.text, first);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && node.parent && ts.isJsxExpression(node.parent)) {
      add('when', textOf(node.left));
    } else if (ts.isConditionalExpression(node) && node.parent && (ts.isJsxExpression(node.parent) || ts.isReturnStatement(node.parent))) {
      add('when', textOf(node.condition));
    } else if (ts.isIfStatement(node) && /\breturn\b/.test(textOf(node.thenStatement)) && textOf(node).length < 400) {
      add('when', `if ${textOf(node.expression)}`);
    } else if (ts.isSwitchStatement(node)) {
      const cases = node.caseBlock.clauses.filter((clause) => ts.isCaseClause(clause)).map((clause) => textOf(clause.expression));
      if (cases.length) add('when', `switch ${textOf(node.expression)}: ${cases.join(', ')}`);
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && node.parent === sf) {
      lists.defines.add(node.name.text);
    } else if (HANDLER_NAME.test(node.name?.text ?? '') && (ts.isFunctionDeclaration(node) || (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer) || ts.isCallExpression(node.initializer))))) {
      lists.handles.add(node.name.text);
    } else if (ts.isVariableStatement(node) && node.parent === sf) {
      for (const declaration of node.declarationList.declarations) {
        const init = declaration.initializer;
        if (ts.isIdentifier(declaration.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isCallExpression(init))) lists.defines.add(declaration.name.text);
        const array = init && ts.isAsExpression(init) ? init.expression : init;
        const words = array && ts.isArrayLiteralExpression(array) ? array.elements.map((element) => literal(ts, element)) : [];
        if (ts.isIdentifier(declaration.name) && words.length && words.every((word) => word !== null)) add('lists', `${declaration.name.text}: ${words.join(', ')}`);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  for (const [state, values] of setters) lists.changes.add(clean(`${state} → ${[...values].join(', ')}`));

  const lines = [`### ${file}`];
  for (const [key, label] of LISTS) {
    const values = [...lists[key]];
    if (!values.length) continue;
    const more = values.length > MAX_PER_LIST ? ` | … ${values.length - MAX_PER_LIST} more` : '';
    lines.push(`${label}: ${values.slice(0, MAX_PER_LIST).join(' | ')}${more}`);
  }
  const readFull = reducer ? 'its steps are decided by a reducer or state machine' : null;
  return { sheet: lines.join('\n'), readFull, actions: actions.filter((action) => action.label) };
}

/**
 * Scans every JS/TS file of an inventory. Files that fail to read or parse are left out, so helpers read them in full.
 *
 * @param {string} projectDir - Absolute project directory.
 * @param {Inventory} inventory - The code scan (its `files` are the files to summarise).
 * @param {object} ts - The compiler from loadTypeScript.
 * @returns {FactsScan} Summaries, their sizes and the labelled actions.
 */
export function buildFacts(projectDir, inventory, ts) {
  const sheets = {};
  const files = {};
  const actions = [];
  for (const file of Object.keys(inventory.files).sort()) {
    let facts;
    try {
      facts = factsOf(ts, file, readFileSync(join(projectDir, file), 'utf8').replace(/\r\n/g, '\n'));
    } catch {
      facts = null;
    }
    if (!facts) continue;
    sheets[file] = facts.sheet;
    files[file] = { facts: Buffer.byteLength(facts.sheet), ...(facts.readFull ? { readFull: facts.readFull } : {}) };
    const app = inventory.items.find((item) => item.file === file && item.app)?.app;
    for (const action of facts.actions) actions.push({ kind: 'action', ...(app ? { app } : {}), file, line: action.line, detail: action.label });
  }
  return { sheets, files, actions };
}

/**
 * Adds a facts scan to an inventory: each file gets its summary size (and why to read it in full), and the labelled
 * actions join the items. Items stay sorted by file, line, kind and detail.
 *
 * @param {Inventory} inventory - The code scan.
 * @param {FactsScan|null} scan - The facts scan, or null (returns the inventory unchanged).
 * @returns {Inventory} A new inventory.
 */
export function withFacts(inventory, scan) {
  if (!scan) return inventory;
  const files = Object.fromEntries(Object.entries(inventory.files).map(([file, entry]) => [file, scan.files[file] ? { ...entry, ...scan.files[file] } : entry]));
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const items = [...inventory.items.filter((item) => item.kind !== 'action'), ...scan.actions]
    .sort((a, b) => compare(a.file, b.file) || a.line - b.line || compare(a.kind, b.kind) || compare(a.detail, b.detail));
  return { ...inventory, files, items };
}

/**
 * How many tokens a helper reads for a file: its summary when it has one (and need not be read in full), else the file.
 *
 * @param {{ bytes: number, facts?: number, readFull?: string }|undefined} entry - The file's inventory entry.
 * @returns {number} Bytes to budget for.
 */
export function readBytes(entry) {
  if (!entry) return 0;
  return entry.facts !== undefined && !entry.readFull ? entry.facts : entry.bytes;
}

/**
 * Whether an inventory carries a facts scan.
 *
 * @param {Inventory} inventory - The code scan.
 * @returns {boolean} True when at least one file has a summary.
 */
export function hasFacts(inventory) {
  return Object.values(inventory?.files ?? {}).some((entry) => entry.facts !== undefined);
}
