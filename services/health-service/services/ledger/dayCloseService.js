// Who decides which day it is, and the server's nightly close.
//
// Before this, closing a day was entirely client-driven: the app pressed
// "close today" and sent `today` itself, and the server believed it. For a
// personal chart that is harmless. For a ledger whose whole claim is "frozen and
// auditable" it is the weakest link - a phone with its clock moved forward
// could freeze days that have not happened yet, and a day nobody closed simply
// never got a snapshot, so a missed day and a skipped day looked the same.
//
// Two changes, both here:
//   1. The server decides "today". A client close is still honoured - it is a
//      deliberate button in the app and freezing your own day early is a
//      legitimate choice - but only for a day that is today or earlier by the
//      server's IST clock, and the `today` the engine scores against is always
//      the server's, never the request's.
//   2. The server closes yesterday itself, for every ledger user who has not,
//      so every day ends up with exactly one frozen row regardless of whether
//      the app was opened. Idempotency is inherited from closeDay: an existing
//      snapshot is returned, never rewritten, and a racing insert resolves to
//      the winner (see scoreService.closeDay).
//
// Who closed a day (client vs server) is NOT recorded. The design doc
// (ABHA-FHIR-INTEGRATION.md §F.5) does not ask for it, and it would be a schema
// change to a table whose rows are frozen by contract. What an auditor needs -
// that the day was closed by the server's clock and not the phone's - is now
// true for every close, whichever side triggered it.
//
// IST is hardcoded for the same reason it is everywhere else in this service:
// every user is in India today. The design doc's answer for the first non-IST
// user is one IANA timeZone per user (§F.1), not a per-row offset; when that
// lands, a per-user zone replaces this constant.
import { closeDay } from './scoreService.js';
import { isScopeStale, NUTRITION_SCOPE } from './ledgerConsentService.js';
import { evaluateUserReward } from '../rewardService.js';

const TZ = 'Asia/Kolkata';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function localDateIST(date) {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: TZ });
}

export function serverTodayIST(now = new Date()) {
  return localDateIST(now);
}

// The IST day before `now`. Subtracting 24h from the instant and then reading
// the IST date is correct here because IST has no DST: there is no day that is
// 23 or 25 hours long for this arithmetic to trip over.
export function yesterdayIST(now = new Date()) {
  return localDateIST(new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000));
}

/**
 * Validate a client-requested close and return the server's `today`.
 *
 * Throws 400 for a malformed date and for any day after the server's today.
 * A past day is allowed: closing last Tuesday is how a user who forgot to close
 * it gets it frozen, and the nightly sweep would close it anyway.
 */
export function resolveClientClose({ localDate, now = new Date() }) {
  if (typeof localDate !== 'string' || !DAY_RE.test(localDate)) {
    throw { status: 400, error: 'localDate must be YYYY-MM-DD', code: 'INVALID_DATE' };
  }
  const today = serverTodayIST(now);
  if (localDate > today) {
    throw {
      status: 400,
      error: 'That day has not happened yet, so it cannot be closed.',
      code: 'FUTURE_DAY',
    };
  }
  return { today };
}

/**
 * Close yesterday (IST) for every eligible ledger user. Safe to re-run.
 *
 * Eligible = device health consent live, nutrition scope granted under the
 * CURRENT wording, and a HealthGoal row (the ledger was actually set up).
 *   - The consent rule mirrors requireNutritionConsent. A stale grant stops the
 *     ledger collecting for that person, and freezing a new day for them is
 *     collecting; the nightly job must not be a side door around the gate a
 *     request would hit.
 *   - The goal rule keeps the sweep from minting a row of zeros every night for
 *     someone who granted consent and never opened the ledger. A user who DID
 *     set up and then did nothing gets a real 0 - that is the ledger working.
 *
 * Sequential, not Promise.all: this runs against a Neon compute budget that has
 * been exhausted once already, and the user count makes serial fine.
 */
export async function runDayCloseSweep(prisma, { now = new Date(), isEnabled } = {}) {
  const localDate = yesterdayIST(now);
  const today = serverTodayIST(now);
  const result = { localDate, eligible: 0, closed: 0, alreadyClosed: 0, skipped: 0, failed: 0, disabled: false };

  // Both flags, because both gate every ledger route. With either off the
  // ledger does not exist for anyone, and the sweep writing rows would make it
  // exist anyway. `isEnabled` is required rather than defaulted to "on": a
  // caller that forgets to pass it gets a no-op, not an ungated write.
  if (typeof isEnabled !== 'function') return { ...result, disabled: true };
  if (!((await isEnabled('healthMetrics')) && (await isEnabled('healthLedger')))) {
    return { ...result, disabled: true };
  }

  const consents = await prisma.healthConsent.findMany({
    where: { revokedAt: null, scopes: { has: NUTRITION_SCOPE } },
    select: { userId: true, scopes: true, scopeVersions: true },
  });
  const current = consents.filter((c) => !isScopeStale(c, NUTRITION_SCOPE));
  const goals = current.length
    ? await prisma.healthGoal.findMany({
        where: { userId: { in: current.map((c) => c.userId) } },
        select: { userId: true },
      })
    : [];
  const eligible = [...new Set(goals.map((g) => g.userId))];
  result.eligible = eligible.length;
  result.skipped = consents.length - eligible.length;

  for (const userId of eligible) {
    try {
      const out = await closeDay(prisma, { userId, localDate, today });
      if (out?.alreadyClosed) result.alreadyClosed += 1;
      else {
        result.closed += 1;
        // Event: Day was closed successfully.
        // Trigger immediate reward evaluation for this user.
        await evaluateUserReward(userId).catch(err => 
          console.error(`[day-close] reward evaluation failed for ${userId}:`, err)
        );
      }
    } catch (err) {
      // One user's bad data must not stop everyone else's day from closing.
      // The next run retries them: yesterday stays "yesterday" for 24 hours,
      // and after that the client close (or a manual dispatch) still works.
      result.failed += 1;
      console.error('[day-close] failed for user', userId, err?.message || err);
    }
  }
  return result;
}
