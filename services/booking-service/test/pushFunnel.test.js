import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPushFunnelQuery, buildPushTypesQuery, getPushFunnel, getPushTypes, pushFilters, pushFunnelReport } from '../services/pushFunnelService.js';

const AS_OF = new Date('2026-11-23T12:00:00.000Z');

test('filters default to 30 days and reject anything outside the contract', () => {
  assert.deepEqual(pushFilters({}), { days: 30, type: '', platform: '', role: '' });
  assert.equal(pushFilters({ days: '7' }).days, 7);
  assert.equal(pushFilters({ days: '90', type: 'nudge:first_step', platform: 'IOS', role: 'partner' }).platform, 'ios');
  for (const days of ['0', '14', '365', 'abc']) assert.throws(() => pushFilters({ days }), (e) => e.status === 400);
  assert.throws(() => pushFilters({ platform: 'web' }), (e) => e.status === 400);
  assert.throws(() => pushFilters({ role: 'admin' }), (e) => e.status === 400);
  assert.throws(() => pushFilters({ type: "x'; DROP" }), (e) => e.status === 400);
});

test('the query binds every user value, reads only the four push events and dedupes per notification_id', () => {
  const q = buildPushFunnelQuery({ days: 7, type: 'booking_confirmed', platform: 'ios', role: 'customer' }, { asOf: AS_OF, dataset: 'analytics_dev' });
  assert.match(q.sql, /`phool-gobhi\.analytics_dev\.events_between`\(TIMESTAMP\(@p1\), TIMESTAMP\(@p2\), ARRAY<STRING>\['push_sent','push_failed','push_delivered','push_opened'\]\)/);
  assert.ok(!q.sql.includes('booking_confirmed'), 'filter values are parameters, never SQL text');
  assert.match(q.sql, /GROUP BY nid/);
  assert.match(q.sql, /is_delivered/);
  assert.match(q.sql, /opened_ts IS NOT NULL\), 1, 0\) AS is_delivered|delivered_ts IS NOT NULL OR opened_ts IS NOT NULL/);
  assert.deepEqual(q.queryParameters.map(p => p.name), ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.deepEqual(q.queryParameters.slice(2).map(p => p.parameterValue.value), ['booking_confirmed', 'ios', 'customer']);
  assert.equal(q.queryParameters[1].parameterValue.value, '2026-11-23T12:00:00.000Z');
  assert.equal(q.queryParameters[0].parameterValue.value, '2026-11-16T12:00:00.000Z');
  assert.throws(() => buildPushFunnelQuery({}, { asOf: AS_OF, dataset: 'analytics_x' }));
});

test('the report is shaped to the admin contract with rounded rates', () => {
  const rows = [
    { kind: 'total', label: '', sent: 100, failed: 4, delivered: 80, opened: 20, p50: null, p90: null, n: null },
    { kind: 'type', label: 'booking_confirmed', sent: 60, failed: 1, delivered: 54, opened: 18 },
    { kind: 'type', label: 'nudge:comeback', sent: 40, failed: 3, delivered: 26, opened: 2 },
    { kind: 'day', label: '2026-11-22', sent: 40, failed: 0, delivered: 30, opened: 8 },
    { kind: 'day', label: '2026-11-21', sent: 60, failed: 4, delivered: 50, opened: 12 },
    { kind: 'platform', label: 'android', sent: 70, delivered: 60, opened: 15 },
    { kind: 'platform', label: 'unknown', sent: 30, delivered: 20, opened: 5 },
    { kind: 'open_time', label: '', p50: 42.04, p90: 600, n: 20 },
    { kind: 'failure', label: 'messaging/registration-token-not-registered', failed: 3 },
    { kind: 'failure', label: 'messaging/internal-error', failed: 1 },
  ];
  const report = pushFunnelReport(rows, { filters: { days: 30 }, generatedAt: AS_OF });
  assert.deepEqual(report.totals, { sent: 100, failed: 4, delivered: 80, opened: 20, deliveredRate: 0.8, openRate: 0.2, openOfDeliveredRate: 0.25 });
  assert.equal(report.days, 30);
  assert.equal(report.generatedAt, '2026-11-23T12:00:00.000Z');
  assert.deepEqual(report.byType[0], { type: 'booking_confirmed', sent: 60, failed: 1, delivered: 54, opened: 18, deliveredRate: 0.9, openRate: 0.3 });
  assert.deepEqual(report.byDay.map(d => d.date), ['2026-11-21', '2026-11-22']);
  assert.deepEqual(report.byPlatform.map(p => p.platform), ['android', 'unknown']);
  assert.deepEqual(report.timeToOpenSeconds, { p50: 42, p90: 600, count: 20 });
  assert.deepEqual(report.failuresByCode[0], { code: 'messaging/registration-token-not-registered', count: 3 });
});

test('an empty window yields zeros, not NaN or errors', () => {
  const report = pushFunnelReport([{ kind: 'total', sent: null, failed: null, delivered: null, opened: null }], { filters: { days: 7 }, generatedAt: AS_OF });
  assert.deepEqual(report.totals, { sent: 0, failed: 0, delivered: 0, opened: 0, deliveredRate: 0, openRate: 0, openOfDeliveredRate: 0 });
  assert.deepEqual(report.timeToOpenSeconds, { p50: null, p90: null, count: 0 });
  assert.deepEqual([report.byType, report.byDay, report.byPlatform, report.failuresByCode], [[], [], [], []]);
});

test('getPushFunnel / getPushTypes run native warehouse queries and need the BigQuery provider', async () => {
  const saved = [process.env.ANALYTICS_READ_PROVIDER, process.env.ANALYTICS_ENVIRONMENT];
  process.env.ANALYTICS_ENVIRONMENT = 'dev';
  try {
    process.env.ANALYTICS_READ_PROVIDER = 'postgres';
    await assert.rejects(getPushFunnel({}, { query: async () => ({ rows: [] }) }), (e) => e.status === 503);
    process.env.ANALYTICS_READ_PROVIDER = 'bigquery';
    const calls = [];
    const query = async (sql, values, options) => { calls.push(options); return { rows: [{ type: 'booking_confirmed', sent: '3' }] }; };
    const types = await getPushTypes({ days: '7' }, { query });
    assert.deepEqual(types.types, [{ type: 'booking_confirmed', sent: 3 }]);
    assert.equal(types.days, 7);
    const funnel = await getPushFunnel({ days: '7' }, { query: async (sql, values, options) => { calls.push(options); return { rows: [] }; } });
    assert.equal(funnel.totals.sent, 0);
    assert.ok(calls.every(options => options.native === true && options.queryParameters.length >= 2));
    await assert.rejects(getPushFunnel({ days: '5' }, { query }), (e) => e.status === 400);
    assert.ok(buildPushTypesQuery({}, { asOf: AS_OF }).sql.includes("ARRAY<STRING>['push_sent']"));
  } finally {
    for (const [i, key] of ['ANALYTICS_READ_PROVIDER', 'ANALYTICS_ENVIRONMENT'].entries()) {
      if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
    }
  }
});
