// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const events = [];
let nextId = 1;
let createFails = false;
let notified = [];
let notifyAnswer = { released: 0 };

const istMs = (h, m = 0, day = 12) => Date.UTC(2026, 10, day, h, m) - 5.5 * 3600000;

let recordPresence, openPresence, checkOutByScan, liveSnapshot;

test('setup', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.gymPresenceEvent = {
            create: async ({ data }) => {
              if (createFails) throw new Error('db down');
              const row = { id: nextId++, ...data };
              events.push(row);
              return row;
            },
            findMany: async ({ where }) => events
              .filter((e) => (where.gymId == null || e.gymId === where.gymId)
                && (where.customerId == null || e.customerId === where.customerId)
                && (where.date == null || e.date === where.date)
                && (where.at == null || (e.at >= where.at.gte && e.at < where.at.lt)))
              .sort((a, b) => a.at - b.at),
          };
        }
      },
      Prisma: {},
    },
  });
  t.mock.module(new URL('../utils/notifyPresence.js', import.meta.url).href, {
    exports: { notifyPresence: async (p) => { notified.push(p); return notifyAnswer; } },
  });
  ({ recordPresence, openPresence, checkOutByScan, liveSnapshot } = await import('../services/presenceService.js'));
});

function reset() { events.length = 0; nextId = 1; createFails = false; notified = []; notifyAnswer = { released: 0 }; }

test('recording an arrival stores the IST day and tells challenge-service', async () => {
  reset();
  const at = new Date(istMs(23, 50, 12)); // 23:50 IST on the 12th = 18:20 UTC
  const { event } = await recordPresence({ gymId: 2, customerId: 7, kind: 'in', source: 'member', method: 'checkin', at });
  assert.equal(event.date, '2026-11-12');
  assert.equal(notified.length, 1);
  assert.equal(notified[0].state, 'in');
  assert.equal(notified[0].userId, 7);
});

test('a log that cannot be written never throws into the check-in', async () => {
  reset();
  createFails = true;
  const out = await recordPresence({ gymId: 2, customerId: 7, kind: 'in', source: 'member', method: 'checkin' });
  assert.equal(out.event, null);
  assert.equal(notified.length, 0);
});

test('openPresence: in, then out, then in again', async () => {
  reset();
  const now = istMs(19);
  await recordPresence({ gymId: 2, customerId: 7, kind: 'in', source: 'booking', method: 'checkin', bookingId: 5, at: new Date(istMs(17)) });
  let p = await openPresence(7, 2, now);
  assert.equal(p.inside, true);
  assert.equal(p.source, 'booking');
  assert.equal(p.bookingId, 5);
  await recordPresence({ gymId: 2, customerId: 7, kind: 'out', source: 'booking', method: 'tap', at: new Date(istMs(18)) });
  p = await openPresence(7, 2, now);
  assert.equal(p.inside, false);
  assert.equal(p.hasEventsToday, true);
  await recordPresence({ gymId: 2, customerId: 7, kind: 'in', source: 'booking', method: 'checkin', at: new Date(istMs(18, 30)) });
  assert.equal((await openPresence(7, 2, now)).inside, true);
});

test('openPresence ignores another gym and another day', async () => {
  reset();
  await recordPresence({ gymId: 3, customerId: 7, kind: 'in', source: 'member', method: 'checkin', at: new Date(istMs(17)) });
  await recordPresence({ gymId: 2, customerId: 7, kind: 'in', source: 'member', method: 'checkin', at: new Date(istMs(17, 0, 11)) });
  assert.equal((await openPresence(7, 2, istMs(18))).inside, false);
});

test('checkOutByScan closes the visit, reports the stay and the coins released', async () => {
  reset();
  await recordPresence({ gymId: 2, customerId: 7, kind: 'in', source: 'member', method: 'checkin', at: new Date(istMs(17)) });
  notified = [];
  notifyAnswer = { released: 15 };
  const out = await checkOutByScan({ gymId: 2, customerId: 7, now: new Date(istMs(18, 15)) });
  assert.equal(out.kind, 'checkout');
  assert.equal(out.minutesInside, 75);
  assert.equal(out.coinsReleased, 15);
  assert.equal(notified[0].state, 'out');
  assert.equal(notified[0].method, 'scan');
  assert.equal(events.at(-1).method, 'scan');
  assert.equal((await openPresence(7, 2, istMs(18, 20))).inside, false);
});

test('checkOutByScan when not inside is refused and records nothing', async () => {
  reset();
  await assert.rejects(checkOutByScan({ gymId: 2, customerId: 7, now: new Date(istMs(18)) }), (e) => e.code === 'NOT_INSIDE');
  assert.equal(events.length, 0);
});

test('liveSnapshot: who is in, the recent flow, hourly counts, and no duplicates after a return', async () => {
  reset();
  const now = istMs(19);
  const add = (customerId, kind, h, m, source = 'member') =>
    recordPresence({ gymId: 2, customerId, kind, source, method: kind === 'in' ? 'checkin' : 'scan', at: new Date(istMs(h, m)) });
  await add(1, 'in', 17, 0);
  await add(2, 'in', 17, 10, 'booking');
  await add(1, 'out', 17, 50);
  await add(3, 'in', 18, 0);
  await add(1, 'in', 18, 30);
  const snap = await liveSnapshot(2, { nowMs: now, nameOf: async (ids) => Object.fromEntries(ids.map((i) => [i, { name: `P${i}` }])) });
  assert.equal(snap.insideCount, 3);
  assert.deepEqual(snap.inside.map((p) => p.customerId), [2, 3, 1]); // longest inside first
  assert.equal(snap.inside[0].kind, 'guest');
  assert.equal(snap.inside[0].name, 'P2');
  assert.equal(snap.recent[0].direction, 'in'); // newest first
  assert.equal(snap.recent[0].customerId, 1);
  assert.equal(snap.today.arrivals, 4);
  assert.equal(snap.today.departures, 1);
  assert.equal(snap.today.hours[17].arrivals, 2);
});

test('liveSnapshot compares now with the usual for this weekday and hour', async () => {
  reset();
  // The same weekday and hour a week earlier: 5 people were in during 18:00-19:00.
  for (let i = 1; i <= 5; i++) {
    await recordPresence({ gymId: 2, customerId: 100 + i, kind: 'in', source: 'member', method: 'checkin', at: new Date(istMs(18, 0, 5)) });
    await recordPresence({ gymId: 2, customerId: 100 + i, kind: 'out', source: 'member', method: 'scan', at: new Date(istMs(19, 0, 5)) });
  }
  const snap = await liveSnapshot(2, { nowMs: istMs(18, 30) });
  assert.ok(snap.usualNow, 'there is history for this hour');
  assert.equal(snap.usualNow.hour, 18);
  assert.ok(snap.usualNow.avgPresent > 0);
  assert.ok(snap.heat.cells.length > 0);
});
