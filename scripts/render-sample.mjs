#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildViewModel, renderHtml } from '../lib/render.mjs';

const FIXTURE = fileURLToPath(new URL('../fixtures/sample-journeys.json', import.meta.url));
const OUTPUT = fileURLToPath(new URL('../docs/sample.html', import.meta.url));

const PLANNED_JOURNEY = {
  id: 'gift-subscription',
  title: 'Gift a flower subscription',
  area: 'shop',
  who: 'Customer',
  steps: [
    {
      id: 'choose-plan',
      say: 'Picks 3, 6 or 12 months of flowers',
      label: 'Pick a plan length',
      screen: '/gifts/subscribe',
      anchor: { type: 'route', value: '/gifts/subscribe' },
      next: ['recipient'],
      detail: { sees: 'Three plans with a monthly price.', does: 'Chooses how many months to give.', saves: ['Subscription draft'] },
    },
    {
      id: 'recipient',
      say: 'Adds who the flowers are for',
      label: 'Add the recipient',
      screen: '/gifts/subscribe/recipient',
      anchor: { type: 'route', value: '/gifts/subscribe/recipient' },
      next: ['cart'],
      detail: { does: 'Enters the name, address and a first-month message.', saves: ['Recipient'] },
    },
    {
      id: 'cart',
      say: 'Reviews the subscription in the basket',
      label: 'Review the subscription',
      screen: '/cart',
      anchor: { type: 'route', value: '/cart' },
      next: ['pay'],
      detail: { rules: ['A subscription and a one-off bouquet can share one basket'], files: ['src/app/cart/page.tsx'] },
    },
    {
      id: 'pay',
      say: 'Pays for the whole subscription up front',
      label: 'Pay up front',
      screen: '/checkout/pay',
      anchor: { type: 'route', value: '/checkout/pay' },
      next: [],
      subflow: 'card-payment',
    },
  ],
};

const REMOVED_JOURNEY = {
  id: 'wishlist',
  title: 'Save bouquets for later',
  area: 'shop',
  who: 'Customer',
  steps: [
    { id: 'heart', say: 'Taps the heart on a bouquet', label: 'Save a bouquet', screen: '/bouquets/[slug]', anchor: { type: 'route', value: '/bouquets/[slug]' }, next: ['list'] },
    { id: 'list', say: 'Sees their saved bouquets', label: 'See saved bouquets', screen: '/account/wishlist', anchor: { type: 'route', value: '/account/wishlist' }, next: [] },
  ],
};

const REMOVED_STEP = {
  journeyId: 'sign-in',
  step: { id: 'remember-me', say: 'Ticks "Remember me"', label: 'Tick Remember me', screen: '/sign-in', anchor: { type: 'route', value: '/sign-in' }, next: ['account'] },
};

const WALLET_STEP = {
  id: 'wallet',
  say: 'Or pays with Apple Pay or Google Pay',
  label: 'Pay with a phone wallet',
  screen: '/checkout/pay',
  anchor: { type: 'file', value: 'src/components/WalletButton.tsx' },
  next: ['result'],
  detail: { does: 'Taps the wallet button and confirms on their phone.', files: ['src/components/WalletButton.tsx'] },
};

/**
 * Builds the session document: the sample map with a wallet step added to card payment
 * and the pending plan (gift subscriptions) applied for the overlay.
 *
 * @param {object} base - The sample JourneysDoc.
 * @returns {object} The session JourneysDoc.
 */
function sessionDoc(base) {
  const doc = structuredClone(base);
  const cardPayment = doc.journeys.find((journey) => journey.id === 'card-payment');
  cardPayment.steps.splice(1, 0, WALLET_STEP);
  const checkoutIndex = doc.journeys.findIndex((journey) => journey.id === 'checkout');
  doc.journeys.splice(checkoutIndex + 1, 0, structuredClone(PLANNED_JOURNEY));
  return doc;
}

/**
 * Keys of a journey and all its steps.
 *
 * @param {{ id: string, steps: Array<{ id: string }> }} journey - The journey.
 * @returns {string[]} "j:" and "s:" keys.
 */
function keysOf(journey) {
  return [`j:${journey.id}`, ...journey.steps.map((step) => `s:${journey.id}/${step.id}`)];
}

/**
 * Anchor state for every step: 'ok' unless overridden.
 *
 * @param {object} doc - JourneysDoc.
 * @param {Record<string, string>} overrides - Anchor states by step key.
 * @returns {Record<string, string>} Anchor states by step key.
 */
function anchorsFor(doc, overrides) {
  const anchors = {};
  for (const journey of doc.journeys) for (const step of journey.steps) anchors[`s:${journey.id}/${step.id}`] = 'ok';
  return { ...anchors, ...overrides };
}

const base = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const doc = sessionDoc(base);
const plannedKeys = keysOf(PLANNED_JOURNEY);

const vm = buildViewModel({
  mode: 'session',
  doc,
  sinceStart: {
    states: {
      ...Object.fromEntries(plannedKeys.map((key) => [key, 'new'])),
      'j:checkout': 'changed',
      's:checkout/delivery': 'changed',
      's:checkout/gift-note': 'new',
      'j:card-payment': 'changed',
      's:card-payment/wallet': 'new',
      'j:sign-in': 'changed',
      'j:add-bouquet': 'changed',
      's:add-bouquet/photos': 'changed',
      'j:sold-out': 'new',
      's:sold-out/find': 'new',
      's:sold-out/toggle': 'new',
    },
    removedJourneys: [REMOVED_JOURNEY],
    removedSteps: [REMOVED_STEP],
  },
  sinceLast: {
    states: {
      ...Object.fromEntries(plannedKeys.map((key) => [key, 'new'])),
      'j:checkout': 'changed',
      's:checkout/gift-note': 'new',
    },
    removedJourneys: [],
    removedSteps: [],
  },
  plannedKeys: new Set(plannedKeys),
  conflicts: [{ screen: '/cart', planJourney: 'gift-subscription', otherJourneys: ['checkout', 'track-order'], kind: 'touches' }],
  anchors: anchorsFor(doc, {
    's:sign-up/verify-email': 'broken',
    's:add-bouquet/photos': 'unverified',
    ...Object.fromEntries(plannedKeys.slice(1).map((key) => [key, 'unverified'])),
  }),
  flags: { 's:checkout/gift-note': ['unconfirmed'], 'j:fulfil-orders': ['two-chats'] },
  banners: [],
  chips: ['Share link out of date'],
  planSummary: 'Add monthly flower subscriptions that people can buy as a gift',
  approval: 'pending',
});

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, renderHtml(vm));
console.log(`Wrote ${OUTPUT}`);
