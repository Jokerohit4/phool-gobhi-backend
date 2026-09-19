// The attendance summary the model is given. Run with:
//   node --experimental-test-module-mocks --test
//
// This is the only thing in the prompt that describes how this person actually
// behaves, and habit coaching is pattern work — so the properties worth
// pinning are that a real pattern survives the reduction, that a pattern which
// is not there is never invented, and that none of it is computed in the wrong
// timezone.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let summariseAttendance;

test('setup: stub Prisma, import the service once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: { PrismaClient: class {}, Prisma: {} },
  });
  ({ summariseAttendance } = await import('../services/assistant/contextService.js'));
});

// Builds an event at a given IST wall-clock hour, N days ago, expressed as the
// UTC instant the backend would actually store.
function at(daysAgo, istHour, istMinute = 0) {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  ist.setUTCDate(ist.getUTCDate() - daysAgo);
  ist.setUTCHours(istHour, istMinute, 0, 0);
  return { attendedAt: new Date(ist.getTime() - 5.5 * 3600 * 1000).toISOString() };
}

test('no history says so plainly', () => {
  assert.match(summariseAttendance([]), /No gym check-ins/);
});

test('a real weekly pattern survives the reduction', () => {
  // Eight sessions, every Mon/Wed/Sat-ish, all early morning IST.
  const events = [0, 2, 5, 7, 9, 12, 14, 16].map((d) => at(d, 7));
  const out = summariseAttendance(events);

  assert.match(out, /Trained on 8 days in the last 30/);
  assert.match(out, /about 1\.9 a week/);
  // The whole point: a time-of-day habit reaches the model at all.
  assert.match(out, /mostly in the mornings/);
});

test('an early-morning IST session is not reported as late night', () => {
  // 07:00 IST is 01:30 UTC. Read in UTC this is "late at night" and lands on
  // the previous weekday — the bug this test exists to prevent.
  const out = summariseAttendance([0, 1, 2, 3, 4, 5, 6].map((d) => at(d, 7)));
  assert.match(out, /mostly in the mornings/);
  assert.doesNotMatch(out, /late at night/);
});

test('a late-evening IST session is not reported as midday', () => {
  // 22:30 IST is 17:00 UTC — which would read as "in the evenings".
  const out = summariseAttendance([0, 1, 2, 3, 4, 5, 6].map((d) => at(d, 22, 30)));
  assert.match(out, /late at night/);
});

test('too little history claims no pattern at all', () => {
  // Three sessions cannot establish a weekday habit, and asserting one would
  // make the coach confidently wrong about the thing it should know best.
  const out = summariseAttendance([at(0, 7), at(3, 7), at(6, 7)]);
  assert.match(out, /Trained on 3 days/);
  assert.doesNotMatch(out, /Usually/);
  assert.doesNotMatch(out, /Longest break/);
});

test('a split routine claims no time-of-day habit', () => {
  // Half mornings, half evenings — no dominant bucket, so none is reported.
  const events = [
    at(0, 7), at(2, 7), at(4, 7),
    at(6, 19), at(8, 19), at(10, 19),
  ];
  const out = summariseAttendance(events);
  assert.match(out, /Trained on 6 days/);
  assert.doesNotMatch(out, /mostly/);
});

test('two sessions in one day count as one training day', () => {
  const out = summariseAttendance([at(1, 7), at(1, 19), at(3, 7)]);
  assert.match(out, /Trained on 2 days/);
});

test('a long lapse is surfaced, a short one is not', () => {
  // 0,1,2,3,4 then a jump to 18 — an 14-day break worth naming.
  const withGap = summariseAttendance([0, 1, 2, 3, 4, 18].map((d) => at(d, 7)));
  assert.match(withGap, /Longest break 14 days/);

  // Consecutive days: the largest gap is 1, which is not a lapse.
  const noGap = summariseAttendance([0, 1, 2, 3, 4, 5].map((d) => at(d, 7)));
  assert.doesNotMatch(noGap, /Longest break/);
});

test('recency is reported relative to the most recent session, not the first row', () => {
  // Deliberately unsorted — the old implementation sorted first; this one
  // takes a max, and the ordering of the input must not matter.
  const out = summariseAttendance([at(9, 7), at(1, 7), at(5, 7)]);
  assert.match(out, /Last session yesterday/);
});

test('no dates, gym names or raw timestamps reach the model', () => {
  // The reduction is also the minimisation: whatever else changes here, the
  // block must stay an aggregate.
  const out = summariseAttendance([0, 2, 4, 6, 8, 10].map((d) => at(d, 7)));
  assert.doesNotMatch(out, /\d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(out, /T\d{2}:\d{2}/);
});
