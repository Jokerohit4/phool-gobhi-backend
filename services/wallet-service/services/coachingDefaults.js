import { COACHING_REGIONS, validateCoachingV2Config } from './coachingV2Config.js';

export { COACHING_REGIONS };
export const COACHING_PLAN_KEYS = ['MONTHLY_4499', 'QUARTERLY_11999'];
function remotePrice(name) {
  const raw = process.env[name];
  const value = raw && /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
  return Number.isSafeInteger(value) && value <= 100000000 ? value : null;
}
export function defaultCoachingConfig() {
  return { regions: Object.fromEntries(COACHING_REGIONS.map(region => {
    const local = region === 'GURUGRAM';
    return [region, {
      label: local ? 'Gurugram - gym + guided health' : 'Outside Gurugram - guidance only',
      plans: COACHING_PLAN_KEYS.map((product, index) => {
        const quarterly = index === 1;
        return {
          product, enabled: true,
          title: local ? (quarterly ? '90-Day Body & Blood Transformation' : 'Monthly Starter') : (quarterly ? '90-Day Guided Health' : 'Monthly Guided Health'),
          description: local ? 'Hands-on support for your movement, meals and follow-up.' : 'Remote guidance for your routine, meals and health follow-up.',
          amountPaise: local ? (quarterly ? 1199900 : 449900) : remotePrice(quarterly ? 'COACHING_REMOTE_QUARTERLY_PRICE_PAISE' : 'COACHING_REMOTE_MONTHLY_PRICE_PAISE'),
          durationDays: quarterly ? 90 : 30, featured: quarterly,
          badge: quarterly ? 'Most Popular' : '', ctaLabel: quarterly ? 'Choose the 90-Day Plan' : 'Choose Monthly',
          gymAccess: local, gymArea: local ? 'Sector 45, Gurugram' : '', gymVisitsPerMonth: local ? 16 : 0,
          gymDescription: 'Your team coordinates the gym pass and visit timings during onboarding.',
          trainerSupport: local, freeFormSessions: local ? 2 : 0,
          trainerDescription: 'A qualified trainer helps you use equipment, practise exercise technique and check your posture. Included sessions are granted once per purchase.',
          checkInsPerWeek: 1, coachingDescription: 'Discuss your routine, consistency, questions and next steps. Your team confirms the call time.',
          mealRoutine: true, mealDescription: 'An AI-assisted Indian meal routine is informed by the food you log. Keep logging meals in the free app so your coaching check-ins have context.',
          dietitianReview: quarterly, doctorClearanceForRed: quarterly,
          clinicalDescription: 'A human clinical dietitian reviews your confirmed report and existing clinician advice.',
          labCredits: local && quarterly ? 2 : 0,
          labDescription: 'Your team confirms collection arrangements and the panel details.',
          onboardingDescription: 'Your team will get in touch to coordinate the support included in your plan.',
        };
      }),
      addon: { enabled: local, title: 'Personal Trainer Floor Sessions', amountPaise: 149900, sessions: 4, validityDays: 30, description: 'Extra hands-on form support from a qualified trainer on the gym floor.' },
    }];
  })) };
}

const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
function text(value, label, max, optional = false) {
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) bad(`Check ${label}`);
  return value.trim();
}
function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) bad(`${label} must be a whole number from ${min} to ${max}`);
  return value;
}
function boolean(value, label) { if (typeof value !== 'boolean') bad(`Check ${label}`); return value; }
const booleanFields = ['enabled', 'featured', 'gymAccess', 'trainerSupport', 'mealRoutine', 'dietitianReview', 'doctorClearanceForRed'];
const copyFields = ['gymDescription', 'trainerDescription', 'coachingDescription', 'mealDescription', 'clinicalDescription', 'labDescription', 'onboardingDescription'];
function validateLegacyConfig(input) {
  if (!input || typeof input !== 'object' || !input.regions || Object.keys(input.regions).sort().join() !== [...COACHING_REGIONS].sort().join()) bad('Both supported regions are required');
  return { regions: Object.fromEntries(COACHING_REGIONS.map(region => {
    const raw = input.regions[region];
    if (!raw || !Array.isArray(raw.plans) || raw.plans.length !== 2 || new Set(raw.plans.map(p => p?.product)).size !== 2) bad('Keep exactly the monthly and 90-day plan keys in each region');
    const plans = COACHING_PLAN_KEYS.map(product => {
      const p = raw.plans.find(plan => plan?.product === product);
      if (!p) bad('A supported plan is missing');
      const plan = { product, title: text(p.title, 'plan title', 120), description: text(p.description, 'plan description', 500, true),
        badge: text(p.badge, 'plan badge', 100, true), ctaLabel: text(p.ctaLabel, 'button label', 80),
        gymArea: text(p.gymArea, 'gym area', 150, true),
        amountPaise: p.amountPaise === null ? null : integer(p.amountPaise, 'Price in paise', 1, 100000000),
        durationDays: integer(p.durationDays, 'Plan duration', 7, 365),
        gymVisitsPerMonth: integer(p.gymVisitsPerMonth, 'Gym visits per month', 0, 100),
        freeFormSessions: integer(p.freeFormSessions, 'Included form sessions', 0, 20),
        checkInsPerWeek: integer(p.checkInsPerWeek, 'Check-ins per week', 0, 7),
        labCredits: integer(p.labCredits, 'Included blood panels', 0, 2),
      };
      for (const field of booleanFields) plan[field] = boolean(p[field], field);
      for (const field of copyFields) plan[field] = text(p[field], field, 2000, true);
      if (plan.gymAccess && (!plan.gymArea || !plan.gymVisitsPerMonth)) bad('Gym access needs an area and monthly visits');
      if (!plan.gymAccess && plan.gymVisitsPerMonth !== 0) bad('Turn off gym visits when gym access is excluded');
      if (!plan.trainerSupport && plan.freeFormSessions !== 0) bad('Included form sessions need trainer support');
      if (plan.labCredits === 2 && plan.durationDays < 90) bad('Two blood panels need a plan of at least 90 days for the Day-90 re-test');
      if (region === 'REST_INDIA' && (plan.gymAccess || plan.trainerSupport || plan.gymVisitsPerMonth || plan.freeFormSessions || plan.labCredits)) bad('Outside-Gurugram plans must remain guidance-only');
      return plan;
    });
    const a = raw.addon;
    if (!a) bad('Trainer add-on settings are required');
    const addon = { enabled: boolean(a.enabled, 'trainer add-on availability'), title: text(a.title, 'add-on title', 120),
      description: text(a.description, 'add-on description', 2000, true), amountPaise: integer(a.amountPaise, 'Add-on price in paise', 1, 100000000),
      sessions: integer(a.sessions, 'Add-on session count', 1, 20), validityDays: integer(a.validityDays, 'Add-on validity', 1, 365) };
    if (region === 'REST_INDIA' && addon.enabled) bad('Gym-floor add-ons are unavailable outside Gurugram');
    return [region, { label: text(raw.label, 'region label', 150), plans, addon }];
  })) };
}

export function validateCoachingConfig(input) {
  if (input?.schemaVersion === 2) {
    return { ...validateCoachingV2Config(input), ...(input.regions === undefined ? {} : validateLegacyConfig(input)) };
  }
  if (input?.schemaVersion !== undefined && input.schemaVersion !== 1) bad('Unsupported catalog schema version');
  return validateLegacyConfig(input);
}
