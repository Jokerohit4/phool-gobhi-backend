// The sentence a guest hears when they scan the poster with a booking for another
// time: "Your session is tomorrow at 7:00 PM."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysFromToday, whenPhrase, shapeUpcomingBooking, describeUpcomingBooking } from '../utils/upcomingBooking.js';

const TODAY = '2026-11-11'; // a Wednesday

const sentence = (date, startTime) =>
  describeUpcomingBooking(shapeUpcomingBooking({ date, startTime, endTime: '23:00', status: 'confirmed' }, TODAY));

test('later today and tomorrow are said as words', () => {
  assert.equal(sentence('2026-11-11', '19:00'), 'Your session is today at 7:00 PM.');
  assert.equal(sentence('2026-11-12', '19:00'), 'Your session is tomorrow at 7:00 PM.');
});

test('further away it names the day and date', () => {
  assert.equal(sentence('2026-11-14', '06:30'), 'Your session is on Saturday 14 Nov at 6:30 AM.');
  assert.equal(sentence('2026-12-01', '18:00'), 'Your session is on Tuesday 1 Dec at 6:00 PM.');
});

test('midday and midnight read correctly', () => {
  assert.equal(sentence('2026-11-12', '12:00'), 'Your session is tomorrow at 12:00 PM.');
  assert.equal(sentence('2026-11-12', '00:30'), 'Your session is tomorrow at 12:30 AM.');
  assert.equal(sentence('2026-11-12', '09:05'), 'Your session is tomorrow at 9:05 AM.');
});

test('days are counted on the calendar, across month and year ends', () => {
  assert.equal(daysFromToday('2026-11-11', '2026-11-11'), 0);
  assert.equal(daysFromToday('2026-11-30', '2026-12-01'), 1);
  assert.equal(daysFromToday('2026-12-31', '2027-01-01'), 1);
  assert.equal(daysFromToday('2026-02-27', '2026-03-01'), 2);
  assert.equal(whenPhrase(1, '2026-12-01'), 'tomorrow', 'it follows the day count, not the date text');
});

test('the shaped booking carries what a client needs and no more', () => {
  const shaped = shapeUpcomingBooking(
    { date: '2026-11-12', startTime: '19:00', endTime: '20:00', status: 'confirmed', customerId: 7, price: 300, id: 9 },
    TODAY,
  );
  assert.deepEqual(shaped, { date: '2026-11-12', startTime: '19:00', endTime: '20:00', status: 'confirmed', daysFromToday: 1 });
});
