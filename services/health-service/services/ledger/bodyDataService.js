// Body data and diet for the coach journey (B7) - the two answers a plan
// needs before its food half can exist.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: these are the user's own numbers,
// given once, in their own words' precision. Height goes where the rest of
// the service already looks for it (PersonalisationProfile.heightCm - the
// documented placeholder targetService falls back to), weight goes into the
// BiometricEntry time series (never a setup copy that goes stale), and the
// targets are computed by the SAME function the intake has always used -
// never a second formula, because two formulas is how the targets screen and
// the plan screen come to disagree about one person.
//
// B9 wraps these in POST /journey/body and POST /journey/diet; the routes
// read sex and dateOfBirth from the internal profile. This service takes
// them as parameters so it stays testable and route-agnostic.
import { recomputeTargets } from './targetService.js';
import { resolveUnlockedLayerKeys, regenerateForUser } from './starterPlanService.js';
import * as prescriptionService from './prescriptionService.js';

// Mirrors the DietPattern Prisma enum, which is also the contract's list for
// the /journey/diet answer. If the enum gains a value, this list gains it in
// the same commit - a diet this list rejects but the database accepts is a
// 400 the client cannot explain, and the reverse is a Prisma crash.
const DIET_PATTERNS = ['veg', 'egg', 'non_veg', 'vegan', 'jain'];

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// The user's IST day, the same convention BiometricEntry.localDate uses - a
// weigh-in belongs to the day the person experienced it.
function todayLocalDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/**
 * Whole years between a 'YYYY-MM-DD' birthday and a day, the way a person
 * counts their own age. An unparseable or future birthday is null rather
 * than a computed wrong number - a target built on "age -2" is worse than
 * one that waits for a real answer.
 */
export function ageOn(dateOfBirth, onDay) {
  if (typeof dateOfBirth !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return null;
  if (typeof onDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(onDay)) return null;
  const [by, bm, bd] = dateOfBirth.split('-').map(Number);
  const [ny, nm, nd] = onDay.split('-').map(Number);
  if (by > ny) return null;
  let age = ny - by;
  if (nm < bm || (nm === bm && nd < bd)) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

/**
 * Save the body answers: height, weight, and (when the caller has them from
 * the internal profile) sex and date of birth.
 *
 * Writes, in order:
 *   - PersonalisationProfile.heightCm (the height home targetService reads
 *     through its documented fallback);
 *   - a weight BiometricEntry for today (upserted on
 *     (userId, metric, localDate) so re-saving today corrects today);
 *   - when sex and dateOfBirth are both present, HealthGoal's cached sex/age
 *     (the same cache the intake writes - recomputeTargets reads them there)
 *     and then a NutritionTarget through targetService's own computation,
 *     which refuses to clobber a user_edited target and reports missing
 *     inputs rather than guessing;
 *   - and finally the plan is rebuilt, so the new target's macros and the
 *     unlocked layers' items are the food plan the user just qualified for.
 *
 * A missing or partial answer is never an error here - the journey asks for
 * these over several screens, and a save of height alone must not 400 the
 * weight it did not carry. The target computation simply waits for the rest.
 */
export async function save(prisma, userId, {
  heightCm = null,
  weightKg = null,
  sex = null,
  dateOfBirth = null,
  unlockedLayerKeys = null,
} = {}) {
  const day = todayLocalDate();
  const writes = {};

  if (heightCm != null) {
    const cm = Number(heightCm);
    if (!Number.isFinite(cm) || cm < 100 || cm > 250) {
      throw badRequest('heightCm must be between 100 and 250');
    }
    await prisma.personalisationProfile.upsert({
      where: { userId },
      create: { userId, heightCm: Math.round(cm) },
      update: { heightCm: Math.round(cm) },
    });
    writes.heightCm = true;
  }

  if (weightKg != null) {
    const kg = Number(weightKg);
    if (!Number.isFinite(kg) || kg < 25 || kg > 400) {
      // The same human range latestWeightKg enforces on the way back out;
      // refusing here is what keeps a future-dated typo from inflating BMR.
      throw badRequest('weightKg must be between 25 and 400');
    }
    await prisma.biometricEntry.upsert({
      where: { userId_metric_localDate: { userId, metric: 'weight', localDate: day } },
      create: {
        userId,
        metric: 'weight',
        value: Math.round(kg * 100) / 100,
        unit: 'kg',
        source: 'manual',
        localDate: day,
      },
      update: { value: Math.round(kg * 100) / 100, unit: 'kg' },
    });
    writes.weightKg = true;
  }

  let targetWritten = false;
  if (sex != null && dateOfBirth != null) {
    const age = ageOn(dateOfBirth, day);
    if (age == null) {
      throw badRequest('dateOfBirth must be a real date in the past, as YYYY-MM-DD');
    }

    // Sex, age and - only when absent - a starting activity guess go into the
    // HealthGoal cache, because that is where targetService's own computation
    // reads them from. 'light' is the conservative floor of the same ladder
    // the measured path uses: the journey never asks the activity question,
    // and a beginner counted as "moderate" is a budget invented for them,
    // which is the exact thing this feature refuses to do. An intake answer
    // (or a measured band) always wins.
    await prisma.healthGoal.upsert({
      where: { userId },
      create: {
        userId,
        sex,
        age,
        activity: 'light',
        startDate: day,
      },
      update: {
        sex,
        age,
        ...(await missingActivity(prisma, userId) ? { activity: 'light' } : {}),
      },
    });
    writes.sexAndAge = true;

    const out = await recomputeTargets({ prisma, userId, localDate: day });
    targetWritten = out?.written === true;
  }

  const keys = Array.isArray(unlockedLayerKeys) && unlockedLayerKeys.length
    ? unlockedLayerKeys
    : await resolveUnlockedLayerKeys(userId);

  await regenerateForUser(prisma, userId, { unlockedLayerKeys: keys });

  const plan = await prescriptionService.getPlan({ prisma, userId, journey: { unlockedLayerKeys: keys } });
  return { writes, targetWritten, plan };
}

// True when HealthGoal has no activity answer yet - the one case where the
// conservative default above is written, and never anywhere else.
async function missingActivity(prisma, userId) {
  const goal = await prisma.healthGoal.findUnique({ where: { userId } });
  return goal?.activity == null;
}

/**
 * Save the diet answer (veg / egg / non_veg / vegan / jain) onto HealthGoal.
 *
 * The diet is what filters every food example the plan ever names - the iron
 * foods in the generated items, the examples behind "See the details" - and
 * it lives on HealthGoal because that is where the intake and the generator
 * already read it from. Consent and targets are NOT this function's business:
 * the diet answer is asked before either, and must succeed without either.
 */
export async function saveDiet(prisma, userId, diet, { unlockedLayerKeys = null } = {}) {
  if (!DIET_PATTERNS.includes(diet)) {
    throw badRequest(`diet must be one of: ${DIET_PATTERNS.join(', ')}`);
  }

  await prisma.healthGoal.upsert({
    where: { userId },
    create: { userId, diet, startDate: todayLocalDate() },
    update: { diet },
  });

  const keys = Array.isArray(unlockedLayerKeys) && unlockedLayerKeys.length
    ? unlockedLayerKeys
    : await resolveUnlockedLayerKeys(userId);

  const plan = await prescriptionService.getPlan({ prisma, userId, journey: { unlockedLayerKeys: keys } });
  return { diet, plan };
}

export { DIET_PATTERNS };
