import { isoDayIST } from '../../utils/sessionDay.js';
import { isIsoDay } from './isoDay.js';

const invalid = message => Object.assign(new Error(message), { status: 400 });
export function validateDoctorPlan(input, today = isoDayIST()) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.confirmed !== true)
    throw invalid('Confirm that these answers match your doctor’s instructions.');
  if (!isIsoDay(input.startsOn) || (input.endsOn != null && (!isIsoDay(input.endsOn) || input.endsOn < input.startsOn)))
    throw invalid('Choose a valid plan start and end date.');
  if (input.startsOn !== today) throw invalid('New plans apply from today. Review the start date and save again.');
  if (input.targets != null && (typeof input.targets !== 'object' || Array.isArray(input.targets) || Object.keys(input.targets).some(key => !['kcal', 'proteinG'].includes(key))))
    throw invalid('Only daily calorie and protein targets are supported for scoring.');
  const targets = {};
  for (const [key, max] of Object.entries({ kcal: 20000, proteinG: 1000 })) {
    const value = input.targets?.[key];
    if (value == null || value === '') continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max)
      throw invalid(`Enter a valid ${key} target or leave it blank.`);
    targets[key] = value;
  }
  const text = (key, limit) => {
    if (input[key] == null) return '';
    if (typeof input[key] !== 'string' || input[key].length > limit) throw invalid(`Check ${key}.`);
    return input[key].trim();
  };
  return { version: 1, confirmed: true, startsOn: input.startsOn, endsOn: input.endsOn || null,
    targets, foodInstructions: text('foodInstructions', 1000),
    doctorName: text('doctorName', 120), speciality: text('speciality', 120),
    clinic: text('clinic', 200), registration: text('registration', 120),
    authenticity: 'user_provided_not_verified' };
}

export async function activeDoctorPlan(prisma, userId, day) {
  // Test doubles and older consumers without this optional record store carry
  // no doctor override. Database errors in the real store propagate.
  if (!prisma.ledgerConsent?.findUnique || !prisma.medicalDocument?.findMany) return null;
  const consent = await prisma.ledgerConsent.findUnique({ where: { userId } });
  if (!consent || consent.revokedAt || !consent.scopes?.includes('medical_records') ||
      consent.scopeVersions?.medical_records !== '2026-09-27') return null;
  const records = await prisma.medicalDocument.findMany({ where: { userId, structuredPlan: { path: ['version'], equals: 1 },
    OR: [{ supersededAt: null }, { supersededAt: { gt: new Date(`${day}T23:59:59.999+05:30`) } }] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  // Prior records are retired atomically on save. Deleting the replacement
  // does not reactivate an older prescription. Previous days retain their plan.
  const record = records.find(r => r.structuredPlan?.version === 1 && r.structuredPlan?.confirmed === true && r.structuredPlan.startsOn <= day);
  if (!record || (record.structuredPlan.endsOn && record.structuredPlan.endsOn < day)) return null;
  return { id: record.id, ...record.structuredPlan };
}

export function applyDoctorTargets(target, plan) {
  if (!plan) return target;
  if (!target && !Object.keys(plan.targets || {}).length) return null;
  return { ...(target || {}), ...plan.targets,
    doctorPlan: { id: plan.id, startsOn: plan.startsOn, endsOn: plan.endsOn,
      targetFields: Object.keys(plan.targets), authenticity: plan.authenticity,
      foodInstructions: plan.foodInstructions } };
}
