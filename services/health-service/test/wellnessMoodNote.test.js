import test from 'node:test';
import assert from 'node:assert/strict';
import { createMoodCheckIn } from '../services/wellnessMoodCheckInService.js';

// 09:59 UTC is 15:29 IST: inside the morning window, so only the note is under test.
const base = {
  userId: 350, localDate: '2026-10-28', slot: 'morning', mood: 'Calm', factors: [], support: null,
};
const prisma = { wellnessMoodCheckIn: { create: async ({ data }) => data } };
const open = (t) => t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-28T09:59:00Z') });

test('a check-in can be saved with an empty note', async (t) => {
  open(t);
  const result = await createMoodCheckIn(prisma, { ...base, note: '' });
  assert.equal(result.note, '');
});

test('a check-in can be saved with no note at all', async (t) => {
  open(t);
  const result = await createMoodCheckIn(prisma, { ...base });
  assert.equal(result.note, '');
});

test('a note of only spaces is stored as empty', async (t) => {
  open(t);
  const result = await createMoodCheckIn(prisma, { ...base, note: '   \n ' });
  assert.equal(result.note, '');
});

test('a written note is kept and trimmed', async (t) => {
  open(t);
  const result = await createMoodCheckIn(prisma, { ...base, note: '  Rough afternoon ' });
  assert.equal(result.note, 'Rough afternoon');
});

test('a note of exactly 500 characters is accepted, 501 is not', async (t) => {
  open(t);
  const ok = await createMoodCheckIn(prisma, { ...base, note: 'a'.repeat(500) });
  assert.equal(ok.note.length, 500);
  await assert.rejects(
    createMoodCheckIn(prisma, { ...base, note: 'a'.repeat(501) }),
    (e) => e.status === 400 && e.code === 'INVALID_MOOD_NOTE',
  );
});

test('a note that is not text is still rejected', async (t) => {
  open(t);
  await assert.rejects(
    createMoodCheckIn(prisma, { ...base, note: 42 }),
    (e) => e.status === 400 && e.code === 'INVALID_MOOD_NOTE',
  );
});
