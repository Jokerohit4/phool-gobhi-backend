import test from 'node:test';
import assert from 'node:assert/strict';
import { challengeActivity } from '../services/challengeActivityService.js';

const since = '2026-10-20T00:00:00Z';
const now = new Date('2026-10-28T00:00:00Z');

test('water and mood count distinct actual IST days, not backdated localDate or mood contents', async () => {
  let query;
  const read = async args => {
    query = args;
    return [{ createdAt: '2026-10-21T18:20:00Z' }, { createdAt: '2026-10-21T18:25:00Z' }, { createdAt: '2026-10-21T18:40:00Z' }];
  };
  const prisma = { waterLog: { findMany: read }, wellnessMoodCheckIn: { findMany: read } };
  for (const metric of ['water_consistency', 'mood_consistency']) {
    assert.deepEqual(await challengeActivity(prisma, { userId: 42, since, metric, now }), { count: 2 });
    assert.deepEqual(query.select, { createdAt: true });
    assert.equal(query.where.userId, 42);
    assert.equal(query.where.createdAt.gte.toISOString(), since.replace('Z', '.000Z'));
  }
});

test('workout progress excludes short sessions and requires attendance for linked-gym quests', async () => {
  let query;
  const prisma = { workoutSession: { findMany: async args => {
    query = args;
    return [
      { type: 'cardio', startedAt: '2026-10-21T08:00:00Z', endedAt: '2026-10-21T08:09:00Z' },
      { type: 'cardio', startedAt: '2026-10-22T08:00:00Z', endedAt: '2026-10-22T08:30:00Z' },
      { type: 'cardio', startedAt: '2026-10-22T09:00:00Z', endedAt: '2026-10-22T09:30:00Z' },
      { type: 'strength', startedAt: '2026-10-23T09:00:00Z', endedAt: '2026-10-23T09:30:00Z', exercises: [{ sets: [{ completed: false }] }] },
    ];
  } } };
  assert.deepEqual(await challengeActivity(prisma, { userId: 42, since, metric: 'workout_consistency', verifiedAttendance: true, now }), { count: 1 });
  assert.deepEqual(query.where.attendedAt, { not: null });
  assert.deepEqual(query.where.NOT, { type: 'rest' });
  assert.equal(query.select.type, true);
  assert.deepEqual(query.select.exercises.select.sets.select, { completed: true });
});

test('invalid user, future start, and unsupported metrics fail before database reads', async () => {
  for (const args of [{ userId: 0 }, { since: '2030-01-01' }, { metric: 'client_counter' }]) {
    await assert.rejects(challengeActivity({}, { userId: 42, since, metric: 'water_consistency', now, ...args }), error => error.status === 400);
  }
});
