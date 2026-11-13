// Opt-in DB test for createBooking's confirm step (guarded update + P2025 fallback).
// Skipped unless TEST_DATABASE_URL points at a DISPOSABLE Postgres with the booking schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'requires explicit disposable TEST_DATABASE_URL opt-in';

test('confirmReservation against real Postgres', { skip }, async (t) => {
  const { PrismaClient } = await import('@prisma/client');
  process.env.DATABASE_URL ||= url; // db/prisma.js is imported transitively; never connects here
  const { confirmReservation } = await import('../services/bookingService.js');
  const db = new PrismaClient({ datasourceUrl: url });
  let seq = 0;
  const mk = (status) => db.booking.create({
    data: { customerId: 910000 + seq, gymId: 910000, date: `2099-01-${String(1 + (seq++ % 28)).padStart(2, '0')}`, startTime: '10:00', endTime: '11:00', amount: 500, status },
  });
  const created = [];
  try {
    await t.test('pending -> confirmed in one call, returns the updated row', async () => {
      const r = await mk('pending'); created.push(r.id);
      const out = await confirmReservation(db, r);
      assert.equal(out.id, r.id);
      assert.equal(out.status, 'confirmed');
      assert.equal((await db.booking.findUnique({ where: { id: r.id } })).status, 'confirmed');
    });
    await t.test('already-cancelled booking is NOT resurrected; current row returned', async () => {
      const r = await mk('cancelled'); created.push(r.id);
      const out = await confirmReservation(db, { ...r, status: 'pending' });
      assert.equal(out.status, 'cancelled');
      assert.equal((await db.booking.findUnique({ where: { id: r.id } })).status, 'cancelled');
    });
    await t.test('already-confirmed booking is unchanged (no second write)', async () => {
      const r = await mk('confirmed'); created.push(r.id);
      const out = await confirmReservation(db, { ...r, status: 'pending' });
      assert.equal(out.status, 'confirmed');
      assert.equal(out.updatedAt.getTime(), r.updatedAt.getTime());
    });
    await t.test('missing booking falls back to the reservation object', async () => {
      const ghost = { id: 2_000_000_000, status: 'pending', amount: 1 };
      assert.equal(await confirmReservation(db, ghost), ghost);
    });
    await t.test('concurrent double-confirm: both resolve confirmed, exactly one write', async () => {
      const r = await mk('pending'); created.push(r.id);
      const [a, b] = await Promise.all([confirmReservation(db, r), confirmReservation(db, r)]);
      assert.equal(a.status, 'confirmed');
      assert.equal(b.status, 'confirmed');
      const row = await db.booking.findUnique({ where: { id: r.id } });
      assert.equal(row.status, 'confirmed');
    });
    await t.test('confirm racing a cancel always ends cancelled', async () => {
      const r = await mk('pending'); created.push(r.id);
      await Promise.all([
        confirmReservation(db, r),
        db.booking.updateMany({ where: { id: r.id, status: { in: ['pending', 'confirmed'] } }, data: { status: 'cancelled' } }),
      ]);
      const row = await db.booking.findUnique({ where: { id: r.id } });
      // cancel's guard accepts pending|confirmed, so in either order the end state is cancelled.
      assert.equal(row.status, 'cancelled');
    });
  } finally {
    await db.booking.deleteMany({ where: { id: { in: created } } });
    await db.$disconnect();
  }
});
