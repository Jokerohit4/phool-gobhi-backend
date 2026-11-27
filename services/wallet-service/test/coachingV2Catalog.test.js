import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coachingCatalog, coachingCatalogV2 } from '../services/coachingCatalog.js';
import { defaultCoachingConfig, validateCoachingConfig } from '../services/coachingDefaults.js';
import { defaultCoachingV2Config } from '../services/coachingV2Config.js';

const expected = {
  MED_30: [500000, 30, 'medical', 'unlimited', 4, 'in_person', null, 'self_serve_72h'],
  MED_90: [1300000, 90, 'medical', 'unlimited', 12, 'in_person', null, 'self_serve_72h'],
  WELL_GYM: [200000, 30, 'wellness', 'unlimited', null, null, null, 'support'],
  WELL_TRAINER_WEEKLY: [300000, 30, 'wellness', null, 4, 'online', null, 'support'],
  WELL_TRAINER_BIWEEKLY: [500000, 30, 'wellness', null, 8, 'online', null, 'support'],
  WELL_TRAINER_ALLDAYS: [800000, 30, 'wellness', null, 16, 'online', null, 'support'],
  WELL_TRAINER_GYM: [1000000, 30, 'wellness', 'unlimited', 16, 'in_person', null, 'support'],
  WELL_TRAINER_GYM_NUTRI: [1200000, 30, 'wellness', 'unlimited', 16, 'in_person', 2, 'support'],
};

function assertOffers(catalog, remote) {
  const keys = Object.keys(expected).filter(key => !remote || expected[key][2] === 'medical' || !expected[key][3]);
  assert.deepEqual(catalog.offers.map(offer => offer.key), keys);
  for (const offer of catalog.offers) {
    const [amountPaise, durationDays, family, gym, sessions, mode, nutritionist, refundPolicy] = expected[offer.key];
    assert.equal(offer.amountPaise, amountPaise, offer.key);
    assert.equal(offer.durationDays, durationDays, offer.key);
    assert.equal(offer.family, family, offer.key);
    assert.equal(offer.refundPolicy, refundPolicy, offer.key);
    assert.deepEqual(offer.components, {
      gym: remote ? null : gym,
      trainer: sessions ? { sessions, mode: remote ? 'online' : mode } : null,
      nutritionist: nutritionist ? { sessions: nutritionist } : null,
      nutritionGuidance: true,
    }, offer.key);
    assert.match(offer.offerId, /^[a-f0-9]{64}$/);
  }
}

test('v2 defaults return every local price and component and resolve only remote-capable offers outside Gurugram', () => {
  const local = coachingCatalogV2(' Gurgaon '), remote = coachingCatalogV2('Mumbai');
  assert.equal(local.region, 'GURUGRAM');
  assert.equal(remote.region, 'REST_INDIA');
  assertOffers(local, false);
  assertOffers(remote, true);
  assert.deepEqual(local.addons.map(addon => [addon.key, addon.unitPaise]), [
    ['ADDON_GYM', 9900], ['ADDON_TRAINER', 50000], ['ADDON_NUTRITIONIST', 100000], ['ADDON_LAB_TEST', 100000],
  ]);
  assert.deepEqual(remote.addons.map(addon => addon.key), ['ADDON_TRAINER', 'ADDON_NUTRITIONIST']);
  assert.ok(local.addons.every(addon => addon.requiresActivePlan && /^[a-f0-9]{64}$/.test(addon.offerId)));
  assert.deepEqual(local.addons[3].families, ['medical']);
  assert.notEqual(local.offers[0].offerId, remote.offers[0].offerId);
});

test('v2 hashes are stable across JSON object key order and change on edits', () => {
  const config = defaultCoachingV2Config();
  const before = coachingCatalogV2('Gurugram', config);
  const reordered = JSON.parse(JSON.stringify(config), (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).reverse());
    return value;
  });
  assert.deepEqual(coachingCatalogV2('Gurugram', reordered), before);
  assert.deepEqual(coachingCatalogV2('Gurugram', validateCoachingConfig(config)), before);
  config.offers[0].amountPaise++;
  config.offers[1].enabled = false;
  config.addons[0].enabled = false;
  config.addons[1].volumeTiers[0].discountPct++;
  const after = coachingCatalogV2('Gurugram', config);
  assert.notEqual(after.offers[0].offerId, before.offers[0].offerId);
  assert.notEqual(after.addons[0].offerId, before.addons[1].offerId);
  assert.ok(!after.offers.some(offer => offer.key === 'MED_90'));
  assert.ok(!after.addons.some(offer => offer.key === 'ADDON_GYM'));
});

test('v1 configuration still serves the same catalog and falls back to v2 defaults', () => {
  const legacy = defaultCoachingConfig();
  const combined = { ...legacy, ...defaultCoachingV2Config() };
  for (const city of ['Gurugram', 'Mumbai']) {
    assert.deepEqual(coachingCatalog(city, combined), coachingCatalog(city, legacy));
    assert.deepEqual(coachingCatalogV2(city, legacy), coachingCatalogV2(city, combined));
  }
  assert.deepEqual(coachingCatalog('Gurugram', combined).plans.map(plan => plan.product), ['MONTHLY_4499', 'QUARTERLY_11999']);
  assert.equal(coachingCatalog('Gurugram', combined).addon.product, 'TRAINER_ADDON_1499');
});

test('config refuses ambiguous keys, unsupported regions, invalid components and invalid tiers', () => {
  const edits = [
    config => { config.addons[0].key = config.offers[0].key; },
    config => { config.offers[0].key = 'MONTHLY_4499'; },
    config => { delete config.offers[0].regionOverrides; },
    config => { config.offers[2].regions.push('REST_INDIA'); },
    config => { config.offers[0].components.trainer.sessions = -1; },
    config => { config.addons[0].requiresActivePlan = false; },
    config => { config.addons[3].families.push('wellness'); },
    config => { config.addons[1].volumeTiers.push({ minQty: 4, discountPct: 5 }); },
    config => { config.addons[1].volumeTierFamilies = ['invalid']; },
  ];
  for (const edit of edits) {
    const config = defaultCoachingV2Config();
    edit(config);
    assert.throws(() => validateCoachingConfig(config), { status: 400 });
  }
});
