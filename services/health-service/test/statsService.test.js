// FR-06. The properties worth pinning are the stat DEFINITIONS (PRD §8.3),
// because five different screens will eventually quote these numbers and
// they have to mean one thing:
//
//   - rest logs count toward neither sessions nor volume, but are reported
//   - a quick-log with no exercise detail contributes 0 volume, by design
//   - avg RPE is null, not 0, when nothing recorded effort
//   - weekly bars are Monday-start ISO weeks, and empty weeks are emitted
//   - the heatmap spans 12 weeks whatever the KPI range is
//
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let sessionRows = [];
let lastFindManyArgs = null;

let getStatsService;

function isoDay(offsetDays = 0) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d.toISOString().slice(0, 10);
}

// Shapes a row the way buildRangeSeriesService's prisma query returns it,
// since stats is deliberately layered on that builder rather than querying
// for itself.
function sessionRow({
  id = 1,
  day = isoDay(0),
  type = 'strength',
  rpe = null,
  minutes = 45,
  sets = [],
} = {}) {
  const startedAt = new Date(`${day}T09:00:00Z`);
  return {
    id,
    localDate: day,
    startedAt,
    endedAt: new Date(startedAt.getTime() + minutes * 60000),
    type,
    rpe,
    gymId: null,
    bookingId: null,
    exercises: sets.length
      ? [{ exercise: { name: 'Bench', muscleGroup: 'chest' }, sets }]
      : [],
  };
}

const set = (weightKg, reps, completed = true) => ({ weightKg, reps, completed });

test('setup: mock prisma once, import statsService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.workoutSession = {
            findMany: async (args) => {
              lastFindManyArgs = args;
              return sessionRows;
            },
          };
          this.biometricEntry = { findMany: async () => [] };
        }
      },
    },
  });
  ({ getStatsService } = await import('../services/statsService.js'));
});

test('an unknown range falls back to the default rather than erroring', async () => {
  sessionRows = [];
  const stats = await getStatsService(1, 'all-time');
  assert.equal(stats.range, '30d');
  assert.equal(stats.days, 30);
});

test('only finished sessions are ever considered', async () => {
  sessionRows = [];
  await getStatsService(1, '7d');
  // Enforced by the shared builder's own filter, which is exactly why stats
  // layers on it instead of querying separately.
  assert.deepEqual(lastFindManyArgs.where.endedAt, { not: null });
});

test('KPIs follow the stat definitions', async () => {
  sessionRows = [
    sessionRow({ id: 1, day: isoDay(0), rpe: 8, minutes: 60, sets: [set(100, 5), set(100, 5)] }),
    sessionRow({ id: 2, day: isoDay(1), rpe: 6, minutes: 30, sets: [set(50, 10)] }),
    // Rest: counted as a rest day, never as a session or as volume.
    sessionRow({ id: 3, day: isoDay(2), type: 'rest', minutes: 0 }),
    // A quick-log with no exercise detail: a real session, zero volume.
    sessionRow({ id: 4, day: isoDay(3), rpe: null, minutes: 40 }),
  ];

  const { kpi } = await getStatsService(1, '7d');

  assert.equal(kpi.sessions, 3, 'the rest log is not a session');
  assert.equal(kpi.volumeKg, 1500, '100*5 + 100*5 + 50*10, quick-log adds nothing');
  assert.equal(kpi.minutes, 130);
  assert.equal(kpi.restDays, 1);
  assert.equal(kpi.activeDays, 3);
  // Mean of the two sessions that recorded effort — the unrated one is not
  // averaged in as a zero.
  assert.equal(kpi.avgRpe, 7);
  assert.equal(kpi.consistencyPct, Math.round((3 / 7) * 100));
});

test('avg RPE is null, not zero, when nothing recorded effort', async () => {
  sessionRows = [sessionRow({ id: 1, rpe: null })];

  const { kpi } = await getStatsService(1, '7d');

  assert.equal(kpi.avgRpe, null);
});

test('an incomplete set contributes no volume', async () => {
  sessionRows = [
    sessionRow({ id: 1, sets: [set(100, 5), set(200, 5, false)] }),
  ];

  const { kpi } = await getStatsService(1, '7d');

  assert.equal(kpi.volumeKg, 500);
});

test('nothing logged yields a zeroed, well-formed response', async () => {
  sessionRows = [];

  const stats = await getStatsService(1, '30d');

  assert.equal(stats.kpi.sessions, 0);
  assert.equal(stats.kpi.volumeKg, 0);
  assert.equal(stats.kpi.avgRpe, null);
  assert.equal(stats.heatmap.length, 0);
  assert.deepEqual(stats.typeSplit, []);
  // Bars still come back so the chart draws an empty axis rather than
  // collapsing to nothing.
  assert.ok(stats.weeklyBars.length >= 4);
  assert.ok(stats.weeklyBars.every((b) => b.sessions === 0));
});

test('weekly bars are Monday-start and include empty weeks', async () => {
  sessionRows = [sessionRow({ id: 1, day: isoDay(0) })];

  const { weeklyBars } = await getStatsService(1, '12w');

  assert.equal(weeklyBars.length, 12);
  // Ascending, exactly 7 days apart, each on a Monday.
  for (let i = 1; i < weeklyBars.length; i++) {
    const prev = new Date(`${weeklyBars[i - 1].weekStart}T00:00:00Z`);
    const cur = new Date(`${weeklyBars[i].weekStart}T00:00:00Z`);
    assert.equal((cur - prev) / (24 * 3600 * 1000), 7);
    assert.equal(cur.getUTCDay(), 1, 'weeks start on Monday');
  }
  // Today's session lands in the last bar, and the earlier weeks are zero
  // rather than missing.
  assert.equal(weeklyBars.at(-1).sessions, 1);
  assert.equal(weeklyBars[0].sessions, 0);
});

test('the heatmap spans 12 weeks even when the KPI range is 7 days', async () => {
  sessionRows = [
    sessionRow({ id: 1, day: isoDay(0) }),
    // 40 days ago: outside a 7d KPI range, inside the heatmap window.
    sessionRow({ id: 2, day: isoDay(40) }),
    // 200 days ago: outside both.
    sessionRow({ id: 3, day: isoDay(200) }),
  ];

  const stats = await getStatsService(1, '7d');

  assert.equal(stats.kpi.sessions, 1, 'KPIs respect the requested range');
  const days = stats.heatmap.map((h) => h.localDate);
  assert.ok(days.includes(isoDay(0)));
  assert.ok(days.includes(isoDay(40)), 'a 12-week heatmap outlives a 7-day range');
  assert.ok(!days.includes(isoDay(200)));
});

test('two sessions on one day are one heatmap cell with a count of two', async () => {
  sessionRows = [
    sessionRow({ id: 1, day: isoDay(0) }),
    sessionRow({ id: 2, day: isoDay(0) }),
  ];

  const { heatmap, kpi } = await getStatsService(1, '7d');

  assert.equal(heatmap.length, 1);
  assert.equal(heatmap[0].sessions, 2);
  // Two gyms in a day is two sessions but one active day.
  assert.equal(kpi.sessions, 2);
  assert.equal(kpi.activeDays, 1);
});

test('the type split is ordered and percentages are of trained sessions', async () => {
  sessionRows = [
    sessionRow({ id: 1, type: 'strength' }),
    sessionRow({ id: 2, type: 'strength' }),
    sessionRow({ id: 3, type: 'cardio' }),
    sessionRow({ id: 4, type: 'rest' }),
  ];

  const { typeSplit } = await getStatsService(1, '7d');

  assert.deepEqual(typeSplit, [
    { type: 'strength', sessions: 2, percent: 67 },
    { type: 'cardio', sessions: 1, percent: 33 },
  ]);
});

test('a session with no localDate is dated from startedAt, not dropped', async () => {
  const row = sessionRow({ id: 1, day: isoDay(1) });
  row.localDate = null;
  sessionRows = [row];

  const stats = await getStatsService(1, '7d');

  assert.equal(stats.kpi.sessions, 1);
  assert.equal(stats.heatmap.length, 1);
});
