import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const original = Object.fromEntries(['ANALYTICS_READ_PROVIDER', 'ANALYTICS_DATABASE_URL', 'ANALYTICS_ENVIRONMENT', 'ANALYTICS_BIGQUERY_PROJECT', 'ANALYTICS_BIGQUERY_DATASET'].map(key => [key, process.env[key]]));
after(() => { for (const [key, value] of Object.entries(original)) value === undefined ? delete process.env[key] : process.env[key] = value; });
let getTraffic;
let warehouseCalls = [];
let postgresCalls = [];
let failure;
const rows = [{ kind: 'summary', label: '', app: '', platform: '', n: '10', users: '3', views: '4', sessions: '2', seconds: '90', measured: '1' }];

test('setup traffic query dependencies', async t => {
  t.mock.module('pg', { exports: { default: { Pool: class {
    async query(sql, values) { postgresCalls.push({ sql, values }); return { rows }; }
  } } } });
  t.mock.module(new URL('../utils/bigQueryAnalytics.js', import.meta.url).href, { exports: {
    queryBigQuery: async (sql, values, options) => {
      warehouseCalls.push({ sql, values, options });
      if (failure) throw failure;
      return { rows };
    },
  } });
  ({ getTraffic } = await import('../services/analyticsQueryService.js'));
});

test('missing legacy storage is an unavailable report, never fake zero activity', async () => {
  delete process.env.ANALYTICS_READ_PROVIDER;
  delete process.env.ANALYTICS_DATABASE_URL;
  delete process.env.ANALYTICS_BIGQUERY_DATASET;
  process.env.ANALYTICS_ENVIRONMENT = 'dev';
  await assert.rejects(getTraffic({}), /storage is unavailable/);
});

test('BigQuery receives bound native SQL and warehouse failures remain failures', async () => {
  process.env.ANALYTICS_READ_PROVIDER = 'bigquery';
  process.env.ANALYTICS_BIGQUERY_PROJECT = 'phool-gobhi';
  const report = await getTraffic({ product: 'partner', platform: 'ios', days: 7 });
  assert.equal(report.summary.users, 3);
  assert.equal(report.summary.averageSecondsPerSession, 45);
  assert.equal(new Date(report.asOf).getSeconds(), 0);
  assert.equal(new Date(report.asOf).getMilliseconds(), 0);
  assert.equal(warehouseCalls[0].options.native, true);
  assert.equal(warehouseCalls[0].options.queryParameters[6].parameterValue.value, 'partner');
  assert.match(warehouseCalls[0].sql, /analytics_dev\.events_between/);
  failure = new Error('warehouse unavailable');
  await assert.rejects(getTraffic({}), /warehouse unavailable/);
  failure = undefined;
  const calls = warehouseCalls.length;
  await assert.rejects(getTraffic({ product: 'invalid' }), { status: 400 });
  assert.equal(warehouseCalls.length, calls, 'invalid filters never query the warehouse');
});

test('legacy provider receives PostgreSQL placeholders and bound selections', async () => {
  delete process.env.ANALYTICS_READ_PROVIDER;
  process.env.ANALYTICS_DATABASE_URL = 'postgres://test.invalid/analytics';
  const report = await getTraffic({ product: 'customer', platform: 'android', days: 90 });
  assert.equal(report.filters.days, 90);
  assert.match(postgresCalls[0].sql, /CAST\(\$1 AS timestamptz\)/);
  assert.equal(postgresCalls[0].values[6], 'customer');
  assert.equal(postgresCalls[0].values[7], 'android');
});
