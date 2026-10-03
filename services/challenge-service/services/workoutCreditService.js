import { PrismaClient } from '@prisma/client';
import { creditCoinsService } from './coinLedgerService.js';
import { loadEconomyConfig } from './coinEconomyConfigService.js';
import { track } from '../utils/analytics.js';
const prisma = new PrismaClient();

function startOfDay(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
function endOfDay(date) {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

// The gamified layer's verification+credit step — one call from
// health-service when a WorkoutSession finishes (see health-service's
// implementation plan, "Gamified layer" section). Verification and
// crediting happen together, server-side, so health-service never needs to
// know the coin amount or reach into this service's CoinEconomyConfig
// directly — it only gets back { verified, credited, amount }.
//
// "Verified" means ANY AttendanceEventLog for this user today, regardless
// of source (booking, self-check-in, or attendance-SaaS member check-in) —
// the same unified signal booking-service already feeds into this table,
// reused rather than re-derived.
export async function verifyAndCreditWorkout({ userId, sessionId, description, idempotencyKey }) {
  const today = new Date();
  const hasAttendanceToday = await prisma.attendanceEventLog.findFirst({
    where: { userId, attendedAt: { gte: startOfDay(today), lte: endOfDay(today) } },
    select: { id: true },
  });
  if (!hasAttendanceToday) {
    track('workout_credited', userId, { verified: false, credited: false, amount: 0 });
    return { verified: false, credited: false, amount: 0 };
  }

  const { coinsPerVerifiedWorkout } = await loadEconomyConfig();
  if (coinsPerVerifiedWorkout <= 0) {
    track('workout_credited', userId, { verified: true, credited: false, amount: 0, economy_disabled: true });
    return { verified: true, credited: false, amount: 0 };
  }
  await creditCoinsService(userId, coinsPerVerifiedWorkout, description || 'Verified workout', idempotencyKey);
  track('workout_credited', userId, { verified: true, credited: true, amount: coinsPerVerifiedWorkout });
  return { verified: true, credited: true, amount: coinsPerVerifiedWorkout };
}
