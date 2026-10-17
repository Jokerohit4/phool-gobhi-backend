// Qualification is shared by journey history and One Plan scoring. Only
// Prisma storage and booking-service I/O are mocked; the rules run for real.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let sessions = [], bookingDays = [], queries = [], bookingFails = false;
let isQualifyingSession, getShowedUpDays;
const base = {
  userId: 1, localDate: '2026-10-16', type: 'strength',
  startedAt: new Date('2026-10-16T08:00:00Z'),
  endedAt: new Date('2026-10-16T08:30:00Z'), exercises: [],
};
const withSet = (completed) => [{ sets: [{ id: 1, completed }] }];

test('setup: fake Prisma storage and booking I/O, import the real qualification service', async () => {
  mock.module('@prisma/client', { exports: { PrismaClient: class {
    workoutSession = { findMany: async (query) => {
      queries.push(query);
      const result = sessions.filter((s) => s.userId === query.where.userId
        && s.type != null && s.type !== 'rest' && s.endedAt != null
        && (!query.where.localDate?.gte || s.localDate >= query.where.localDate.gte));
      return result.map((s) => Object.fromEntries(Object.entries(query.select).map(([field, selection]) => {
        if (field !== 'exercises') return [field, s[field]];
        const setSelection = selection.select.sets;
        return [field, s.exercises.map((exercise) => ({ sets: exercise.sets
          .filter((set) => setSelection.where?.completed == null || set.completed === setSelection.where.completed)
          .map((set) => Object.fromEntries(Object.keys(setSelection.select).map((key) => [key, set[key]]))) }))];
      })));
    } };
  } } });
  mock.module(new URL('../utils/fetchInternal.js', import.meta.url).href, {
    exports: { fetchInternal: async () => {
      if (bookingFails) throw new Error('booking unavailable');
      return { data: { days: bookingDays } };
    } },
  });
  ({ isQualifyingSession, getShowedUpDays } = await import('../services/journey/showedUpDays.js'));
});

for (const [name, overrides, expected] of [
  ['completed set qualifies before ten minutes', { endedAt: new Date('2026-10-16T08:01:00Z'), exercises: withSet(true) }, true],
  ['incomplete set does not qualify before ten minutes', { endedAt: new Date('2026-10-16T08:01:00Z'), exercises: withSet(false) }, false],
  ['incomplete sets cannot use duration fallback', { exercises: withSet(false) }, false],
  ['missing completed field is not completed', { exercises: [{ sets: [{ id: 1 }] }] }, false],
  ['one completed set among incomplete sets qualifies', { exercises: [{ sets: [{ id: 1, completed: false }, { id: 2, completed: true }] }] }, true],
  ['no sets at ten minutes qualifies', { endedAt: new Date('2026-10-16T08:10:00Z') }, true],
  ['no sets below ten minutes does not qualify', { endedAt: new Date('2026-10-16T08:09:59Z') }, false],
  ['empty exercises with no sets qualify by duration', { exercises: [{ sets: [] }] }, true],
  ['unfinished session does not qualify', { endedAt: null, exercises: withSet(true) }, false],
  ['rest session does not qualify', { type: 'rest', exercises: withSet(true) }, false],
  ['missing type does not qualify', { type: null, exercises: withSet(true) }, false],
  ['invalid duration does not qualify', { startedAt: null }, false],
]) test(name, () => assert.equal(isQualifyingSession({ ...base, ...overrides }), expected));

test('show-up history uses the same qualification and retains incomplete-set evidence', async () => {
  queries = []; bookingDays = ['2026-10-15', '2026-10-15'];
  sessions = [
    { ...base, localDate: '2026-10-16', exercises: withSet(false) },
    { ...base, localDate: '2026-10-14', exercises: withSet(true) },
    { ...base, localDate: '2026-10-13', exercises: [] },
    { ...base, localDate: '2026-10-12', type: 'rest', exercises: withSet(true) },
    { ...base, localDate: '2026-10-11', endedAt: null, exercises: withSet(true) },
  ];
  assert.deepEqual(await getShowedUpDays(1), ['2026-10-15', '2026-10-14', '2026-10-13']);
  assert.equal(queries[0].select.type, true);
  assert.equal(queries[0].select.exercises.select.sets.select.completed, true);
  assert.equal(queries[0].select.exercises.select.sets.where, undefined);
});

test('history local-date fallback uses IST and merges booking days once', async () => {
  bookingDays = [];
  sessions = [{ ...base, localDate: null, startedAt: new Date('2026-10-15T19:00:00Z'),
    endedAt: new Date('2026-10-15T19:30:00Z') }];
  assert.deepEqual(await getShowedUpDays(1), ['2026-10-16']);
  bookingDays = ['2026-10-16'];
  assert.deepEqual(await getShowedUpDays(1), ['2026-10-16']);
});

test('history retains its date filter and uses only this user\'s qualifying sessions', async () => {
  queries = []; bookingDays = [];
  sessions = [
    { ...base, localDate: '2026-10-16', exercises: withSet(true) },
    { ...base, localDate: '2026-10-14', exercises: withSet(true) },
    { ...base, userId: 2, localDate: '2026-10-17', exercises: withSet(true) },
  ];
  assert.deepEqual(await getShowedUpDays(1, '2026-10-15'), ['2026-10-16']);
  assert.deepEqual(queries[0].where.localDate, { gte: '2026-10-15' });
});

test('booking outage retains locally qualified history', async () => {
  sessions = [{ ...base }]; bookingFails = true;
  try { assert.deepEqual(await getShowedUpDays(1), ['2026-10-16']); }
  finally { bookingFails = false; }
});

test('history still deduplicates, sorts newest first and caps at 90 days', async () => {
  sessions = [{ ...base }];
  bookingDays = Array.from({ length: 100 }, (_, i) =>
    new Date(Date.UTC(2026, 9, 16 - i)).toISOString().slice(0, 10));
  assert.deepEqual(await getShowedUpDays(1), bookingDays.slice(0, 90));
});
