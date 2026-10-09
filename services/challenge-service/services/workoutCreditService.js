import { PrismaClient } from '@prisma/client';
import { creditCoinsService } from './coinLedgerService.js';
import { loadEconomyConfig } from './coinEconomyConfigService.js';
import { track } from '../utils/analytics.js';
const prisma = new PrismaClient();

// Every check-in this service ever sees happened in India, so the day that
// matters is the IST day. On the UTC day a 05:00 IST check-in sat in
// "yesterday's" window, so the early-morning gym-goer — exactly the person
// this reward exists for — was told their session didn't count. India
// observes no DST, so the offset is a constant and the arithmetic needs no
// ICU data (same reasoning as health-service's localDateIST).
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// The IST calendar day `date` falls on, as an inclusive window plus a
// YYYY-MM-DD key for idempotency. Derived by shifting into "IST wall clock
// as if it were UTC", flooring to the day, and shifting back.
function istDay(date) {
  const istMidnightUtc = Math.floor((date.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS;
  return {
    key: new Date(istMidnightUtc).toISOString().slice(0, 10),
    start: new Date(istMidnightUtc - IST_OFFSET_MS),
    end: new Date(istMidnightUtc + DAY_MS - 1 - IST_OFFSET_MS),
  };
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
//
// Two holes closed here (audit 2026-10-08, P1s):
//   1. Coins once paid per *session*, keyed on the caller's session id, so a
//      single check-in funded an unlimited number of finishes — dismissal of
//      the quick-log sheet counted as a finish. The ledger key is now the
//      IST day, so the first verified workout of the day pays and every
//      later one is an idempotent replay (creditCoinsService re-checks the
//      same key, so even two concurrent finishes can't both pay).
//   2. The attendance window was UTC-based (see IST_OFFSET_MS above).
//
// `now` is injectable purely so tests can pin the clock; every caller uses
// the default.
export async function verifyAndCreditWorkout({ userId, sessionId, description, idempotencyKey, now = new Date() }) {
  const day = istDay(now);
  const hasAttendanceToday = await prisma.attendanceEventLog.findFirst({
    where: { userId, attendedAt: { gte: day.start, lte: day.end } },
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

  const dailyKey = `workout-credit:${userId}:${day.key}`;
  const paidToday = await prisma.coinLedgerEntry.findUnique({ where: { idempotencyKey: dailyKey } });
  if (paidToday && paidToday.userId === userId) {
    // Verified, but today's coins are already spent — reported as "not
    // credited" so the app stays silent instead of promising a payment the
    // ledger won't make. Narrow race window between this check and the
    // credit below is closed by creditCoinsService's own key re-check.
    track('workout_credited', userId, { verified: true, credited: false, amount: 0, daily_cap: true, day: day.key, caller_key: idempotencyKey ?? null });
    return { verified: true, credited: false, amount: 0 };
  }

  await creditCoinsService(userId, coinsPerVerifiedWorkout, description || 'Verified workout', dailyKey);
  track('workout_credited', userId, { verified: true, credited: true, amount: coinsPerVerifiedWorkout, day: day.key, caller_key: idempotencyKey ?? null });
  return { verified: true, credited: true, amount: coinsPerVerifiedWorkout };
}
