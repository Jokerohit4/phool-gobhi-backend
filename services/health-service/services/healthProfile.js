// The health profile's rules (gamified onboarding v2, 2026-10-01).
//
// Pure on purpose, like homeSetup.js: the option sets, the validation, which
// answers are sensitive, which ones count toward the one-time coin, and the
// coach summary are the whole feature, so they are pinned by unit tests
// without a database. healthProfileService.js only moves rows.
//
// Two rules shape everything here:
//
//   1. "Prefer not to say" is an answer, not a gap. The five signup questions
//      are mandatory to ANSWER, never to DISCLOSE — declining is offered as an
//      equal option, earns the same coin, and needs no consent (declining to
//      disclose is not health data). Forcing disclosure would fail the DPDP
//      necessity test and Apple's 5.1.1(ii) rule on required personal data.
//
//   2. Nothing is collected without a reader. FIELD_CONSUMERS names who reads
//      each field. A field whose only consumer is "documented future purpose"
//      says so in plain words, so the next person can't mistake it for an
//      oversight.

// Frequency scale shared by drinking, smoking and the two substance
// questions. One scale, so the copy and the coach phrasing stay consistent.
export const USE_SCALE = ['never', 'occasionally', 'weekly', 'daily', 'prefer_not'];

export const ALLERGY_STATUSES = ['none', 'has', 'prefer_not'];
export const MEDICATION_STATUSES = ['none', 'has', 'prefer_not'];

// Chips the app offers for allergies. The stored value is the chip key OR the
// user's own words — allergies are free text by design (HealthGoal.allergies
// set the precedent: the user's words, used to warn, never to filter).
export const COMMON_ALLERGENS = [
  'peanuts',
  'tree_nuts',
  'milk',
  'egg',
  'wheat_gluten',
  'soy',
  'fish',
  'shellfish',
  'sesame',
  'mustard',
];
export const MAX_ALLERGIES = 12;
export const MAX_ALLERGY_CHARS = 40;

export const BROUGHT_HERE = [
  'get_fitter',
  'lose_weight',
  'build_muscle',
  'stay_consistent',
  'find_a_buddy',
  'feel_better',
  'doctor_suggested',
  'just_curious',
];

export const DIET_TYPES = [
  'vegetarian',
  'eggetarian',
  'non_vegetarian',
  'vegan',
  'jain',
  'high_protein',
  'keto',
  'intermittent_fasting',
  'other',
];
export const WHO_COOKS = ['self', 'family', 'cook', 'outside', 'mixed'];
export const OCCUPATIONS = ['desk', 'on_feet', 'shifts', 'student', 'homemaker', 'other'];
// Hours worked on a normal day. Ranges, never a clock time: the point is how
// much of the day is spoken for, not when it starts.
export const WORKING_HOURS = ['under_6', '6_to_8', '8_to_10', 'over_10', 'irregular'];
// Monthly, in rupees. Ranges so nobody has to work out an exact figure.
export const HEALTH_SPEND = ['under_500', '500_to_1500', '1500_to_3000', '3000_to_6000', 'over_6000'];
export const SPECTACLES_TYPES = ['glasses', 'contacts', 'both'];
export const MAX_HOMETOWN_CHARS = 60;

export const MIN_MEALS = 1;
export const MAX_MEALS = 8;

// Body numbers accepted from the signup step. Same bounds as the Health+
// intake so a value one surface accepts is never rejected by the other.
export const MIN_WEIGHT_KG = 20;
export const MAX_WEIGHT_KG = 350;
export const MIN_HEIGHT_CM = 90;
export const MAX_HEIGHT_CM = 250;

// The one line that ever accompanies medications. Fixed text, never generated:
// the medication list must not change a plan, a target or a score, and a
// model improvising here is exactly how that would start.
export const MEDICATION_NOTE =
  'Some medicines affect exercise and diet — check with your doctor before big changes.';

// Answers that need HealthProfileConsent before they can be STORED. A
// "prefer not to say" is never sensitive — it discloses nothing. "None" and
// "never" are: they are still facts about someone's health.
const SENSITIVE_FIELDS = ['allergyStatus', 'allergies', 'drinking', 'smoking', 'greens', 'otherSubstances', 'medicationsStatus'];

// The questions, in the order the Profile section lists them. Each is worth
// one coin, once, whatever the answer — including "prefer not to say".
// Rewarding only disclosure would be paying people for their health data,
// which is an inducement a consent can't survive.
export const QUESTION_KEYS = [
  'allergies',
  'weight',
  'height',
  'drinking',
  'smoking',
  'broughtHere',
  'meals',
  'diet',
  'whoCooks',
  'occupation',
  'workingHours',
  'healthSpend',
  'spectacles',
  'hometown',
  'medications',
  'greens',
  'otherSubstances',
];

// The five that must be answered at signup.
export const BASICS_KEYS = ['allergies', 'weight', 'height', 'drinking', 'smoking'];

// Who reads each field. Asserted by tests to cover every column, so adding a
// question without naming its consumer fails CI.
export const FIELD_CONSUMERS = {
  allergyStatus: 'coach (safety line)',
  allergies: 'coach (safety line); Health+ intake prefill',
  weightDeclined: 'signup completeness only',
  heightDeclined: 'signup completeness only',
  drinking: 'coach',
  smoking: 'coach',
  greens: 'coach — never analytics/admin/insurer/FHIR',
  otherSubstances: 'coach — never analytics/admin/insurer/FHIR',
  broughtHere: 'coach (motivation); onboarding funnel (enum only)',
  mealsPerDay: 'coach (meal suggestions)',
  followsDiet: 'coach',
  dietType: 'coach',
  whoCooks: 'coach (realistic meal suggestions)',
  occupation: 'coach (workout timing and load)',
  workingHours: 'coach (workout timing and load)',
  healthSpend: 'documented future purpose: pricing research; never shown to partners',
  wearsSpectacles: 'documented future purpose: eye-care partner offers',
  spectaclesType: 'documented future purpose: eye-care partner offers',
  hometown: 'coach (life context)',
  medicationsStatus: 'coach (acknowledges reminders exist, never advises); app reminders',
  coinKeys: 'coin idempotency display',
  basicsAnsweredAt: 'signup gate (resume prompt)',
};

const has = (v) => v !== undefined;

function oneOf(field, value, allowed, errors) {
  if (value === null) return null;
  if (!allowed.includes(value)) {
    errors.push(`${field} must be one of: ${allowed.join(', ')}`);
    return undefined;
  }
  return value;
}

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const t = value.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

/// Validates a PATCH body into the columns to write.
///
/// Returns { data, body: { weightKg?, heightCm? }, sensitive, errors }.
/// `sensitive` is true when the patch would store a disclosure that needs
/// HealthProfileConsent (see SENSITIVE_FIELDS). Unknown keys are ignored
/// rather than rejected, so an older app build sending a field this server no
/// longer knows doesn't break the whole save.
export function validateProfilePatch(body = {}) {
  const errors = [];
  const data = {};
  const bodyNumbers = {};

  if (has(body.allergyStatus)) {
    const status = oneOf('allergyStatus', body.allergyStatus, ALLERGY_STATUSES, errors);
    if (status !== undefined) data.allergyStatus = status;
  }
  if (has(body.allergies)) {
    if (!Array.isArray(body.allergies)) {
      errors.push('allergies must be a list');
    } else {
      const list = [...new Set(body.allergies.map((a) => cleanText(a, MAX_ALLERGY_CHARS)).filter(Boolean))];
      if (list.length > MAX_ALLERGIES) errors.push(`at most ${MAX_ALLERGIES} allergies`);
      else data.allergies = list;
    }
  }
  // "has" with an empty list is the same contradiction homeSetup refuses for
  // 'none' plus equipment: storing it would make the safety line ambiguous.
  if (data.allergyStatus === 'has' && has(data.allergies) && data.allergies.length === 0) {
    errors.push("allergyStatus 'has' needs at least one allergy");
  }
  // Anything other than 'has' clears the list, so a stale allergy can't sit
  // behind a "none" and still reach the coach.
  if (data.allergyStatus && data.allergyStatus !== 'has') data.allergies = [];

  for (const field of ['drinking', 'smoking', 'greens', 'otherSubstances']) {
    if (has(body[field])) {
      const v = oneOf(field, body[field], USE_SCALE, errors);
      if (v !== undefined) data[field] = v;
    }
  }

  if (has(body.weightDeclined)) data.weightDeclined = body.weightDeclined === true;
  if (has(body.heightDeclined)) data.heightDeclined = body.heightDeclined === true;
  if (has(body.weightKg) && body.weightKg !== null) {
    const w = Number(body.weightKg);
    if (!Number.isFinite(w) || w < MIN_WEIGHT_KG || w > MAX_WEIGHT_KG) {
      errors.push(`weightKg must be between ${MIN_WEIGHT_KG} and ${MAX_WEIGHT_KG}`);
    } else {
      bodyNumbers.weightKg = Math.round(w * 10) / 10;
      data.weightDeclined = false;
    }
  }
  if (has(body.heightCm) && body.heightCm !== null) {
    const h = Number(body.heightCm);
    if (!Number.isFinite(h) || h < MIN_HEIGHT_CM || h > MAX_HEIGHT_CM) {
      errors.push(`heightCm must be between ${MIN_HEIGHT_CM} and ${MAX_HEIGHT_CM}`);
    } else {
      bodyNumbers.heightCm = Math.round(h);
      data.heightDeclined = false;
    }
  }

  if (has(body.broughtHere)) {
    if (!Array.isArray(body.broughtHere) || body.broughtHere.some((b) => !BROUGHT_HERE.includes(b))) {
      errors.push(`broughtHere must be a subset of: ${BROUGHT_HERE.join(', ')}`);
    } else {
      data.broughtHere = [...new Set(body.broughtHere)];
    }
  }
  if (has(body.mealsPerDay)) {
    if (body.mealsPerDay === null) data.mealsPerDay = null;
    else if (!Number.isInteger(body.mealsPerDay) || body.mealsPerDay < MIN_MEALS || body.mealsPerDay > MAX_MEALS) {
      errors.push(`mealsPerDay must be a whole number from ${MIN_MEALS} to ${MAX_MEALS}`);
    } else data.mealsPerDay = body.mealsPerDay;
  }
  if (has(body.followsDiet)) data.followsDiet = body.followsDiet === null ? null : body.followsDiet === true;
  if (has(body.dietType)) {
    const v = oneOf('dietType', body.dietType, DIET_TYPES, errors);
    if (v !== undefined) data.dietType = v;
  }
  if (data.followsDiet === false) data.dietType = null;
  const enumFields = [
    ['whoCooks', WHO_COOKS],
    ['occupation', OCCUPATIONS],
    ['workingHours', WORKING_HOURS],
    ['healthSpend', HEALTH_SPEND],
    ['spectaclesType', SPECTACLES_TYPES],
    ['medicationsStatus', MEDICATION_STATUSES],
  ];
  for (const [field, allowed] of enumFields) {
    if (has(body[field])) {
      const v = oneOf(field, body[field], allowed, errors);
      if (v !== undefined) data[field] = v;
    }
  }
  if (has(body.wearsSpectacles)) {
    data.wearsSpectacles = body.wearsSpectacles === null ? null : body.wearsSpectacles === true;
  }
  if (data.wearsSpectacles === false) data.spectaclesType = null;
  if (has(body.hometown)) data.hometown = cleanText(body.hometown, MAX_HOMETOWN_CHARS);

  // Any answer other than "prefer not to say" is a disclosure — including
  // "none" and "never", which are still facts about someone's health.
  const sensitive = SENSITIVE_FIELDS.some((f) => {
    if (!has(data[f])) return false;
    const v = data[f];
    if (f === 'allergies') return v.length > 0;
    return v !== null && v !== 'prefer_not';
  });

  return {
    data,
    bodyNumbers,
    sensitive,
    errors,
  };
}

/// Which questions count as answered. `extras` carries the facts that live
/// outside the HealthProfile row: whether a weight reading or a height exists.
export function answeredKeys(profile, { hasWeight = false, hasHeight = false } = {}) {
  const p = profile || {};
  const out = [];
  const add = (key, cond) => {
    if (cond) out.push(key);
  };
  add('allergies', p.allergyStatus != null);
  add('weight', hasWeight || p.weightDeclined === true);
  add('height', hasHeight || p.heightDeclined === true);
  add('drinking', p.drinking != null);
  add('smoking', p.smoking != null);
  add('broughtHere', (p.broughtHere || []).length > 0);
  add('meals', p.mealsPerDay != null);
  add('diet', p.followsDiet != null);
  add('whoCooks', p.whoCooks != null);
  add('occupation', p.occupation != null);
  add('workingHours', p.workingHours != null);
  add('healthSpend', p.healthSpend != null);
  add('spectacles', p.wearsSpectacles != null);
  add('hometown', p.hometown != null && p.hometown !== '');
  add('medications', p.medicationsStatus != null);
  add('greens', p.greens != null);
  add('otherSubstances', p.otherSubstances != null);
  return out;
}

export function completion(answered) {
  const done = answered.filter((k) => QUESTION_KEYS.includes(k)).length;
  return {
    answered: done,
    total: QUESTION_KEYS.length,
    percent: Math.round((done / QUESTION_KEYS.length) * 100),
  };
}

export function basicsComplete(answered) {
  return BASICS_KEYS.every((k) => answered.includes(k));
}

const SCALE_PHRASES = {
  never: 'never',
  occasionally: 'occasionally',
  weekly: 'about weekly',
  daily: 'daily',
};
const DIET_PHRASES = {
  vegetarian: 'vegetarian',
  eggetarian: 'eggetarian',
  non_vegetarian: 'non-vegetarian',
  vegan: 'vegan',
  jain: 'Jain (no root vegetables)',
  high_protein: 'high-protein',
  keto: 'keto',
  intermittent_fasting: 'intermittent fasting',
  other: 'a specific diet',
};
const COOK_PHRASES = {
  self: 'themselves',
  family: 'family',
  cook: 'a cook',
  outside: 'mostly eating out or ordering in',
  mixed: 'a mix',
};
const OCCUPATION_PHRASES = {
  desk: 'a desk job',
  on_feet: 'a job on their feet',
  shifts: 'shift work',
  student: 'a student',
  homemaker: 'running a home',
  other: 'work',
};
const HOURS_PHRASES = {
  under_6: 'under 6 hours a day',
  '6_to_8': '6–8 hours a day',
  '8_to_10': '8–10 hours a day',
  over_10: 'over 10 hours a day',
  irregular: 'irregular hours',
};
const WHY_PHRASES = {
  get_fitter: 'get fitter',
  lose_weight: 'lose weight',
  build_muscle: 'build muscle',
  stay_consistent: 'stay consistent',
  find_a_buddy: 'find a workout buddy',
  feel_better: 'feel better',
  doctor_suggested: 'a doctor suggested exercise',
  just_curious: 'curiosity',
};

/// The coach's two lines from this profile, or nulls.
///
/// Split in two on purpose. Allergies go in the SAFETY line, which the
/// context builder places straight after the safety memories at the front of
/// the prompt — a missed allergy is the one mistake here that hurts someone.
/// Everything else is the lifestyle line. Both are fixed phrases (plus the
/// capped allergy and hometown text), deterministic, and byte-stable between
/// turns, so they sit in the cached prompt prefix.
///
/// "Prefer not to say" produces nothing: the coach is never told that
/// someone declined, because "they wouldn't say whether they smoke" invites
/// the model to speculate.
///
/// Medications: only THAT reminders exist, never which medicines — and an
/// explicit instruction not to advise. The list never changes a plan.
export function summariseForCoach(profile, { medicationCount = 0 } = {}) {
  if (!profile) return { safety: null, lifestyle: null };
  const p = profile;
  const safety =
    p.allergyStatus === 'has' && (p.allergies || []).length
      ? `Allergies they told the app about: ${p.allergies.map((a) => a.replace(/_/g, ' ')).join(', ')}. Never suggest foods containing these.`
      : null;

  const bits = [];
  const use = (label, value) => {
    const phrase = SCALE_PHRASES[value];
    if (phrase) bits.push(`${label} ${phrase}.`);
  };
  use('Drinks alcohol', p.drinking);
  use('Smokes', p.smoking);
  use('Smokes cannabis', p.greens);
  use('Uses other recreational drugs', p.otherSubstances);
  const why = (p.broughtHere || []).map((b) => WHY_PHRASES[b]).filter(Boolean);
  if (why.length) bits.push(`Came to the app to: ${why.join(', ')}.`);
  if (p.mealsPerDay) bits.push(`Eats ${p.mealsPerDay} meal${p.mealsPerDay === 1 ? '' : 's'} a day.`);
  if (p.followsDiet === true) bits.push(`Follows ${DIET_PHRASES[p.dietType] || 'a diet'}.`);
  if (p.followsDiet === false) bits.push('No set diet.');
  if (COOK_PHRASES[p.whoCooks]) bits.push(`Food is cooked by ${COOK_PHRASES[p.whoCooks]}.`);
  if (OCCUPATION_PHRASES[p.occupation]) {
    const hours = HOURS_PHRASES[p.workingHours];
    bits.push(`Has ${OCCUPATION_PHRASES[p.occupation]}${hours ? `, ${hours}` : ''}.`);
  } else if (HOURS_PHRASES[p.workingHours]) {
    bits.push(`Works ${HOURS_PHRASES[p.workingHours]}.`);
  }
  if (p.hometown) bits.push(`From ${p.hometown}.`);
  if (p.medicationsStatus === 'has' && medicationCount > 0) {
    bits.push(
      'Has medicine reminders set in the app. Never advise on medicines, doses or timing; for anything about medicines, tell them to ask their doctor.',
    );
  }
  const lifestyle = bits.length ? `Health profile (they told the app): ${bits.join(' ')}` : null;
  return { safety, lifestyle };
}

/// Medication reminder validation. Name is the user's own words; times are
/// 'HH:MM' in their local day. Nothing here reads the name for meaning.
export const MAX_MEDICATIONS = 15;
export const MAX_MEDICATION_NAME = 60;
export const MAX_TIMES_PER_MEDICATION = 6;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateMedication(body = {}) {
  const errors = [];
  const name = cleanText(body.name, MAX_MEDICATION_NAME);
  if (!name) errors.push('name is required');
  const times = Array.isArray(body.times) ? [...new Set(body.times)] : [];
  if (!Array.isArray(body.times)) errors.push('times must be a list');
  else if (times.length > MAX_TIMES_PER_MEDICATION) errors.push(`at most ${MAX_TIMES_PER_MEDICATION} times`);
  else if (times.some((t) => !TIME_RE.test(t))) errors.push("each time must be 'HH:MM'");
  return { data: { name, times: times.sort(), active: body.active !== false }, errors };
}
