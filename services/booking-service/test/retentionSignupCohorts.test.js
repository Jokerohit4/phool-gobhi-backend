// Retention by signup cohort: filter validation, SQL parameter shape and the pure
// aggregation (buckets, eligibility, platform attribution, medians).
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  retentionSignupFilters, buildRetentionSignupQuery, aggregateRetentionSignupCohorts,
  getRetentionSignupCohorts, weekStart,
} from '../services/retentionSignupCohorts.js';

// 2026-11-23T10:00:00Z is 15:30 IST on 2026-11-23 (a Monday).
const NOW = new Date('2026-11-23T10:00:00Z');

test('filters default to the last 30 days, platform app, weekly buckets', () => {
  const f = retentionSignupFilters({}, NOW);
  assert.deepEqual(f, { since: '2026-10-24', until: '2026-11-23', platform: 'app', granularity: 'week', today: '2026-11-23' });
});

test('filters reject junk instead of widening the report', () => {
  const bad = (q) => assert.throws(() => retentionSignupFilters(q, NOW), { status: 400 });
  bad({ since: '2026-13-01' });
  bad({ since: '2026-02-30' });
  bad({ since: 'yesterday' });
  bad({ since: '2026-11-20', until: '2026-11-10' });
  bad({ since: '2026-11-24' });
  bad({ since: '2025-01-01' });
  bad({ platform: 'windows' });
  bad({ granularity: 'month' });
  assert.equal(retentionSignupFilters({ platform: 'IOS', granularity: 'Day' }, NOW).platform, 'ios');
});

test('weekStart is the Monday of the IST week', () => {
  assert.equal(weekStart('2026-11-23'), '2026-11-23'); // Monday
  assert.equal(weekStart('2026-11-22'), '2026-11-16'); // Sunday
  assert.equal(weekStart('2026-11-18'), '2026-11-16');
});

test('the query binds every value as a parameter and adds the cohort list only when scoped', () => {
  const f = retentionSignupFilters({ since: '2026-11-12' }, NOW);
  const q = buildRetentionSignupQuery(f, { dataset: 'analytics_dev', asOf: NOW });
  assert.deepEqual(q.queryParameters.map((p) => p.name), ['p1', 'p2', 'p3', 'p4']);
  assert.equal(q.values[0], '2026-11-11T00:00:00.000Z', 'scan starts a day before since');
  assert.equal(q.values[2], '2026-11-12');
  assert.match(q.sql, /events_between`\(TIMESTAMP\(@p1\), TIMESTAMP\(@p2\), ARRAY<STRING>\[\]\)/);
  assert.doesNotMatch(q.sql, /UNNEST\(@p5\)/);
  assert.doesNotMatch(q.sql, /2026-11-12/, 'dates are parameters, never interpolated');

  const scoped = buildRetentionSignupQuery(f, { dataset: 'analytics_dev', asOf: NOW, scope: { mode: 'exclude', ids: ['9', '12'] } });
  assert.match(scoped.sql, /NOT IN UNNEST\(@p5\)/);
  assert.equal(scoped.queryParameters[4].parameterType.type, 'ARRAY');
  assert.throws(() => buildRetentionSignupQuery(f, { dataset: 'analytics_x; DROP' }), /Invalid/);
});

const row = (signup_day, plat, over = {}) => ({
  signup_day, plat, onboarded: true, workout_24h: false, d1: false, d3: false, d7: false, active_min_day1: null, ...over,
});

test('weekly buckets, platform filter and D-N eligibility', () => {
  const rows = [
    row('2026-11-12', 'android', { d1: true, d3: true, d7: true, workout_24h: true, active_min_day1: 4 }),
    row('2026-11-13', 'ios', { d1: true, active_min_day1: 10 }),
    row('2026-11-14', 'web', { d1: true }), // dropped by platform=app
    row('2026-11-15', null, { d1: true }), // unknown: dropped by platform=app
    row('2026-11-22', 'android', { d1: true }), // D1 not complete yet (day 23 is today)
    row('2026-11-23', 'ios'), // signed up today: nothing eligible
  ];
  const f = retentionSignupFilters({ since: '2026-11-12' }, NOW);
  const out = aggregateRetentionSignupCohorts(rows, f, NOW);
  assert.equal(out.generatedAt, NOW.toISOString());
  assert.deepEqual(out.cohorts.map((c) => [c.start, c.size]), [['2026-11-09', 2], ['2026-11-16', 1], ['2026-11-23', 1]]);
  const first = out.cohorts[0];
  assert.deepEqual(first.d1, { returned: 2, eligible: 2 });
  assert.deepEqual(first.d3, { returned: 1, eligible: 2 });
  assert.deepEqual(first.d7, { returned: 1, eligible: 2 }); // 12th+7 = 19th < 23rd; 13th+7 = 20th < 23rd
  assert.equal(first.onboardedPct, 100);
  assert.equal(first.workoutWithin24hPct, 50);
  assert.equal(first.medianActiveMinutesDay1, 7);
  const second = out.cohorts[1]; // 2026-11-22 is a Sunday -> week of the 16th
  assert.deepEqual(second.d1, { returned: 0, eligible: 0 }, '22nd D1 needs the 23rd to be over; 23rd is in the next week');
  assert.equal(out.total.size, 4);
  assert.deepEqual(out.total.d1, { returned: 2, eligible: 2 });
  assert.deepEqual(out.total.anyLater, { returned: 0, eligible: 3 }, 'any_later is not set on these rows; the 23rd is not eligible');
});

test('platform=all includes unknown, daily granularity keeps days apart, until is inclusive', () => {
  const rows = [row('2026-11-12', null, { d1: true }), row('2026-11-13', 'web'), row('2026-11-14', 'ios')];
  const f = retentionSignupFilters({ since: '2026-11-12', until: '2026-11-13', platform: 'all', granularity: 'day' }, NOW);
  const out = aggregateRetentionSignupCohorts(rows, f, NOW);
  assert.deepEqual(out.cohorts.map((c) => c.start), ['2026-11-12', '2026-11-13']);
  assert.equal(out.total.size, 2);
  const web = aggregateRetentionSignupCohorts(rows, retentionSignupFilters({ since: '2026-11-12', platform: 'web' }, NOW), NOW);
  assert.equal(web.total.size, 1);
});

test('string booleans from the warehouse REST adapter are understood; empty cohort is empty not an error', () => {
  const f = retentionSignupFilters({ since: '2026-11-12', platform: 'all' }, NOW);
  const out = aggregateRetentionSignupCohorts([{ signup_day: '2026-11-12', plat: 'ios', onboarded: 'true', workout_24h: 'false', d1: 'true', d3: 'false', d7: 'false', active_min_day1: '3.25' }], f, NOW);
  assert.equal(out.total.onboarded, 1);
  assert.equal(out.total.d1.returned, 1);
  assert.equal(out.total.medianActiveMinutesDay1, 3.3);
  const none = aggregateRetentionSignupCohorts([], f, NOW);
  assert.deepEqual(none.cohorts, []);
  assert.equal(none.total.size, 0);
  assert.equal(none.total.onboardedPct, null);
  assert.equal(none.total.medianActiveMinutesDay1, null);
});

test('getRetentionSignupCohorts runs one native query and returns the aggregate', async () => {
  const calls = [];
  const run = async (sql, params, options) => { calls.push({ sql, params, options }); return { rows: [row('2026-11-12', 'ios', { d1: true })] }; };
  const out = await getRetentionSignupCohorts({ since: '2026-11-12' }, { now: NOW, run });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.native, true);
  assert.equal(out.total.size, 1);
  await assert.rejects(() => getRetentionSignupCohorts({ platform: 'nope' }, { now: NOW, run }), { status: 400 });
  assert.equal(calls.length, 1, 'a bad request never reaches the warehouse');
});
