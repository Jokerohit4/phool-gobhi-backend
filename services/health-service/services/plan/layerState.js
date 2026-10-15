/**
 * Computes every layer's state (left out / locked / needs_consent / needs_setup / on)
 * from the journey, flags and consents.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} userId
 * @param {{journey?: object, flags?: object}} [options] journey = a getJourney() result; flags from cached app-config when absent
 * @returns {Promise<object[]>} Layer[] as in the /plan/today payload
 */
import { JOURNEY } from '../journey/journeyConfig.js';
import { ALWAYS_ON_LAYER_KEYS } from '../journey/journeyConfig.js';
import { isScopeStale, NUTRITION_SCOPE, MEDICAL_RECORDS_SCOPE } from '../ledger/ledgerConsentService.js';
import { BASIC_SCOPE, SUPPLEMENTS_SCOPE } from '../coachConsentService.js';

export async function getLayers(prisma, userId, { journey, flags } = {}) {
  if (!journey) {
    const { getJourney } = await import('../journey/journeyService.js');
    journey = await getJourney(userId);
  }
  if (!flags) {
    const { getAppConfig } = await import('../../utils/fetchInternal.js');
    const config = await getAppConfig();
    flags = config?.flags || {};
  }

  const journeyProgress = journey?.journeyProgress;
  const showedUpDays = journeyProgress?.showedUpDays || 0;
  const steadyWeeks = journeyProgress?.steadyWeeks || 0;
  const startLayer = journeyProgress?.startLayer || 1;
  const experienceLevel = journeyProgress?.experienceLevel || 'new_to_gym';

  // Get consents
  const [coachConsents, nutritionConsent, medicalConsent, deviceHealthConsent] = await Promise.all([
    prisma.coachConsent.findMany({ where: { userId, revokedAt: null }, select: { scopes: true } }),
    prisma.healthConsent.findFirst({ where: { userId, revokedAt: null, scopes: { has: NUTRITION_SCOPE } }, select: { scopes: true, scopeVersions: true } }),
    prisma.healthConsent.findFirst({ where: { userId, revokedAt: null, scopes: { has: MEDICAL_RECORDS_SCOPE } }, select: { scopes: true, scopeVersions: true } }),
    prisma.healthConsent.findFirst({ where: { userId, revokedAt: null, scopes: { has: 'device_health' } }, select: { scopes: true } }),
  ]);

  const coachScopes = coachConsents.flatMap(c => c.scopes || []);
  const hasCoachBasic = coachScopes.includes(BASIC_SCOPE);
  const hasCoachSupplements = coachScopes.includes(SUPPLEMENTS_SCOPE);

  const layers = [];

  for (const layerDef of JOURNEY.layers) {
    const layer = layerDef.layer;
    const key = layerDef.key;
    const layerKeys = layerDef.layerKeys;
    const unlock = layerDef.unlock;
    const consent = layerDef.consent;
    const layerFlags = layerDef.flags || [];
    const needsSetup = layerDef.needsSetup;
    const optionalConsent = layerDef.optionalConsent;

    // 1. Layer's flags are off → left out
    const flagsOn = layerFlags.every(f => flags[f] === true);
    if (!flagsOn) {
      continue; // left out of every response
    }

    // 2. Not unlocked → locked
    let unlocked = false;
    let unlockInfo = null;
    if (unlock.type === 'start') {
      unlocked = startLayer >= layer;
      unlockInfo = { type: 'start_level', have: startLayer, need: layer, earlyAllowed: false };
    } else if (unlock.type === 'showed_up_days') {
      const have = showedUpDays;
      const need = unlock.need;
      unlocked = have >= need || (unlock.earlyAllowed && have > 0);
      unlockInfo = { type: 'showed_up_days', have, need, earlyAllowed: unlock.earlyAllowed };
    } else if (unlock.type === 'steady_weeks') {
      const have = steadyWeeks;
      const need = unlock.need;
      unlocked = have >= need;
      unlockInfo = { type: 'steady_weeks', have, need, earlyAllowed: false };
    } else {
      unlocked = false;
      unlockInfo = { type: 'unknown', have: 0, need: 0, earlyAllowed: false };
    }

    if (!unlocked) {
      layers.push({
        key,
        layer,
        state: 'locked',
        unlockedAt: null,
        isNew: false,
        unlock: unlockInfo,
        consent: consent ? { scope: consent.scope, granted: false, reason: 'missing' } : null,
        optionalConsent: optionalConsent ? { scope: optionalConsent.scope, granted: !!optionalConsent } : null,
      });
      continue;
    }

    // 3. Required consent missing or on old policy version → needs_consent
    if (consent) {
      let granted = false;
      let reason = 'missing';
      if (consent.scope === NUTRITION_SCOPE) {
        if (nutritionConsent && !isScopeStale(nutritionConsent, NUTRITION_SCOPE)) {
          granted = true;
        } else if (nutritionConsent) {
          reason = 'policy_updated';
        }
      } else if (consent.scope === MEDICAL_RECORDS_SCOPE) {
        if (medicalConsent && !isScopeStale(medicalConsent, MEDICAL_RECORDS_SCOPE)) {
          granted = true;
        } else if (medicalConsent) {
          reason = 'policy_updated';
        }
      } else if (consent.scope === BASIC_SCOPE) {
        granted = hasCoachBasic;
      } else if (consent.scope === SUPPLEMENTS_SCOPE) {
        granted = hasCoachSupplements;
      }
      if (!granted) {
        layers.push({
          key,
          layer,
          state: 'needs_consent',
          unlockedAt: journeyProgress?.layerUnlockedAt?.[key] || null,
          isNew: false,
          unlock: unlockInfo,
          consent: { scope: consent.scope, granted: false, reason },
          optionalConsent: optionalConsent ? { scope: optionalConsent.scope, granted: !!optionalConsent } : null,
        });
        continue;
      }
    }

    // 4. Food only: no NutritionTarget → needs_setup
    if (needsSetup) {
      const target = await prisma.nutritionTarget.findFirst({ where: { userId } });
      if (!target) {
        layers.push({
          key,
          layer,
          state: 'needs_setup',
          unlockedAt: journeyProgress?.layerUnlockedAt?.[key] || null,
          isNew: false,
          unlock: unlockInfo,
          consent: consent ? { scope: consent.scope, granted: true } : null,
          optionalConsent: optionalConsent ? { scope: optionalConsent.scope, granted: !!optionalConsent } : null,
        });
        continue;
      }
    }

    // 5. Otherwise → on
    const unlockedAt = journeyProgress?.layerUnlockedAt?.[key] || null;
    const isNew = unlockedAt && (Date.now() - new Date(unlockedAt).getTime()) < 3 * 24 * 60 * 60 * 1000;

    layers.push({
      key,
      layer,
      state: 'on',
      unlockedAt,
      isNew,
      unlock: null,
      consent: consent ? { scope: consent.scope, granted: true } : null,
      optionalConsent: optionalConsent ? { scope: optionalConsent.scope, granted: !!optionalConsent } : null,
    });
  }

  return layers;
}

/**
 * Returns the row layerKeys of on layers plus 'own', and 'medicine' when
 * medical_records is granted. Callers never add ALWAYS_ON_LAYER_KEYS themselves.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} userId
 * @param {{journey?: object}} [options]
 * @returns {Promise<string[]>}
 */
export async function getOnLayerKeys(prisma, userId, { journey } = {}) {
  const layers = await getLayers(prisma, userId, { journey });
  const onLayerKeys = layers
    .filter(l => l.state === 'on')
    .flatMap(l => l.key === 'food' ? ['food'] : l.key === 'body' ? ['steps', 'sleep'] : l.key === 'supplements' ? ['supplements'] : l.key === 'basics' ? ['workout', 'water'] : l.key === 'health' ? ['health'] : []);
  
  // Add always-on keys
  const result = [...onLayerKeys, 'own'];
  
  // Add medicine if medical_records consent is granted
  const medicalConsent = await prisma.healthConsent.findFirst({
    where: { userId, revokedAt: null, scopes: { has: MEDICAL_RECORDS_SCOPE } },
    select: { scopes: true, scopeVersions: true },
  });
  if (medicalConsent && !isScopeStale(medicalConsent, MEDICAL_RECORDS_SCOPE)) {
    result.push('medicine');
  }

  return result;
}