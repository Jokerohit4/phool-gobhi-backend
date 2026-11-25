import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPermissionQuery, getNotificationPermission, permissionFilters, permissionReport } from '../services/notificationPermissionService.js';

const AS_OF = new Date('2026-11-24T12:00:00.000Z');

test('filters default to 14 days and reject anything outside the contract', () => {
  assert.deepEqual(permissionFilters({}), { days: 14, platform: '', app: '' });
  assert.equal(permissionFilters({ days: '7' }).days, 7);
  assert.deepEqual(permissionFilters({ days: '30', platform: 'IOS', app: 'Partner' }), { days: 30, platform: 'ios', app: 'partner' });
  for (const days of ['0', '90', 'abc']) assert.throws(() => permissionFilters({ days }), (e) => e.status === 400);
  assert.throws(() => permissionFilters({ platform: 'web' }), (e) => e.status === 400);
  assert.throws(() => permissionFilters({ app: 'admin' }), (e) => e.status === 400);
});

test('the query binds values, reads one event through events_between, drops anon ids and keeps the latest row per person', () => {
  const q = buildPermissionQuery({ days: 7, platform: 'ios', app: 'customer' }, { asOf: AS_OF, dataset: 'analytics_dev' });
  assert.match(q.sql, /`phool-gobhi\.analytics_dev\.events_between`\(TIMESTAMP\(@p1\), TIMESTAMP\(@p2\), ARRAY<STRING>\['notification_permission_status'\]\)/);
  assert.match(q.sql, /NOT STARTS_WITH\(distinct_id, 'anon_'\)/);
  assert.match(q.sql, /QUALIFY ROW_NUMBER\(\) OVER \(PARTITION BY distinct_id ORDER BY ts DESC\) = 1/);
  assert.ok(!/\bios\b.*customer/.test(q.sql.replace(/'ios', 'android'/g, '')), 'filter values are parameters');
  assert.deepEqual(q.queryParameters.map(p => p.parameterValue.value), ['2026-11-17T12:00:00.000Z', '2026-11-24T12:00:00.000Z', 'ios', 'customer']);
  assert.throws(() => buildPermissionQuery({}, { asOf: AS_OF, dataset: 'analytics_x' }));
});

test('the report counts users by their latest status and shapes the contract', () => {
  const rows = [
    { platform: 'android', app: 'customer', status: 'granted', users: '6', last_report: '2026-11-24T10:00:00Z' },
    { platform: 'android', app: 'customer', status: 'denied', users: '2', last_report: '2026-11-24T11:30:00Z' },
    { platform: 'ios', app: 'customer', status: 'denied', users: '1', last_report: '2026-11-23T09:00:00Z' },
    { platform: 'ios', app: 'partner', status: 'provisional', users: '1', last_report: '2026-11-22T09:00:00Z' },
    { platform: 'unknown', app: 'partner', status: 'not_determined', users: '2', last_report: '2026-11-21T09:00:00Z' },
    { platform: 'ios', app: 'customer', status: 'bogus', users: '50' },
  ];
  const r = permissionReport(rows, { filters: { days: 14 }, generatedAt: AS_OF });
  assert.equal(r.days, 14);
  assert.equal(r.generatedAt, '2026-11-24T12:00:00.000Z');
  assert.equal(r.reportingUsers, 12);
  assert.equal(r.mutedUsers, 3);
  assert.equal(r.mutedRate, 0.25);
  assert.deepEqual(r.byStatus, [{ status: 'granted', users: 6 }, { status: 'denied', users: 3 }, { status: 'not_determined', users: 2 }, { status: 'provisional', users: 1 }]);
  assert.deepEqual(r.byPlatform, [
    { platform: 'android', granted: 6, denied: 2, not_determined: 0, provisional: 0 },
    { platform: 'ios', granted: 0, denied: 1, not_determined: 0, provisional: 1 },
    { platform: 'unknown', granted: 0, denied: 0, not_determined: 2, provisional: 0 },
  ]);
  assert.deepEqual(r.byApp, [
    { app: 'customer', granted: 6, denied: 3, not_determined: 0, provisional: 0 },
    { app: 'partner', granted: 0, denied: 0, not_determined: 2, provisional: 1 },
  ]);
  assert.equal(r.lastReportAt, '2026-11-24T11:30:00Z');
});

test('no data yields zeros, all four statuses and a null lastReportAt', () => {
  const r = permissionReport([], { filters: { days: 7 }, generatedAt: AS_OF });
  assert.deepEqual([r.reportingUsers, r.mutedUsers, r.mutedRate, r.lastReportAt], [0, 0, 0, null]);
  assert.deepEqual(r.byStatus.map(s => s.status), ['granted', 'denied', 'not_determined', 'provisional']);
  assert.ok(r.byStatus.every(s => s.users === 0));
  assert.deepEqual(r.byPlatform.map(p => p.platform), ['android', 'ios', 'unknown']);
  assert.deepEqual(r.byApp.map(a => a.app), ['customer', 'partner']);
});

test('getNotificationPermission runs a native query, needs the BigQuery provider and validates params', async () => {
  const saved = [process.env.ANALYTICS_READ_PROVIDER, process.env.ANALYTICS_ENVIRONMENT];
  process.env.ANALYTICS_ENVIRONMENT = 'dev';
  try {
    process.env.ANALYTICS_READ_PROVIDER = 'postgres';
    await assert.rejects(getNotificationPermission({}, { query: async () => ({ rows: [] }) }), (e) => e.status === 503);
    process.env.ANALYTICS_READ_PROVIDER = 'bigquery';
    const calls = [];
    const out = await getNotificationPermission({ days: '30', app: 'partner' }, {
      query: async (sql, values, options) => { calls.push(options); return { rows: [{ platform: 'ios', app: 'partner', status: 'denied', users: '4', last_report: '2026-11-24T01:00:00Z' }] }; },
    });
    assert.equal(out.mutedUsers, 4);
    assert.equal(out.mutedRate, 1);
    assert.ok(calls[0].native === true && calls[0].queryParameters.length === 4);
    await assert.rejects(getNotificationPermission({ days: '5' }, { query: async () => ({ rows: [] }) }), (e) => e.status === 400);
  } finally {
    for (const [i, key] of ['ANALYTICS_READ_PROVIDER', 'ANALYTICS_ENVIRONMENT'].entries()) {
      if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
    }
  }
});
