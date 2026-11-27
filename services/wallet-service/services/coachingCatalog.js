import crypto from 'node:crypto';
import { defaultCoachingConfig } from './coachingDefaults.js';
import { defaultCoachingV2Config } from './coachingV2Config.js';

const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
export function coachingRegion(city) {
  if (typeof city !== 'string' || !city.trim() || city.length > 100) invalid('Choose the city where you want support');
  return ['gurugram', 'gurgaon'].includes(city.trim().toLowerCase().replace(/\s+/g, ' ')) ? 'GURUGRAM' : 'REST_INDIA';
}
export function membershipBenefits(row) {
  const snapshot = row?.offerSnapshot || {}, local = !snapshot.region || snapshot.region === 'GURUGRAM';
  if (snapshot.schemaVersion === 2) {
    return { gymAccess: local && snapshot.components.gym === 'unlimited', trainerFloorSessions: false, doorstepLabs: false };
  }
  const benefits = snapshot.benefits || {};
  return {
    gymAccess: local && (benefits.gymAccess ?? true),
    trainerFloorSessions: local && (benefits.trainerFloorSessions ?? true),
    doorstepLabs: local && (benefits.doorstepLabs ?? (row?.planType === 'QUARTERLY_11999')),
  };
}
const quote = offer => ({ ...offer, offerId: crypto.createHash('sha256').update(JSON.stringify(offer)).digest('hex') });
export function trainerAddonOffer(configuration = defaultCoachingConfig()) {
  const a = (configuration.regions ?? defaultCoachingConfig().regions).GURUGRAM.addon;
  return quote({ ...a, product: 'TRAINER_ADDON_1499', region: 'GURUGRAM', currency: 'INR', available: a.enabled });
}
function publicPlan(p, region, addon) {
  const features = [], details = [];
  const detail = (title, body, whenRisk) => details.push({ title, body, ...(whenRisk ? { whenRisk } : {}) });
  if (p.checkInsPerWeek > 0) {
    features.push(`${p.checkInsPerWeek} coaching check-in${p.checkInsPerWeek === 1 ? '' : 's'} each week`);
    detail('A conversation about your progress', `${p.checkInsPerWeek} check-in${p.checkInsPerWeek === 1 ? '' : 's'} each week during your ${p.durationDays}-day plan. ${p.coachingDescription}`);
  }
  if (p.mealRoutine) { features.push('AI Indian meal guidance connected to your food logs'); detail('An Indian meal routine connected to your logs', p.mealDescription); }
  if (p.gymAccess) {
    features.push(`Partner gym access: ${p.gymVisitsPerMonth} visits / month`, `A partner gym in ${p.gymArea}`);
    detail('Your gym access', `Train at a partner gym in ${p.gymArea}, with ${p.gymVisitsPerMonth} visits each month during your plan. ${p.gymDescription}`);
  }
  if (p.trainerSupport) {
    if (p.freeFormSessions > 0) features.push(`${p.freeFormSessions} included gym form sessions`);
    detail('Support from a qualified trainer', `${p.freeFormSessions} form session${p.freeFormSessions === 1 ? '' : 's'} included. ${p.trainerDescription}${addon.available ? ` Extra floor support is available separately: ${addon.sessions} sessions, valid for ${addon.validityDays} days.` : ''}`);
  }
  if (p.dietitianReview) { features.push('1 human clinical dietitian review'); detail('A human clinical dietitian review', `One review is included during your plan. ${p.clinicalDescription}`); }
  if (p.doctorClearanceForRed) detail('Doctor clearance when you need it', 'A Day-1 doctor clearance call is included when your confirmed risk flag is RED.', 'RED');
  if (p.labCredits > 0) {
    features.push(p.labCredits === 2 ? '2 doorstep blood panels: Day 4 baseline + Day 90 re-test' : '1 doorstep blood panel: Day 4 baseline');
    detail('Your included blood panels', `${p.labCredits === 2 ? 'Two doorstep blood panels: a Day 4 baseline and a Day 90 re-test.' : 'One doorstep baseline blood panel on Day 4.'} Dispatch starts after your 72-hour guarantee window clears. ${p.labDescription}`);
  }
  if (region === 'REST_INDIA') detail('Remote support that fits your city', 'Your included support is delivered remotely. Partner gym access, gym-floor trainer sessions and doorstep panels are excluded.');
  detail('What happens after you join', p.onboardingDescription);
  detail('Your free app stays yours', 'Water, food, mood and workout logging and report uploads stay free. You pay for the guided support described here. Your full-refund guarantee lasts 72 hours after payment.');
  const offer = {
    region, product: p.product, amountPaise: p.amountPaise, currency: 'INR', enabled: p.enabled,
    durationDays: p.durationDays, title: p.title, description: p.description, featured: p.featured,
    badge: p.badge, ctaLabel: p.ctaLabel,
    priceSuffix: p.product === 'MONTHLY_4499' ? (p.durationDays === 30 ? ' / month' : ` / ${p.durationDays} days`) : ' upfront',
    benefits: { gymAccess: p.gymAccess, trainerFloorSessions: p.trainerSupport, doorstepLabs: p.labCredits > 0 },
    freeFormSessions: p.freeFormSessions, labCredits: p.labCredits,
    weeklyCoaching: p.checkInsPerWeek > 0, checkInsPerWeek: p.checkInsPerWeek, mealRoutine: p.mealRoutine,
    dietitianReview: p.dietitianReview, doctorClearanceForRed: p.doctorClearanceForRed,
    gymArea: p.gymArea, gymVisitsPerMonth: p.gymVisitsPerMonth,
    features, riskFeatures: p.doctorClearanceForRed ? ['Day-1 doctor clearance call included'] : [], details,
    guaranteeHours: 72,
    guaranteeDescription: `Try your included onboarding and guided support. Full refund within 72 hours if unsatisfied.${p.gymAccess ? ' You can try up to 2 gym visits during that window.' : ''}${p.labCredits ? ' Lab dispatch opens on Day 4.' : ''}`,
  };
  return { ...quote(offer), available: p.enabled && p.amountPaise !== null,
    unavailableReason: !p.enabled ? 'This plan is currently unavailable' : p.amountPaise === null ? 'Pricing to be announced' : null };
}
export function coachingCatalog(city, configuration = defaultCoachingConfig()) {
  const region = coachingRegion(city), config = (configuration.regions ?? defaultCoachingConfig().regions)[region];
  const addon = trainerAddonOffer(configuration);
  return { region, city: region === 'GURUGRAM' ? 'Gurugram' : city.trim(), label: config.label,
    plans: config.plans.map(plan => publicPlan(plan, region, addon)),
    addon: region === 'GURUGRAM' ? addon : null };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function coachingCatalogV2(city, configuration) {
  const region = coachingRegion(city);
  const { offers, addons } = configuration?.schemaVersion === 2 ? configuration : defaultCoachingV2Config();
  const inRegion = item => item.regions.includes(region);
  const render = (item, resolved) => {
    const offerId = crypto.createHash('sha256').update(canonicalJson({ item, region })).digest('hex');
    return { ...resolved, schemaVersion: 2, offerId, currency: 'INR', region };
  };
  return {
    schemaVersion: 2, region, city: region === 'GURUGRAM' ? 'Gurugram' : city.trim(),
    offers: offers.filter(item => item.enabled === true && inRegion(item)).map(item => {
      const { regionOverrides, ...offer } = item;
      return render(item, { ...offer, components: regionOverrides?.[region]?.components ?? offer.components });
    }),
    addons: addons.filter(item => item.enabled !== false && inRegion(item)).map(item => render(item, item)),
  };
}
export function coachingOffer(product, city, offerId, configuration = defaultCoachingConfig()) {
  const offer = coachingCatalog(city, configuration).plans.find(plan => plan.product === product);
  if (!offer) invalid('Choose one of the two guided plans');
  if (!offer.available) throw Object.assign(new Error(`${offer.unavailableReason}. You can continue with the free app.`), { status: 409 });
  if (offer.offerId !== offerId) throw Object.assign(new Error('The offer changed. Refresh the plans before checkout.'), { status: 409 });
  return offer;
}
