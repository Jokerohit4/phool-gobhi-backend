import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDashboardStats, participantDays, dayRange, weekStartOf, MIN_GROUP_SIZE,
} from '../services/orgDashboardStats.js';

const WINDOW = { startDay: '2026-12-01', endDay: '2026-12-14' }; // 14 days, Tue..Mon
const person = (userId, teamId, over = {}) => ({
  userId, teamId,
  ...participantDays({ ...WINDOW, attendanceDays: [], workoutDays: [], stepsByDay: {}, ...over }),
});
const counts = (over = {}) => ({ added: 10, invited: 2, joined: 8, optedOut: 1, pendingConsent: 2, ...over });

test('day ranges and week starts (Monday) are right across a month edge', () => {
  assert.deepEqual(dayRange('2026-12-30', '2027-01-02'), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  assert.equal(weekStartOf('2026-12-01'), '2026-11-30'); // Tuesday -> Monday
  assert.equal(weekStartOf('2026-12-06'), '2026-11-30'); // Sunday belongs to the Monday before
  assert.equal(weekStartOf('2026-12-07'), '2026-12-07');
});

test('a person is active on a day through check-in, workout or 3000+ steps, once however many', () => {
  const p = participantDays({
    ...WINDOW, attendanceDays: ['2026-12-02'], workoutDays: ['2026-12-02', '2026-12-03'],
    stepsByDay: { '2026-12-02': 9000, '2026-12-04': 3000, '2026-12-05': 2999, '2026-11-01': 20000 },
  });
  assert.deepEqual([...p.active].sort(), ['2026-12-02', '2026-12-03', '2026-12-04']);
  assert.equal(p.steps, 9000 + 3000 + 2999, 'steps outside the window are ignored; low-step days still add to the total');
});

test('funnel, rates and totals', () => {
  const participants = [
    person(1, 1, { workoutDays: ['2026-12-02', '2026-12-04'], stepsByDay: { '2026-12-02': 5000 } }),
    person(2, 1, { attendanceDays: ['2026-12-13'] }),
    person(3, 2),
  ];
  const s = computeDashboardStats({ participants, counts: counts({ joined: 6, optedOut: 0, pendingConsent: 3 }), teams: [], window: WINDOW });
  assert.deepEqual(s.funnel.map((f) => [f.key, f.value]), [['added', 10], ['joined', 6], ['consented', 3], ['active', 2]]);
  assert.equal(s.rates.joined, 60);
  assert.equal(s.rates.consented, 50, 'consented / (joined - opted out)');
  assert.equal(s.rates.active, 66.7);
  assert.equal(s.activeInPeriod, 2);
  assert.equal(s.totals.workoutDays, 2);
  assert.equal(s.totals.checkinDays, 1);
  assert.equal(s.totals.steps, 5000);
  assert.equal(s.totals.activeDays, 3);
  assert.equal(s.avgActiveDays, 1);
});

test('"active in the last 7 days" only looks at the last 7 days of the window', () => {
  const participants = [
    person(1, null, { workoutDays: ['2026-12-02'] }),                    // early only
    person(2, null, { workoutDays: ['2026-12-08'] }),                    // inside last 7 (08..14)
    person(3, null, { workoutDays: ['2026-12-07'] }),                    // just outside
  ];
  const s = computeDashboardStats({ participants, counts: counts(), teams: [], window: WINDOW });
  assert.equal(s.activeLast7Days, 1);
  assert.equal(s.activeInPeriod, 3);
});

test('daily series has one point per day and counts distinct people; weekly counts a person once per week', () => {
  const participants = [
    person(1, null, { workoutDays: ['2026-12-02', '2026-12-03', '2026-12-09'] }),
    person(2, null, { workoutDays: ['2026-12-02'] }),
  ];
  const s = computeDashboardStats({ participants, counts: counts(), teams: [], window: WINDOW });
  assert.equal(s.daily.length, 14);
  assert.equal(s.daily.find((d) => d.day === '2026-12-02').activeMembers, 2);
  assert.equal(s.daily.find((d) => d.day === '2026-12-03').activeMembers, 1);
  assert.equal(s.daily.find((d) => d.day === '2026-12-05').activeMembers, 0);
  const w = Object.fromEntries(s.weekly.map((x) => [x.weekStart, x.activeMembers]));
  assert.equal(w['2026-11-30'], 2); // 02, 03 -> person 1 once, person 2 once
  assert.equal(w['2026-12-07'], 1);
});

test('distribution buckets cover every participant exactly once', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`);
  const participants = [
    person(1, null), person(2, null, { workoutDays: many(1) }), person(3, null, { workoutDays: many(2) }),
    person(4, null, { workoutDays: many(4) }), person(5, null, { workoutDays: many(8) }), person(6, null, { workoutDays: many(13) }),
  ];
  const s = computeDashboardStats({ participants, counts: counts(), teams: [], window: WINDOW });
  assert.deepEqual(s.distribution.map((d) => [d.key, d.members]), [['0', 1], ['1-2', 2], ['3-5', 1], ['6-10', 1], ['11+', 1]]);
  assert.equal(s.distribution.reduce((a, d) => a + d.members, 0), participants.length);
});

test('teams: average active days, participation, and small teams are flagged', () => {
  const participants = [
    person(1, 1, { workoutDays: ['2026-12-02', '2026-12-03'] }), person(2, 1, { workoutDays: ['2026-12-02'] }),
    person(3, 1), person(4, 2, { workoutDays: ['2026-12-05'] }),
  ];
  const s = computeDashboardStats({
    participants, counts: counts(), window: WINDOW,
    teams: [{ id: 1, name: 'Sales', added: 5 }, { id: 2, name: 'Ops', added: 2 }, { id: 3, name: 'Empty', added: 0 }],
  });
  const sales = s.teams.find((t) => t.name === 'Sales');
  assert.equal(sales.participants, 3);
  assert.equal(sales.avgActiveDays, 1);
  assert.equal(sales.participationRate, 66.7);
  assert.equal(sales.small, false);
  assert.equal(s.teams.find((t) => t.name === 'Ops').small, true, `fewer than ${MIN_GROUP_SIZE} participants`);
  assert.equal(s.teams.find((t) => t.name === 'Empty').participationRate, null, 'no division by zero');
});

test('an empty programme produces zeros and nulls, never NaN', () => {
  const s = computeDashboardStats({ participants: [], counts: { added: 0, invited: 0, joined: 0, optedOut: 0, pendingConsent: 0 }, teams: [], window: WINDOW });
  assert.equal(s.avgActiveDays, 0);
  assert.deepEqual(s.rates, { joined: null, consented: null, active: null, activeLast7Days: null });
  assert.equal(s.totals.steps, 0);
  assert.ok(!JSON.stringify(s).includes('NaN'));
});
