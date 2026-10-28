import test from 'node:test';
import assert from 'node:assert/strict';

let enabled = true, consent = true, reads = 0;
let handler;
test('setup internal activity controller', async t => {
  t.mock.module('@prisma/client', { exports: { PrismaClient: class {} } });
  t.mock.module(new URL('../services/coachConsentService.js', import.meta.url).href, { exports: { hasCoachScopeService: async () => consent } });
  t.mock.module(new URL('../middleware/requireFeatureFlag.js', import.meta.url).href, { exports: { isFeatureEnabled: async () => enabled } });
  t.mock.module(new URL('../services/challengeActivityService.js', import.meta.url).href, { exports: { challengeActivity: async () => { reads++; return { count: 2 }; } } });
  ({ getChallengeActivityInternal: handler } = await import('../controllers/challengeActivityController.js'));
});
function response() {
  return { code: 200, body: null, status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } };
}
test('revoked consent and disabled features prevent any activity read', async () => {
  for (const settings of [[true, false], [false, true]]) {
    [enabled, consent] = settings; reads = 0;
    const res = response();
    await handler({ query: { userId: '42', since: '2026-10-20', metric: 'water_consistency' } }, res);
    assert.equal(res.code, 403);
    assert.equal(reads, 0);
  }
});
test('consented activity response exposes only a count', async () => {
  enabled = true; consent = true;
  const res = response();
  await handler({ query: { userId: '42', since: '2026-10-20', metric: 'water_consistency' } }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { data: { count: 2 } });
});
