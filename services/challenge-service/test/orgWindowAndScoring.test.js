import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveOrgStatus, daysLeft, leaderboardWindow, istDay, parseOptionalDate,
  istDayStartUtc, istDayEndExclusiveUtc,
} from '../utils/orgWindow.js';
import { scoreMember, rankMembers, rankTeams, displayNameFor, ACTIVE_DAY_STEP_THRESHOLD } from '../services/orgScoring.js';

const NOW = new Date('2026-12-10T08:00:00Z'); // 13:30 IST

// ---- Company profile expiry -------------------------------------------------

test('a profile with no expiry never lapses', () => {
  assert.equal(effectiveOrgStatus({ status: 'active', expiresAt: null }, NOW), 'active');
  assert.equal(daysLeft({ expiresAt: null }, NOW), null);
});

test('a profile past its expiry is a normal one even before the sweep has run', () => {
  const org = { status: 'active', expiresAt: new Date('2026-12-09T00:00:00Z') };
  assert.equal(effectiveOrgStatus(org, NOW), 'expired');
  assert.equal(daysLeft(org, NOW), 0);
});

test('a profile that has not reached its expiry is active, with whole days left rounded up', () => {
  const org = { status: 'active', expiresAt: new Date('2026-12-12T07:00:00Z') };
  assert.equal(effectiveOrgStatus(org, NOW), 'active');
  assert.equal(daysLeft(org, NOW), 2);
});

test('archived always wins; a stored expired status is not resurrected by itself', () => {
  assert.equal(effectiveOrgStatus({ status: 'archived', expiresAt: null }, NOW), 'archived');
  assert.equal(effectiveOrgStatus({ status: 'expired', expiresAt: null }, NOW), 'expired');
});

// ---- Leaderboard window -----------------------------------------------------

const board = (over = {}) => ({ startsAt: new Date('2026-12-01T00:00:00Z'), endsAt: null, status: 'active', ...over });

test('a board with no end date is unlimited and live', () => {
  const w = leaderboardWindow(board(), { expiresAt: null }, NOW);
  assert.equal(w.unlimited, true);
  assert.equal(w.status, 'live');
  assert.equal(w.endsAt, null);
  assert.equal(w.endDay, istDay(NOW));
});

test("a board cannot outlive its company: the earlier of the two ends wins", () => {
  const orgEnds = new Date('2026-12-20T00:00:00Z');
  const boardEnds = new Date('2026-12-31T00:00:00Z');
  const w = leaderboardWindow(board({ endsAt: boardEnds }), { expiresAt: orgEnds }, NOW);
  assert.equal(w.endsAt.getTime(), orgEnds.getTime());
  assert.equal(w.unlimited, false);

  // and an unlimited board still stops when the company does
  const w2 = leaderboardWindow(board(), { expiresAt: orgEnds }, NOW);
  assert.equal(w2.endsAt.getTime(), orgEnds.getTime());
  assert.equal(w2.unlimited, false);
});

test('a finished board freezes its last counted day at the end, not at today', () => {
  const w = leaderboardWindow(board({ endsAt: new Date('2026-12-05T18:29:59Z') }), { expiresAt: null }, NOW);
  assert.equal(w.status, 'ended');
  assert.equal(w.endDay, '2026-12-05');
});

test('upcoming and archived boards are labelled as such', () => {
  assert.equal(leaderboardWindow(board({ startsAt: new Date('2026-12-20T00:00:00Z') }), { expiresAt: null }, NOW).status, 'upcoming');
  assert.equal(leaderboardWindow(board({ status: 'archived' }), { expiresAt: null }, NOW).status, 'archived');
});

test('IST day boundaries are exact', () => {
  assert.equal(istDay('2026-12-10T18:29:59Z'), '2026-12-10');
  assert.equal(istDay('2026-12-10T18:30:00Z'), '2026-12-11');
  assert.equal(istDayStartUtc('2026-12-11').toISOString(), '2026-12-10T18:30:00.000Z');
  assert.equal(istDayEndExclusiveUtc('2026-12-10').toISOString(), '2026-12-10T18:30:00.000Z');
});

test('parseOptionalDate: undefined = untouched, null/empty = clear, garbage = 400', () => {
  assert.equal(parseOptionalDate(undefined, 'x'), undefined);
  assert.equal(parseOptionalDate(null, 'x'), null);
  assert.equal(parseOptionalDate('', 'x'), null);
  assert.throws(() => parseOptionalDate('nope', 'endsAt'), (e) => e.status === 400 && /endsAt/.test(e.error));
});

// ---- Scoring ----------------------------------------------------------------

const W = { startDay: '2026-12-01', endDay: '2026-12-10' };

test('active_days counts a day once however many ways it was active', () => {
  const r = scoreMember({
    scoring: 'active_days', ...W,
    attendanceDays: ['2026-12-02'],
    workoutDays: ['2026-12-02', '2026-12-03'],
    stepsByDay: { '2026-12-02': 9000, '2026-12-04': ACTIVE_DAY_STEP_THRESHOLD, '2026-12-05': ACTIVE_DAY_STEP_THRESHOLD - 1 },
  });
  assert.equal(r.score, 3); // 2nd, 3rd, 4th. The 5th is below the step threshold.
  assert.equal(r.activeDays, 3);
});

test('days outside the window never count', () => {
  const r = scoreMember({
    scoring: 'active_days', ...W,
    attendanceDays: ['2026-11-30', '2026-12-11'], workoutDays: ['2026-11-01'], stepsByDay: { '2026-12-31': 20000 },
  });
  assert.equal(r.score, 0);
  assert.equal(r.steps, 0);
});

test('workout_days ignores steps and check-ins; steps sums every day', () => {
  const input = { ...W, attendanceDays: ['2026-12-02'], workoutDays: ['2026-12-03', '2026-12-04'], stepsByDay: { '2026-12-05': 4000, '2026-12-06': 1500 } };
  assert.equal(scoreMember({ scoring: 'workout_days', ...input }).score, 2);
  assert.equal(scoreMember({ scoring: 'steps', ...input }).score, 5500);
});

test('junk step values are ignored rather than poisoning a total', () => {
  const r = scoreMember({ scoring: 'steps', ...W, stepsByDay: { '2026-12-02': 'abc', '2026-12-03': -5, '2026-12-04': 1000 } });
  assert.equal(r.score, 1000);
});

// ---- Ranking ----------------------------------------------------------------

const row = (userId, score, over = {}) => ({ userId, score, activeDays: score, steps: 0, ...over });

test('equal scores share a rank and the next rank is skipped', () => {
  const ranked = rankMembers([row(1, 5), row(2, 9), row(3, 5), row(4, 1)]);
  assert.deepEqual(ranked.map((r) => [r.userId, r.rank]), [[2, 1], [1, 2], [3, 2], [4, 4]]);
});

test('order inside a tie is stable: active days, then steps, then id', () => {
  const ranked = rankMembers([
    row(5, 3, { activeDays: 3, steps: 100 }), row(4, 3, { activeDays: 3, steps: 900 }), row(3, 3, { activeDays: 4 }),
  ]);
  assert.deepEqual(ranked.map((r) => r.userId), [3, 4, 5]);
});

test('team score is the average, so a bigger team does not win by size', () => {
  const teams = rankTeams([
    { teamId: 1, teamName: 'Big', score: 2 }, { teamId: 1, teamName: 'Big', score: 2 }, { teamId: 1, teamName: 'Big', score: 2 },
    { teamId: 2, teamName: 'Small', score: 5 },
    { teamId: null, teamName: null, score: 99 }, // people with no team are not a team
  ]);
  assert.deepEqual(teams.map((t) => [t.name, t.score, t.rank]), [['Small', 5, 1], ['Big', 2, 2]]);
});

test('colleagues are shown as first name + last initial; you see your own full name', () => {
  assert.equal(displayNameFor('Rohitashwa Singh', false), 'Rohitashwa S.');
  assert.equal(displayNameFor('Rohitashwa Singh', true), 'Rohitashwa Singh');
  assert.equal(displayNameFor('Aarav', false), 'Aarav');
  assert.equal(displayNameFor('  ', false), 'Member');
  assert.equal(displayNameFor(null, true), 'You');
});
