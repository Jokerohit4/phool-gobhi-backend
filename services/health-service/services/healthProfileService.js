import { PrismaClient } from '@prisma/client';
import {
  validateProfilePatch,
  validateMedication,
  answeredKeys,
  completion,
  basicsComplete,
  QUESTION_KEYS,
  BASICS_KEYS,
  MEDICATION_NOTE,
  MAX_MEDICATIONS,
  USE_SCALE,
  ALLERGY_STATUSES,
  MEDICATION_STATUSES,
  COMMON_ALLERGENS,
  BROUGHT_HERE,
  DIET_TYPES,
  WHO_COOKS,
  OCCUPATIONS,
  WORKING_HOURS,
  HEALTH_SPEND,
  SPECTACLES_TYPES,
} from './healthProfile.js';
import { hasHealthProfileConsentService, getHealthProfileConsentService } from './healthProfileConsentService.js';
import { hasBiometricConsentService } from './biometricConsentService.js';
import { upsertEntryService } from './biometricService.js';
import { creditProfileQuestionCoin } from '../utils/notifyChallengeService.js';

const prisma = new PrismaClient();

// Served with every read so the app renders chips from the server's sets —
// adding an option needs no app release.
export const PROFILE_OPTIONS = {
  useScale: USE_SCALE,
  allergyStatuses: ALLERGY_STATUSES,
  medicationStatuses: MEDICATION_STATUSES,
  commonAllergens: COMMON_ALLERGENS,
  broughtHere: BROUGHT_HERE,
  dietTypes: DIET_TYPES,
  whoCooks: WHO_COOKS,
  occupations: OCCUPATIONS,
  workingHours: WORKING_HOURS,
  healthSpend: HEALTH_SPEND,
  spectaclesTypes: SPECTACLES_TYPES,
};

function fail(status, error, code) {
  return Object.assign(new Error(error), { status, error, code });
}

async function bodyNumberFacts(userId) {
  const [weight, personalisation, goal] = await Promise.all([
    prisma.biometricEntry.findFirst({ where: { userId, metric: 'weight' }, select: { id: true } }),
    prisma.personalisationProfile.findUnique({ where: { userId }, select: { heightCm: true } }),
    prisma.healthGoal.findUnique({ where: { userId }, select: { heightCm: true } }),
  ]);
  return {
    hasWeight: Boolean(weight),
    hasHeight: personalisation?.heightCm != null || goal?.heightCm != null,
  };
}

function serialiseMedication(m) {
  return { id: m.id, name: m.name, times: m.times, active: m.active };
}

export async function getProfileService(userId) {
  const [row, facts, medications, consent] = await Promise.all([
    prisma.healthProfile.findUnique({ where: { userId } }),
    bodyNumberFacts(userId),
    prisma.medicationReminder.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    getHealthProfileConsentService(userId),
  ]);
  const answered = answeredKeys(row, facts);
  const { coinKeys = [], createdAt, updatedAt, userId: _u, ...answers } = row || {};
  return {
    answers: row ? answers : null,
    answered,
    completion: completion(answered),
    basicsComplete: basicsComplete(answered),
    questionKeys: QUESTION_KEYS,
    basicsKeys: BASICS_KEYS,
    // Which questions have already paid their coin, so the app can mark them
    // "earned" without asking challenge-service.
    coinKeys,
    consent,
    medications: medications.map(serialiseMedication),
    medicationNote: MEDICATION_NOTE,
    options: PROFILE_OPTIONS,
  };
}

/// Pays the one-time coin for every answered question not yet paid.
/// Returns the keys paid on THIS call — what the app animates a coin for.
async function payNewlyAnswered(userId, answered, alreadyPaid) {
  const due = answered.filter((k) => !alreadyPaid.includes(k));
  if (!due.length) return [];
  const results = await Promise.all(
    due.map(async (questionKey) => ((await creditProfileQuestionCoin({ userId, questionKey })) ? questionKey : null)),
  );
  const paid = results.filter(Boolean);
  if (paid.length) {
    await prisma.healthProfile.update({
      where: { userId },
      data: { coinKeys: [...new Set([...alreadyPaid, ...paid])] },
    });
  }
  return paid;
}

export async function updateProfileService(userId, body) {
  const { data, bodyNumbers, sensitive, errors } = validateProfilePatch(body);
  if (errors.length) throw fail(400, errors.join('; '), 'VALIDATION_ERROR');

  // Consent is checked on WHAT IS BEING STORED, not on which screen sent it:
  // a "prefer not to say" goes through without it, a disclosure never does.
  if (sensitive && !(await hasHealthProfileConsentService(userId))) {
    throw fail(403, 'Saving health answers is off for your account.', 'HEALTH_PROFILE_CONSENT_REQUIRED');
  }
  // Weight and height are body numbers and stay under their own consent,
  // exactly as when they're typed on Track Body — one rule wherever they
  // come from.
  const hasBodyNumbers = bodyNumbers.weightKg != null || bodyNumbers.heightCm != null;
  if (hasBodyNumbers && !(await hasBiometricConsentService(userId))) {
    throw fail(403, 'Saving body numbers is off for your account.', 'BIOMETRIC_CONSENT_REQUIRED');
  }

  const existing = await prisma.healthProfile.findUnique({ where: { userId } });
  await prisma.healthProfile.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
  if (bodyNumbers.weightKg != null) {
    // Through the one biometric write path, so the unit, the day and the
    // one-row-per-day rule are the same as everywhere else.
    await upsertEntryService(userId, { metric: 'weight', value: bodyNumbers.weightKg, unit: 'kg', source: 'manual' });
  }
  if (bodyNumbers.heightCm != null) {
    // PersonalisationProfile.heightCm is the column the ledger's targetService
    // already falls back to, so a signup height reaches Health+ with no copy.
    await prisma.personalisationProfile.upsert({
      where: { userId },
      create: { userId, heightCm: bodyNumbers.heightCm },
      update: { heightCm: bodyNumbers.heightCm },
    });
  }

  const after = await prisma.healthProfile.findUnique({ where: { userId } });
  const answered = answeredKeys(after, await bodyNumberFacts(userId));
  if (basicsComplete(answered) && !after.basicsAnsweredAt) {
    await prisma.healthProfile.update({ where: { userId }, data: { basicsAnsweredAt: new Date() } });
  }
  const coinsEarned = await payNewlyAnswered(userId, answered, existing?.coinKeys || after.coinKeys || []);
  return { ...(await getProfileService(userId)), coinsEarned };
}

/// Erases every health-profile answer and medication reminder. The consent
/// row is kept (soft) so "did they ever agree, and when" survives; the coin
/// ledger keeps its entries because coins already earned are the user's.
export async function deleteProfileService(userId) {
  await prisma.$transaction([
    prisma.medicationReminder.deleteMany({ where: { userId } }),
    prisma.healthProfile.deleteMany({ where: { userId } }),
  ]);
  return getProfileService(userId);
}

// --- Medication reminders ---------------------------------------------------

async function requireConsent(userId) {
  if (!(await hasHealthProfileConsentService(userId))) {
    throw fail(403, 'Saving health answers is off for your account.', 'HEALTH_PROFILE_CONSENT_REQUIRED');
  }
}

export async function listMedicationsService(userId) {
  const rows = await prisma.medicationReminder.findMany({ where: { userId }, orderBy: { id: 'asc' } });
  return { medications: rows.map(serialiseMedication), note: MEDICATION_NOTE };
}

export async function createMedicationService(userId, body) {
  const { data, errors } = validateMedication(body);
  if (errors.length) throw fail(400, errors.join('; '), 'VALIDATION_ERROR');
  await requireConsent(userId);
  const count = await prisma.medicationReminder.count({ where: { userId } });
  if (count >= MAX_MEDICATIONS) throw fail(400, `At most ${MAX_MEDICATIONS} medicines`, 'VALIDATION_ERROR');
  const row = await prisma.medicationReminder.create({ data: { userId, ...data } });
  // Adding a medicine answers the medications question — that is the whole
  // answer, so the status follows rather than being a second thing to tap.
  const existing = await prisma.healthProfile.findUnique({ where: { userId } });
  await prisma.healthProfile.upsert({
    where: { userId },
    create: { userId, medicationsStatus: 'has' },
    update: { medicationsStatus: 'has' },
  });
  const after = await prisma.healthProfile.findUnique({ where: { userId } });
  const answered = answeredKeys(after, await bodyNumberFacts(userId));
  const coinsEarned = await payNewlyAnswered(userId, answered, existing?.coinKeys || []);
  return { medication: serialiseMedication(row), note: MEDICATION_NOTE, coinsEarned };
}

async function ownMedication(userId, id) {
  const row = await prisma.medicationReminder.findUnique({ where: { id } });
  if (!row || row.userId !== userId) throw fail(404, 'Not found', 'NOT_FOUND');
  return row;
}

export async function updateMedicationService(userId, id, body) {
  const current = await ownMedication(userId, id);
  const { data, errors } = validateMedication({ ...serialiseMedication(current), ...body });
  if (errors.length) throw fail(400, errors.join('; '), 'VALIDATION_ERROR');
  await requireConsent(userId);
  const row = await prisma.medicationReminder.update({ where: { id }, data });
  return { medication: serialiseMedication(row), note: MEDICATION_NOTE };
}

/// Deleting never needs consent — removing your own data is always open.
export async function deleteMedicationService(userId, id) {
  await ownMedication(userId, id);
  await prisma.medicationReminder.delete({ where: { id } });
  return listMedicationsService(userId);
}
