import test from 'node:test';
import assert from 'node:assert/strict';
import { createMoodCheckIn } from '../services/wellnessMoodCheckInService.js';

const input = {userId: 350, localDate: '2026-10-28', slot: 'night', mood: 'Calm', factors: [], support: null, note: 'A note'};
for (const [name, instant, requestDate, storedDate] of [
  ['legacy client after midnight', '2026-10-27T19:43:00Z', '2026-10-28', '2026-10-27'],
  ['new client after midnight', '2026-10-27T19:43:00Z', '2026-10-27', '2026-10-27'],
  ['tonight is a separate slot', '2026-10-28T14:00:00Z', '2026-10-28', '2026-10-28'],
]) {
  test(name, async t => {
    t.mock.timers.enable({apis: ['Date'], now: new Date(instant)});
    const prisma = {wellnessMoodCheckIn: {create: async ({data}) => data}};
    const result = await createMoodCheckIn(prisma, {...input, localDate: requestDate});
    assert.equal(result.localDate, storedDate);
    assert.equal(result.note, input.note);
  });
}
test('5 AM closes the night window', async t => {
  t.mock.timers.enable({apis: ['Date'], now: new Date('2026-10-27T23:30:00Z')});
  await assert.rejects(createMoodCheckIn({}, input), e => e.code === 'CHECKIN_WINDOW_CLOSED');
});
test('morning window stays open until 3:30 PM IST', async t => {
  t.mock.timers.enable({apis: ['Date'], now: new Date('2026-10-28T09:59:00Z')});
  const prisma = {wellnessMoodCheckIn: {create: async ({data}) => data}};
  const result = await createMoodCheckIn(prisma, {...input, slot: 'morning'});
  assert.equal(result.slot, 'morning');
});
test('3:30 PM closes the morning window', async t => {
  t.mock.timers.enable({apis: ['Date'], now: new Date('2026-10-28T10:00:00Z')});
  await assert.rejects(
    createMoodCheckIn({}, {...input, slot: 'morning'}),
    e => e.code === 'CHECKIN_WINDOW_CLOSED',
  );
});
test('arbitrary older dates remain blocked', async t => {
  t.mock.timers.enable({apis: ['Date'], now: new Date('2026-10-27T19:43:00Z')});
  await assert.rejects(createMoodCheckIn({}, {...input,localDate:'2026-10-26'}), e => e.code === 'MOOD_CHECKIN_DATE_CLOSED');
});
