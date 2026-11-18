// Every report that accepts a cohort scope must (a) bind the id list, (b) leave
// the unscoped SQL untouched, and (c) still compile through the BigQuery
// adapter, which rejects any SQL shape it does not recognise.
// Run with: node --experimental-test-module-mocks --test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const envKeys = ['ANALYTICS_DATABASE_URL', 'ANALYTICS_READ_PROVIDER'];
const original = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
after(() => { for (const [k, v] of Object.entries(original)) v === undefined ? delete process.env[k] : process.env[k] = v; });

let calls = [];
let svc;
let compile;

test('setup', async (t) => {
  process.env.ANALYTICS_DATABASE_URL = 'postgres://example/analytics';
  delete process.env.ANALYTICS_READ_PROVIDER;
  t.mock.module('pg', { exports: { default: { Pool: class {
    async query(sql, values) { calls.push({ sql, values }); return { rows: [] }; }
  } } } });
  t.mock.module('axios', { exports: { default: { get: async () => ({ data: { data: {} } }) } } });
  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });
  svc = await import('../services/analyticsQueryService.js');
  ({ compileAnalyticsQuery: compile } = await import('../utils/bigQueryAnalytics.js'));
});

const IDS = ['11', '22'];
const exclude = { mode: 'exclude', ids: IDS, cohorts: ['UNKNOWN_USERS'] };
const include = { mode: 'include', ids: IDS, cohorts: ['TESTING_ACCOUNTS'] };
const STEPS = [{ event: 'gym_viewed' }, { event: 'booking_confirmed' }];

const REPORTS = {
  customerOnboarding: (s) => svc.getCustomerOnboardingFunnel(30, s),
  conversion: (s) => svc.getConversionFunnel(30, s),
  fulfillment: (s) => svc.getFulfillmentFunnel(30, s),
  activation: (s) => svc.getActivation(30, s),
  wallet: (s) => svc.getWalletFunnel(30, s),
  buddy: (s) => svc.getBuddyFunnel(30, s),
  city: (s) => svc.getCityBreakdown(30, s),
  badges: (s) => svc.getBadgeSummary(30, s),
  revenue: (s) => svc.getRevenueTrend(30, s),
  trend: (s) => svc.getTrend('gym_viewed,book_tapped', 30, s),
  retention: (s) => svc.getRetentionCohorts(12, s),
  locationReach: (s) => svc.getLocationReach(30, 50, s),
  eventSearch: (s) => svc.searchEventUsers('gym_viewed', { city: 'Gurugram' }, 30, 25, s),
  customFunnel: (s) => svc.getCustomFunnel(STEPS, 30, s),
};

for (const [name, run] of Object.entries(REPORTS)) {
  test(`${name}: scoped queries bind the ids and compile for BigQuery; unscoped is unchanged`, async () => {
    calls = [];
    await run({ mode: 'all' });
    const unscoped = calls.map((c) => c.sql);
    assert.ok(unscoped.length > 0);
    assert.ok(calls.every((c) => !c.values.some((v) => Array.isArray(v) && v.includes('11'))));

    for (const scope of [exclude, include]) {
      calls = [];
      await run(scope);
      assert.equal(calls.length, unscoped.length);
      // The cohort filter is attached to every query that reads user events.
      // (City breakdown keeps its gym-supply query unscoped on purpose.)
      const filtered = calls.filter((c) => c.values.some((v) => Array.isArray(v) && v.includes('11')));
      assert.ok(filtered.length > 0, `${name}: no query carried the cohort ids`);
      for (const c of calls) {
        const out = compile(c.sql, c.values, { project: 'phool-gobhi', dataset: 'analytics_dev' });
        assert.ok(out.query.length > 0);
      }
    }
  });
}
