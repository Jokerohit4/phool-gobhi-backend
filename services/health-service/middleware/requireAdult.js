import { fetchUserProfileInternal } from '../utils/fetchUserProfile.js';

// Health+ is adults-only. Put on every route that GRANTS a consent in this
// service, because granting a consent is the door into every class of
// behavioural health data we hold (device sync, food log, medical documents,
// cycle history, run routes, coach transcripts).
//
// Why 18 here when an account only needs 11 (auth-service MIN_AGE_YEARS):
// DPDP s.9(3) says a data fiduciary "shall not undertake tracking or
// behavioural monitoring of children", and the Fourth Schedule exemptions
// cover clinical establishments and educational institutions — not us. An
// adherence ledger is behavioural monitoring by definition, so there is no
// version of it we can offer a 16-year-old with a parent's say-so. Booking a
// gym session is a different question and is deliberately left alone; the
// account-level age is a product decision, not a compliance patch.
//
// Why gate the consent GRANT rather than every read: a user under 18 can never
// get a consent recorded, so every consent-gated route already refuses them,
// and this costs one auth-service round trip per opt-in instead of one per
// request. Revoking and deleting are never gated — withdrawing must always
// work, for anyone, including someone whose DOB was edited after they opted in.
export const HEALTH_MIN_AGE_YEARS = 18;

// Whole years between a date-only DOB and today, UTC throughout so the
// boundary day does not wobble with the server's timezone.
export function ageInYears(dateOfBirth, now = new Date()) {
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export async function requireAdult(req, res, next) {
  const profile = await fetchUserProfileInternal(req.userId);
  if (!profile) {
    // Fails CLOSED. fetchUserProfileInternal swallows errors into null, and
    // "we couldn't check" must not become "old enough".
    return res.status(503).json({
      error: 'Could not verify your age right now. Please try again.',
      code: 'AGE_CHECK_FAILED',
    });
  }
  if (!profile.dateOfBirth) {
    // Distinct code so the app can route to "add your date of birth" rather
    // than showing a refusal to someone who is simply missing a field.
    return res.status(403).json({
      error: 'Add your date of birth in your profile to use Health+.',
      code: 'DOB_REQUIRED',
    });
  }
  const age = ageInYears(profile.dateOfBirth);
  if (age === null || age < HEALTH_MIN_AGE_YEARS) {
    return res.status(403).json({
      error: `Health+ is available to people aged ${HEALTH_MIN_AGE_YEARS} and over.`,
      code: 'UNDER_MIN_AGE',
    });
  }
  return next();
}
