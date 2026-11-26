const COACHING_FAMILIES = ['medical', 'wellness'];
export const COACHING_REGIONS = ['GURUGRAM', 'REST_INDIA'];
const ADDON_KINDS = ['gym_session', 'trainer_session', 'nutritionist_session', 'lab_test'];
const REFUND_POLICIES = ['self_serve_72h', 'support'];
const TRAINER_MODES = ['online', 'in_person'];
const RESERVED_KEYS = ['FREE', 'MONTHLY_4499', 'QUARTERLY_11999', 'TRAINER_ADDON_1499'];
export const MAX_COACHING_ADDON_QUANTITY = 100;
export const MAX_COACHING_AMOUNT_PAISE = 100000000;

function components({ gym = null, sessions = 0, mode = 'online', nutritionist = null }) {
  return { gym, trainer: sessions ? { sessions, mode } : null, nutritionist, nutritionGuidance: true };
}

export function defaultCoachingV2Config() {
  const medical = (key, title, durationDays, amountPaise, sessions) => ({
    key, family: 'medical', title, description: 'Weekly trainer sessions and nutrition guidance, with unlimited gym access in Gurugram and online home training elsewhere.',
    regions: [...COACHING_REGIONS], durationDays, amountPaise, enabled: true, refundPolicy: 'self_serve_72h',
    components: components({ gym: 'unlimited', sessions, mode: 'in_person' }),
    regionOverrides: { REST_INDIA: { components: components({ sessions }) } },
  });
  const wellness = (key, title, description, amountPaise, options) => ({
    key, family: 'wellness', title, description, amountPaise, durationDays: 30, enabled: true,
    refundPolicy: 'support', regions: options.gym ? ['GURUGRAM'] : [...COACHING_REGIONS], components: components(options),
  });
  const addon = (key, kind, unitPaise, local = false, families = COACHING_FAMILIES) => ({
    key, kind, unitPaise, requiresActivePlan: true, enabled: true,
    regions: local ? ['GURUGRAM'] : [...COACHING_REGIONS], families: [...families],
  });
  return {
    schemaVersion: 2,
    offers: [
      medical('MED_30', '30-Day Medical Guidance', 30, 500000, 4),
      medical('MED_90', '90-Day Medical Guidance', 90, 1300000, 12),
      wellness('WELL_GYM', 'Gym Access', 'Unlimited partner gym visits.', 200000, { gym: 'unlimited' }),
      wellness('WELL_TRAINER_WEEKLY', 'Weekly Online Training', 'Four online trainer sessions.', 300000, { sessions: 4 }),
      wellness('WELL_TRAINER_BIWEEKLY', 'Twice-Weekly Online Training', 'Eight online trainer sessions.', 500000, { sessions: 8 }),
      wellness('WELL_TRAINER_ALLDAYS', 'Online Training', 'Sixteen online trainer sessions.', 800000, { sessions: 16 }),
      wellness('WELL_TRAINER_GYM', 'Trainer and Gym', 'Sixteen in-person trainer sessions and unlimited gym visits.', 1000000,
        { gym: 'unlimited', sessions: 16, mode: 'in_person' }),
      wellness('WELL_TRAINER_GYM_NUTRI', 'Trainer, Gym and Nutritionist', 'Sixteen in-person trainer sessions, unlimited gym visits and two nutritionist sessions.', 1200000,
        { gym: 'unlimited', sessions: 16, mode: 'in_person', nutritionist: { sessions: 2 } }),
    ],
    addons: [
      addon('ADDON_GYM', 'gym_session', 9900, true),
      { ...addon('ADDON_TRAINER', 'trainer_session', 50000),
        volumeTiers: [{ minQty: 4, discountPct: 10 }], volumeTierFamilies: ['medical'] },
      addon('ADDON_NUTRITIONIST', 'nutritionist_session', 100000),
      addon('ADDON_LAB_TEST', 'lab_test', 100000, true, ['medical']),
    ],
  };
}

const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function choice(value, allowed, label) {
  if (!allowed.includes(value)) bad(`Check ${label}`);
  return value;
}
function choices(value, allowed, label) {
  if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length) bad(`Check ${label}`);
  return value.map(item => choice(item, allowed, label)).sort();
}
function whole(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) bad(`Check ${label}`);
  return value;
}
function copy(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) bad(`Check ${label}`);
  return value.trim();
}
function validateComponents(value) {
  if (!object(value)) bad('Check components');
  const { gym, trainer, nutritionist, nutritionGuidance } = value;
  if (trainer !== null && !object(trainer)) bad('Check trainer component');
  if (nutritionist !== null && !object(nutritionist)) bad('Check nutritionist component');
  return {
    gym: choice(gym, ['unlimited', null], 'gym component'),
    trainer: trainer && { sessions: whole(trainer.sessions, 1, 1000, 'trainer sessions'), mode: choice(trainer.mode, TRAINER_MODES, 'trainer mode') },
    nutritionist: nutritionist && { sessions: whole(nutritionist.sessions, 1, 1000, 'nutritionist sessions') },
    nutritionGuidance: choice(nutritionGuidance, [true, false], 'nutrition guidance'),
  };
}

function validateOffer(offer) {
  const regions = choices(offer.regions, COACHING_REGIONS, 'offer regions');
  const base = validateComponents(offer.components);
  const result = {
    key: offer.key, family: choice(offer.family, COACHING_FAMILIES, 'family'),
    title: copy(offer.title, 120, 'title'), description: copy(offer.description, 500, 'description'), regions,
    durationDays: whole(offer.durationDays, 1, 365, 'duration'),
    amountPaise: whole(offer.amountPaise, 100, MAX_COACHING_AMOUNT_PAISE, 'price in paise'),
    enabled: choice(offer.enabled, [true, false], 'availability'),
    refundPolicy: choice(offer.refundPolicy, REFUND_POLICIES, 'refund policy'), components: base,
  };
  if (offer.regionOverrides !== undefined) {
    if (!object(offer.regionOverrides) || Object.keys(offer.regionOverrides).join() !== 'REST_INDIA' ||
      !regions.includes('REST_INDIA') || !object(offer.regionOverrides.REST_INDIA?.components)) bad('Check REST_INDIA override');
    result.regionOverrides = { REST_INDIA: { components: validateComponents({
      ...base, ...offer.regionOverrides.REST_INDIA.components,
    }) } };
  }
  const remote = result.regionOverrides?.REST_INDIA.components ?? base;
  if (regions.includes('REST_INDIA') && (remote.gym || remote.trainer?.mode === 'in_person')) {
    bad('Gym and in-person training are only available in Gurugram');
  }
  return result;
}

function validateAddon(addon) {
  const kind = choice(addon.kind, ADDON_KINDS, 'add-on kind');
  const families = choices(addon.families, COACHING_FAMILIES, 'add-on families');
  const regions = choices(addon.regions, COACHING_REGIONS, 'add-on regions');
  if (regions.includes('REST_INDIA') && ['gym_session', 'lab_test'].includes(kind)) bad('Gym and lab add-ons are only available in Gurugram');
  if (kind === 'lab_test' && families.includes('wellness')) bad('Lab add-ons require a medical plan');
  const result = {
    key: addon.key, kind, families, regions, unitPaise: whole(addon.unitPaise, 100, MAX_COACHING_AMOUNT_PAISE, 'unit price in paise'),
    requiresActivePlan: choice(addon.requiresActivePlan, [true], 'active plan requirement'),
    enabled: choice(addon.enabled ?? true, [true, false], 'add-on availability'),
  };
  if (addon.volumeTiers !== undefined) {
    if (!Array.isArray(addon.volumeTiers) || !addon.volumeTiers.length) bad('Check volume tiers');
    result.volumeTiers = addon.volumeTiers.map(tier => {
      if (!object(tier)) bad('Check volume tier');
      return { minQty: whole(tier.minQty, 2, MAX_COACHING_ADDON_QUANTITY, 'tier quantity'), discountPct: whole(tier.discountPct, 1, 99, 'tier discount') };
    }).sort((a, b) => a.minQty - b.minQty);
    if (new Set(result.volumeTiers.map(tier => tier.minQty)).size !== result.volumeTiers.length) bad('Volume tier quantities must be unique');
    if (addon.volumeTierFamilies !== undefined) result.volumeTierFamilies = choices(addon.volumeTierFamilies, families, 'volume tier families');
  } else if (addon.volumeTierFamilies !== undefined) bad('Volume tier families require volume tiers');
  return result;
}

export function validateCoachingV2Config(input) {
  if (!Array.isArray(input.offers) || !Array.isArray(input.addons)) bad('Offers and add-ons are required');
  const keys = new Set(RESERVED_KEYS);
  for (const entry of [...input.offers, ...input.addons]) {
    if (!object(entry) || typeof entry.key !== 'string' || !/^[A-Z][A-Z0-9_]{0,49}$/.test(entry.key) || keys.has(entry.key)) bad('Offer and add-on keys must be unique');
    keys.add(entry.key);
  }
  return { schemaVersion: 2, offers: input.offers.map(validateOffer), addons: input.addons.map(validateAddon) };
}
