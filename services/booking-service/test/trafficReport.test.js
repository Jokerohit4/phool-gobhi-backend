import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildTrafficQuery, trafficFilters, trafficReport } from '../services/trafficReport.js';

const AS_OF = '2026-11-17T12:00:00.000Z';

// Execute the report's actual CTEs and aggregations over fixtures. Only the
// PostgreSQL timestamp syntax is adapted to SQLite; filters, window functions,
// joins and UNION branches are the same as the production query.
function fixtureReport(events, filters = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE analytics_events (ts TEXT, event TEXT, distinct_id TEXT, source TEXT, properties TEXT)');
  const insert = db.prepare('INSERT INTO analytics_events VALUES (?, ?, ?, ?, ?)');
  for (const row of events) insert.run(row.ts, row.event, row.user || 'u1', row.source || 'client', JSON.stringify({ app: 'phool_gobhi', platform: 'android', session_id: 's1', ...row.props }));
  const report = buildTrafficQuery(filters, { asOf: AS_OF });
  const sql = report.sql
    .replace(/CAST\((\$\d+) AS timestamptz\)/g, '$1')
    .replace(/to_char\(ts AT TIME ZONE 'Asia\/Kolkata', 'YYYY-MM-DD'\)/g, "strftime('%Y-%m-%d', ts, '+330 minutes')")
    .replace(/EXTRACT\(EPOCH FROM \((\w+) - (\w+)\)\)/g, '(unixepoch($1, \'subsec\') - unixepoch($2, \'subsec\'))')
    .replace(/EXTRACT\(ISODOW FROM ts AT TIME ZONE 'Asia\/Kolkata'\)/g, "((CAST(strftime('%w', ts, '+330 minutes') AS int) + 6) % 7 + 1)")
    .replace(/EXTRACT\(HOUR FROM ts AT TIME ZONE 'Asia\/Kolkata'\)/g, "CAST(strftime('%H', ts, '+330 minutes') AS int)");
  try {
    const bindings = Object.fromEntries(report.values.map((value, i) => [String(i + 1), value]));
    return trafficReport(db.prepare(sql).all(bindings), report);
  } finally { db.close(); }
}

const event = (time, name, extra = {}) => ({ ts: `2026-11-17T${time}:00.000Z`, event: name, ...extra });
const events = [
  event('10:00', 'screen_viewed', { props: { screen_name: 'Home' } }),
  event('10:01', 'plan_tapped'),
  event('10:02', 'screen_viewed', { props: { screen_name: 'Workout' } }),
  event('10:04', 'workout_started'),
  event('10:20', 'workout_finished'), // sixteen idle minutes must not count
  event('11:00', 'screen_viewed', { props: { screen_name: 'Home' } }), // 40m idle creates a visit
  event('10:00', 'screen_viewed', { user: 'u2', props: { platform: 'ios', session_id: 's2', screen_name: 'Home' } }),
  event('10:02', 'plan_tapped', { user: 'u2', props: { platform: 'ios', session_id: 's2' } }),
  event('10:00', 'screen_viewed', { props: { app: 'phool_gobhi_partner', session_id: 'p1', screen_name: 'Members' } }),
  event('10:01', 'member_opened', { props: { app: 'phool_gobhi_partner', session_id: 'p1' } }),
  event('10:00', 'screen_viewed', { user: 'anon_web', props: { app: 'website', platform: 'web', session_id: 'w1', screen_name: '/' } }),
  event('10:01', 'cta_clicked', { user: 'anon_web', props: { app: 'website', platform: 'web', session_id: 'w1' } }),
  event('11:00', 'plan_tapped', { user: 'no-session', props: { session_id: null } }),
  event('11:00', 'screen_viewed', { user: 'unknown-platform', props: { platform: null, session_id: 'unknown' } }),
  { ts: '2026-11-14T11:00:00.000Z', event: 'plan_tapped', user: 'weekly' },
  { ts: '2026-10-28T11:00:00.000Z', event: 'plan_tapped', user: 'monthly' },
  event('11:00', 'booking_confirmed', { user: 'server-only', source: 'server' }),
  event('11:00', 'identify', { user: 'identify-only' }),
  event('11:00', 'loading_wait_ended', { user: 'diagnostic-only' }),
  event('11:00', 'explore_queue_depth_sampled', { user: 'queue-only' }),
  { ts: AS_OF, event: 'plan_tapped', user: 'upper-bound' },
];

test('product/platform slices and DAU/WAU/MAU use independent rolling windows', () => {
  const report = fixtureReport(events, { product: 'customer', platform: 'android', days: 1 });
  assert.deepEqual(report.activeUsers, { dau: 2, wau: 3, mau: 4 });
  assert.equal(report.summary.users, 2);
  assert.equal(report.summary.sessions, 2);
  assert.equal(report.summary.seconds, 240);
  assert.equal(report.summary.averageSecondsPerSession, 120);
  assert.equal(report.summary.n, 7);
  assert.equal(report.summary.sessionEvents, 6);
  assert.equal(report.summary.measured, 1);
});

test('Both includes Android and iOS; product identities are namespaced in All', () => {
  const customer = fixtureReport(events, { product: 'customer', days: 1 });
  assert.equal(customer.activeUsers.dau, 3);
  assert.equal(customer.summary.seconds, 360);
  assert.equal(customer.summary.sessions, 3);
  const ios = fixtureReport(events, { product: 'customer', platform: 'ios', days: 1 });
  assert.equal(ios.summary.users, 1);
  assert.equal(ios.summary.seconds, 120);
  const partner = fixtureReport(events, { product: 'partner', days: 1 });
  assert.equal(partner.summary.users, 1);
  assert.equal(partner.summary.seconds, 60);
  const website = fixtureReport(events, { product: 'website', platform: 'ios', days: 1 });
  assert.equal(website.summary.users, 1);
  assert.equal(website.summary.seconds, 60);
  const all = fixtureReport(events, { days: 1 });
  assert.equal(all.summary.users, 6, 'customer u1 and partner u1 count as separate product identities');
  assert.equal(all.summary.seconds, 480);
  assert.ok(all.breakdown.some(row => row.platform === 'unknown'));
});

test('screen time carries forward to actions, ignores idle gaps, and adds no final-event time', () => {
  const report = fixtureReport(events, { product: 'customer', platform: 'android', days: 1 });
  assert.equal(report.screens.find(row => row.label === 'Home').seconds, 120);
  assert.equal(report.screens.find(row => row.label === 'Workout').seconds, 120);
  assert.equal(report.actions.find(row => row.label === 'plan_tapped').users, 2);
  assert.equal(report.sessionLengths.find(row => row.label === 'No observed time').n, 1);
  assert.equal(report.sessionLengths.find(row => row.label === '1–5 min').n, 1);
});

test('IST calendar patterns cross UTC midnight and count return dates distinctly', () => {
  const report = fixtureReport([
    { ts: '2026-11-16T19:00:00.000Z', event: 'screen_viewed', props: { screen_name: 'Home' } },
    { ts: '2026-11-16T18:00:00.000Z', event: 'plan_tapped' },
    { ts: '2026-11-16T19:01:00.000Z', event: 'plan_tapped' },
  ], { days: 7 });
  assert.deepEqual(report.daily.map(row => [row.label, row.users]), [['2026-11-16', 1], ['2026-11-17', 1]]);
  assert.equal(report.heatmap.find(row => row.label === '1' && row.platform === '0').users, 1);
  assert.equal(report.frequency[0].label, '2');
  assert.equal(report.frequency[0].users, 1);
});

test('engagement and session boundaries are inclusive at 5 minutes and 30 minutes', () => {
  const report = fixtureReport([
    { ts: '2026-11-17T09:00:00.000Z', event: 'screen_viewed', props: { screen_name: 'Home' } },
    { ts: '2026-11-17T09:05:00.000Z', event: 'plan_tapped' },
    { ts: '2026-11-17T09:10:01.000Z', event: 'plan_tapped' },
    { ts: '2026-11-17T09:40:01.000Z', event: 'plan_tapped' },
    { ts: '2026-11-17T10:10:02.000Z', event: 'plan_tapped' },
  ], { days: 1 });
  assert.equal(report.summary.seconds, 300);
  assert.equal(report.summary.sessions, 2);
  assert.equal(report.screens[0].seconds, 300);
});

test('an identity using both mobile platforms is deduplicated in the product total', () => {
  const report = fixtureReport([
    event('10:00', 'plan_tapped'),
    event('11:00', 'plan_tapped', { props: { platform: 'ios', session_id: 'ios-session' } }),
  ], { product: 'customer', days: 1 });
  assert.equal(report.activeUsers.dau, 1);
  assert.equal(report.summary.users, 1);
  assert.equal(report.breakdown.reduce((sum, row) => sum + row.users, 0), 2);
});

test('missing session IDs retain activity but produce no fabricated time; empty data has null averages', () => {
  const report = fixtureReport([event('11:00', 'screen_viewed', { props: { session_id: null, screen_name: 'Home' } })]);
  assert.equal(report.summary.users, 1);
  assert.equal(report.summary.views, 1);
  assert.equal(report.summary.sessions, 0);
  assert.equal(report.summary.averageSecondsPerSession, null);
  assert.equal(report.summary.averageSecondsPerUser, null);
  const empty = fixtureReport([]);
  assert.deepEqual(empty.activeUsers, { dau: 0, wau: 0, mau: 0 });
  assert.equal(empty.summary.seconds, 0);
  assert.deepEqual(empty.screens, []);
});

test('login links deduplicate anonymous activity across active-user and engagement metrics', () => {
  const report = fixtureReport([
    { ts: '2026-11-16T10:00:00.000Z', event: 'screen_viewed', user: 'anon_a', props: { screen_name: 'Home' } },
    event('10:00', 'screen_viewed', { user: 'anon_a', props: { screen_name: 'Home' } }),
    event('10:01', 'plan_tapped', { user: 'anon_a' }),
    event('10:02', 'identify', { user: '42', props: { anon_distinct_id: 'anon_a' } }),
    event('10:03', 'screen_viewed', { user: '42', props: { screen_name: 'Home' } }),
    event('10:04', 'plan_tapped', { user: '42' }),
    event('10:05', 'identify', { user: '42', props: { anon_distinct_id: 'anon_a' } }),
  ], { product: 'customer', days: 7 });
  assert.deepEqual(report.activeUsers, { dau: 1, wau: 1, mau: 1 });
  assert.equal(report.summary.users, 1);
  assert.equal(report.summary.n, 5, 'repeated identity events neither add activity nor multiply joined rows');
  assert.equal(report.summary.averageSecondsPerUser, 240);
  assert.equal(report.screens[0].users, 1);
  assert.equal(report.actions[0].users, 1);
  assert.equal(report.actions[0].n, 2);
  assert.equal(report.breakdown[0].users, 1);
  assert.deepEqual(report.daily.map(row => row.users), [1, 1]);
  assert.equal(report.frequency[0].label, '2');
  assert.equal(report.frequency[0].users, 1);
  assert.equal(report.heatmap.reduce((sum, row) => sum + row.users, 0), 2);
});

test('identity links stay product scoped and scan beyond the chart window', () => {
  const report = fixtureReport([
    { ts: '2026-11-14T10:00:00.000Z', event: 'identify', user: '42', props: { anon_distinct_id: 'anon_a' } },
    event('10:00', 'plan_tapped', { user: 'anon_a' }),
    event('10:01', 'plan_tapped', { user: '42' }),
    event('10:02', 'plan_tapped', { user: 'anon_unlinked' }),
    event('10:03', 'plan_tapped', { user: 'anon_a', props: { app: 'phool_gobhi_partner' } }),
    event('10:04', 'plan_tapped', { user: '42', props: { app: 'phool_gobhi_partner' } }),
  ], { days: 1 });
  assert.equal(report.activeUsers.dau, 4, 'customer aliases merge, partner aliases do not inherit the customer link');
  assert.equal(report.summary.n, 5);
  assert.equal(report.breakdown.find(row => row.app === 'customer').users, 2);
  assert.equal(report.breakdown.find(row => row.app === 'partner').users, 2);
});

test('warehouse queries are bounded and all user selections are bound parameters', () => {
  const report = buildTrafficQuery({ product: 'partner', platform: 'ios', days: 7 }, { bigQuery: true, asOf: AS_OF });
  assert.match(report.sql, /analytics_dev\.events_between/);
  assert.match(report.sql, /source = 'client'/);
  assert.match(report.sql, /TIMESTAMP_DIFF/);
  assert.match(report.sql, /Asia\/Kolkata/);
  assert.match(report.sql, /@p7/);
  assert.doesNotMatch(report.sql, /\$\d|timestamptz|to_char|EXTRACT\(EPOCH/);
  assert.equal(report.queryParameters[0].parameterValue.value, '2026-10-18T12:00:00.000Z');
  assert.equal(report.queryParameters[6].parameterValue.value, 'partner');
  assert.equal(report.queryParameters[7].parameterValue.value, 'ios');
  assert.equal(buildTrafficQuery({ days: 90 }, { asOf: AS_OF }).values[0], '2026-08-19T12:00:00.000Z');
  assert.throws(() => trafficFilters({ product: "website' OR TRUE" }), { status: 400 });
  assert.throws(() => trafficFilters({ platform: 'web' }), { status: 400 });
  for (const days of [0, -1, 1.5, 366, Infinity, 'x']) assert.throws(() => trafficFilters({ days }), { status: 400 });
  assert.throws(() => buildTrafficQuery({}, { bigQuery: true, dataset: 'bad`' }));
});

test('heatmap drill-down lists who was active per cell with their top screens and actions', () => {
  const report = fixtureReport([
    event('10:00', 'screen_viewed', { user: '42', props: { screen_name: 'Home' } }),
    event('10:01', 'screen_viewed', { user: '42', props: { screen_name: 'Home' } }),
    event('10:02', 'plan_tapped', { user: '42' }),
    event('10:03', 'screen_viewed', { user: 'anon_z', props: { screen_name: 'Workout' } }),
  ], { product: 'customer', days: 1 });
  const cell = report.heatmapUsers['1-15'];
  assert.deepEqual(cell.map(u => [u.app, u.id, u.events]), [['customer', '42', 3], ['customer', 'anon_z', 1]]);
  assert.deepEqual(cell[0].activity, [{ label: 'Home', n: 2 }, { label: 'plan_tapped', n: 1 }]);
  assert.equal(cell.length, report.heatmap.find(row => row.label === '1' && row.platform === '15').users);
});

test('the warehouse query includes the heatmap drill-down branches', () => {
  const sql = buildTrafficQuery({ days: 7 }, { bigQuery: true, asOf: AS_OF }).sql;
  assert.match(sql, /'cell_user'/);
  assert.match(sql, /'cell_what'/);
});
