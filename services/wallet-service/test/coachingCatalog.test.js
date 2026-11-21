import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { coachingCatalog, coachingOffer, coachingRegion, membershipBenefits } from '../services/coachingCatalog.js';

const keys = ['COACHING_REMOTE_MONTHLY_PRICE_PAISE', 'COACHING_REMOTE_QUARTERLY_PRICE_PAISE'];
const original = Object.fromEntries(keys.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of keys) { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; } });

test('Gurgaon is Gurugram, while other cities never inherit local prices or benefits', () => {
  assert.equal(coachingRegion(' GURGAON '), 'GURUGRAM');
  assert.equal(coachingRegion('New Delhi'), 'REST_INDIA');
  for (const city of [undefined, '', ' '.repeat(3), {}, 'a'.repeat(101)]) assert.throws(() => coachingRegion(city));
  const local = coachingCatalog('Gurugram');
  assert.deepEqual(local.plans.map(p => p.amountPaise), [449900, 1199900]);
  assert.equal(local.plans[1].labCredits, 2);
  assert.equal(local.plans[0].freeFormSessions, 2);
});
test('unannounced or invalid remote prices prevent checkout without hiding plan details', () => {
  for (const raw of [undefined, '0', '-1', '1499.00', '1e5', '100000001']) {
    if (raw === undefined) delete process.env[keys[0]]; else process.env[keys[0]] = raw;
    const offer = coachingCatalog('Other').plans[0];
    assert.equal(offer.available, false);
    assert.equal(offer.amountPaise, null);
    assert.deepEqual(offer.benefits, { gymAccess: false, trainerFloorSessions: false, doorstepLabs: false });
    assert.throws(() => coachingOffer(offer.product, 'Other', offer.offerId), { status: 409 });
  }
});
test('server quote rejects changed prices and city switching; benefits stay with purchased offer', () => {
  process.env[keys[0]] = '123400';
  const remote = coachingCatalog('Mumbai').plans[0];
  assert.equal(coachingOffer(remote.product, 'Mumbai', remote.offerId).amountPaise, 123400);
  assert.throws(() => coachingOffer(remote.product, 'Gurugram', remote.offerId), { status: 409 });
  process.env[keys[0]] = '124400';
  assert.throws(() => coachingOffer(remote.product, 'Mumbai', remote.offerId), { status: 409 });
  assert.equal(remote.amountPaise, 123400);
  assert.equal(membershipBenefits({ planType: remote.product, offerSnapshot: remote }).gymAccess, false);
  assert.equal(membershipBenefits({ planType: 'QUARTERLY_11999' }).doorstepLabs, true);
});
