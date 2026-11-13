import prisma from '../db/prisma.js';
import { verifyAndCreditWorkout } from './workoutCreditService.js';
import { track } from '../utils/analytics.js';

// Applies what booking-service tells us about a person coming in or going out.
//
//   in            -> they are inside; workouts they finish are held.
//   out by scan   -> they proved they were at the gym and left: held credits for
//                    the day are paid. Returns the coins released.
//   out by tap or auto -> they are no longer inside, so later workouts are not
//                    held, but nothing already held is paid: the poster was not
//                    scanned.
//
// An exit for a different gym than the one they are marked inside of is ignored:
// it cannot be about this visit.
export async function applyPresence({ userId, gymId, state, method, at, date }) {
  const since = new Date(at);
  const existing = await prisma.gymPresence.findUnique({ where: { userId } });
  if (state === 'in') {
    await prisma.gymPresence.upsert({
      where: { userId },
      create: { userId, gymId, state: 'in', since, day: date, method },
      update: { gymId, state: 'in', since, day: date, method },
    });
    return { released: 0 };
  }
  if (existing && existing.state === 'in' && existing.gymId !== gymId) return { released: 0 };
  await prisma.gymPresence.upsert({
    where: { userId },
    create: { userId, gymId, state: 'out', since, day: date, method },
    update: { state: 'out', method },
  });
  if (method !== 'scan') return { released: 0 };
  return { released: await releaseHeldCredits(userId, date) };
}

async function releaseHeldCredits(userId, day) {
  const held = await prisma.heldWorkoutCredit.findMany({
    where: { userId, day, releasedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  let released = 0;
  for (const row of held) {
    const p = row.payload || {};
    try {
      const result = await verifyAndCreditWorkout({
        userId, sessionId: p.sessionId, description: p.description ?? undefined,
        idempotencyKey: p.idempotencyKey ?? undefined, routinePolicy: p.routinePolicy ?? undefined,
        // Judged as of the moment the workout finished, not the moment of release.
        now: p.finishedAt ? new Date(p.finishedAt) : undefined,
        checkoutGate: false,
      });
      released += result.amount || 0;
      await prisma.heldWorkoutCredit.update({ where: { id: row.id }, data: { releasedAt: new Date() } });
    } catch (err) {
      // Left unreleased, so the next scan-out retries it.
      console.error('[presence] could not release a held workout credit', row.id, err.message);
    }
  }
  if (released > 0) track('workout_credit_released', userId, { amount: released, day });
  return released;
}
