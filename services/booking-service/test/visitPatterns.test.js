import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeVisitPatterns, weekStartOf, daysBetween, minutesOfDayIST } from '../utils/visitPatterns.js';
import { IST_OFFSET_MS } from '../utils/slotTiming.js';

// The instant a given IST wall-clock time happens.
const ist = (date, hhmm) => {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS);
};
const visit = (date, hhmm, extra = {}) => ({ date, at: ist(date, hhmm), kind: 'member', ...extra });
const TODAY = '2026-11-11'; // a Wednesday
const run = (visits, windowDays = 90) => summarizeVisitPatterns(visits, { today: TODAY, windowDays });

test('no visits gives an empty, well-formed summary', () => {
  const s = run([]);
  assert.equal(s.totalVisits, 0);
  assert.equal(s.lastVisitAt, null);
  assert.equal(s.daysSinceLastVisit, null);
  assert.equal(s.usualHour, null);
  assert.equal(s.peakHour, null);
  assert.equal(s.avgVisitsPerWeek, 0);
  assert.equal(s.avgDurationMinutes, null);
  assert.equal(s.hourly.length, 24);
  assert.equal(s.weekdays.length, 7);
  assert.equal(s.weekly.length, 8);
  assert.ok(s.weekly.every((w) => w.visits === 0));
  assert.deepEqual(s.recent, []);
});

test('time of day is read in IST, not UTC', () => {
  // 01:00 IST is 19:30 UTC the day before — it must land in hour 1, not hour 19.
  assert.equal(minutesOfDayIST(ist('2026-11-10', '01:00')), 60);
  const s = run([visit('2026-11-10', '01:00')]);
  assert.equal(s.hourly[1], 1);
  assert.equal(s.hourly[19], 0);
  assert.equal(s.recent[0].time, '01:00');
});

test('a consistent early-morning member has a usual hour', () => {
  const s = run(['06:45', '07:00', '07:10', '07:20', '06:55'].map((t, i) => visit(`2026-11-0${i + 1}`, t)));
  assert.equal(s.usualHour, 7);
  assert.equal(s.consistency, 1);
  assert.equal(s.peakHour, 7);
  assert.equal(s.timeOfDay.morning, 5);
});

test('a member who comes at all hours has no usual hour, only a peak', () => {
  const s = run([visit('2026-11-01', '07:00'), visit('2026-11-02', '13:00'), visit('2026-11-03', '19:00')]);
  assert.equal(s.usualHour, null);
  assert.equal(s.peakHour, 7, 'ties go to the earliest hour');
  assert.deepEqual([s.timeOfDay.morning, s.timeOfDay.afternoon, s.timeOfDay.evening], [1, 1, 1]);
});

test('fewer than three visits is not a pattern, however alike they are', () => {
  const s = run([visit('2026-11-01', '07:00'), visit('2026-11-02', '07:05')]);
  assert.equal(s.usualHour, null);
  assert.equal(s.peakHour, 7);
});

test('time-of-day buckets cover the whole day', () => {
  const s = run([
    ['2026-11-01', '05:00'], ['2026-11-02', '11:59'], ['2026-11-03', '12:00'], ['2026-11-04', '16:59'],
    ['2026-11-05', '17:00'], ['2026-11-06', '20:59'], ['2026-11-07', '21:00'], ['2026-11-08', '04:59'],
  ].map(([d, t]) => visit(d, t)));
  assert.deepEqual(s.timeOfDay, { morning: 2, afternoon: 2, evening: 2, night: 2 });
});

test('two scans on one day are one visit-day', () => {
  const s = run([visit('2026-11-10', '07:00'), visit('2026-11-10', '18:00')]);
  assert.equal(s.totalVisits, 2);
  assert.equal(s.daysVisited, 1);
  assert.equal(s.visitsLast7Days, 1);
});

test('the 7 and 30 day counts have exact edges', () => {
  const s = run([
    visit('2026-11-11', '07:00'), // today
    visit('2026-11-05', '07:00'), // 6 days ago: in
    visit('2026-11-04', '07:00'), // 7 days ago: out
    visit('2026-10-13', '07:00'), // 29 days ago: in 30
    visit('2026-10-12', '07:00'), // 30 days ago: out
  ]);
  assert.equal(s.visitsLast7Days, 2);
  assert.equal(s.visitsLast30Days, 4);
});

test('the weekly rate uses the time since first visit, not the whole window', () => {
  // First visit 14 days ago -> a 15-day span; 6 visit-days in it.
  const dates = ['2026-10-28', '2026-10-30', '2026-11-02', '2026-11-04', '2026-11-06', '2026-11-09'];
  assert.equal(run(dates.map((d) => visit(d, '07:00'))).avgVisitsPerWeek, 2.8);
  // A member who just joined is not scored against months they were not here.
  assert.equal(run([visit(TODAY, '07:00')]).avgVisitsPerWeek, 1);
});

test('preferred days are the weekdays they repeat on', () => {
  // 2026-11-02, 11-09 and 10-26 are Mondays; 11-05 and 10-29 are Thursdays; 11-08 is a Sunday.
  const s = run(['2026-11-02', '2026-11-09', '2026-10-26', '2026-11-05', '2026-10-29', '2026-11-08'].map((d) => visit(d, '07:00')));
  assert.deepEqual(s.preferredDays, [1, 4], 'Monday (3) then Thursday (2); a single Sunday is not a habit');
  assert.equal(s.weekdays[0], 1);
  assert.equal(s.weekdays[1], 3);
});

test('the weekly trend runs oldest to newest and keeps empty weeks', () => {
  assert.equal(weekStartOf('2026-11-11'), '2026-11-09', 'weeks start on Monday');
  assert.equal(weekStartOf('2026-11-08'), '2026-11-02', 'a Sunday belongs to the week before');
  const s = run([visit('2026-11-11', '07:00'), visit('2026-11-10', '07:00'), visit('2026-11-04', '07:00')]);
  assert.equal(s.weekly.length, 8);
  assert.equal(s.weekly[0].weekStart, '2026-09-21');
  assert.equal(s.weekly[7].weekStart, '2026-11-09');
  assert.equal(s.weekly[7].visits, 2);
  assert.equal(s.weekly[6].visits, 1);
  assert.equal(s.weekly[5].visits, 0, 'a lapse is a dip, not a gap');
});

test('last visit and days since', () => {
  const s = run([visit('2026-11-01', '07:00'), visit('2026-11-08', '18:30')]);
  assert.equal(s.lastVisitDate, '2026-11-08');
  assert.equal(s.firstVisitDate, '2026-11-01');
  assert.equal(s.daysSinceLastVisit, 3);
  assert.equal(s.lastVisitAt, ist('2026-11-08', '18:30').toISOString());
  assert.equal(run([visit(TODAY, '06:00')]).daysSinceLastVisit, 0);
});

test('visits dated in the future are ignored', () => {
  const s = run([visit('2026-11-12', '07:00'), visit('2026-11-10', '07:00')]);
  assert.equal(s.totalVisits, 1);
  assert.equal(s.lastVisitDate, '2026-11-10');
});

test('average duration only counts believable check-outs', () => {
  const at = ist('2026-11-10', '07:00');
  // Each check-out is offset from that visit's own check-in.
  const mk = (date, minutes) => visit(date, '07:00', { checkedOutAt: new Date(ist(date, '07:00').getTime() + minutes * 60000) });
  assert.equal(run([mk('2026-11-10', 60), mk('2026-11-09', 90)]).avgDurationMinutes, 75);
  assert.equal(run([mk('2026-11-10', 60), visit('2026-11-09', '07:00')]).avgDurationMinutes, 60, 'visits without a check-out are left out of the average');
  assert.equal(run([visit('2026-11-10', '07:00')]).avgDurationMinutes, null, 'never checked out');
  const bad = [
    visit('2026-11-10', '07:00', { checkedOutAt: new Date(at.getTime() - 60000) }), // before check-in
    visit('2026-11-09', '07:00', { checkedOutAt: ist('2026-11-10', '07:00') }),      // a day later: forgot to tap out
  ];
  assert.equal(run(bad).avgDurationMinutes, null);
});

test('recent visits are newest first, capped at ten, with kind and IST time', () => {
  const visits = Array.from({ length: 12 }, (_, i) => visit(`2026-11-${String(i + 1).padStart(2, '0')}`, '07:00', { kind: i === 11 ? 'booking' : 'member' }));
  const s = run(visits);
  assert.equal(s.recent.length, 10);
  assert.deepEqual(s.recent[0], { date: '2026-11-11', time: '07:00', kind: 'member' });
  assert.equal(s.totalVisits, 11, 'the 12th is dated tomorrow and ignored');
});

test('daysBetween is signed and calendar-based', () => {
  assert.equal(daysBetween('2026-11-01', '2026-11-11'), 10);
  assert.equal(daysBetween('2026-11-11', '2026-11-01'), -10);
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1);
});
