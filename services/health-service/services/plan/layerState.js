import { PrismaClient } from '@prisma/client';
import { JOURNEY, ALWAYS_ON_LAYER_KEYS } from '../journey/journeyConfig.js';
import { isFeatureEnabled } from '../../middleware/requireFeatureFlag.js';

/**
 * Checks if a layer's required flags are enabled.
 * @param {string[]} flags - Array of flag names
 * @returns {Promise<boolean>} True if all flags are enabled
 */
async function areFlagsEnabled(flags) {
  if (!flags || flags.length === 0) return true;
  for (const flag of flags) {
    if (!(await isFeatureEnabled(flag))) return false;
  }
  return true;
}

/**
 * Checks if a consent scope is granted and not stale.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} userId
 * @param {string} scope
 * @returns {Promise<{granted: boolean, reason: 'missing'|'policy_updated'|null}>}
 */
async function checkConsent(prisma, userId, scope) {
  const consent = await prisma.healthConsent.findUnique({ where: { userId } });
  if (!consent || consent.revokedAt) {
    return { granted: false, reason: 'missing' };
  }
  if (!consent.scopes?.includes(scope)) {
    return { granted: false, reason: 'missing' };
  }
  // Check if scope version is stale
  const scopeVersions = consent.scopeVersions || {};
  const policyVersions = {
    nutrition: '2026-09-27',
    medical_records: '2026-09-27',
    'coach.supplements': '2026-09-27',
    'coach.basic': '2026-09-27',
  };
  const policyVersion = policyVersions[scope];
  if (policyVersion && scopeVersions[scope] !== policyVersion) {
    return { granted: false, reason: 'policy_updated' };
  }
  return { granted: true, reason: null };
}

/**
 * Computes the unlock progress for a layer.
 * @param {object} unlock - The unlock config from journeyConfig
 * @param {object} journey - The journey response from getJourney()
 * @returns {object|null} Unlock progress or null if already unlocked
 */
function computeUnlockProgress(unlock, journey) {
  if (!unlock) return null;
  if (unlock.type === 'showed_up_days') {
    return {
      type: 'showed_up_days',
      have: journey.showedUpDays,
      need: unlock.need,
      earlyAllowed: unlock.earlyAllowed === true,
    };
  }
  if (unlock.type === 'steady_weeks') {
    return {
      type: 'steady_weeks',
      have: journey.steadyWeeks,
      need: unlock.need,
      earlyAllowed: unlock.earlyAllowed === true,
    };
  }
  if (unlock.type === 'start') {
    return { type: 'start', have: 1, need: 1, earlyAllowed: false };
  }
  return null;
}

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
  const layers = [];

  for (const layer of JOURNEY.layers) {
    // Check if layer's flags are enabled
    const flagsEnabled = await areFlagsEnabled(layer.flags);
    if (!flagsEnabled) {
      // Layer is left out entirely when flags are off
      continue;
    }

    const isUnlocked = journey?.layers?.some((l) => l.layer === layer.layer && l.unlocked) ?? false;
    const unlockedAt = journey?.layers?.find((l) => l.layer === layer.layer)?.unlockedAt ?? null;
    const isNew = unlockedAt && (Date.now() - new Date(unlockedAt).getTime()) < 3 * 24 * 60 * 60 * 1000;

    // Layer state decision order per Contracts:
    // 1. Flags off -> left out (handled above)
    // 2. Not unlocked -> locked
    // 3. Required consent missing/stale -> needs_consent
    // 4. Food only: no NutritionTarget -> needs_setup
    // 5. Otherwise -> on

    let state = 'on';
    let unlockInfo = null;
    let consentInfo = null;
    let optionalConsentInfo = null;

    if (!isUnlocked) {
      state = 'locked';
      unlockInfo = computeUnlockProgress(layer.unlock, journey);
    } else if (layer.consent?.scope) {
      const consentResult = await checkConsent(prisma, userId, layer.consent.scope);
      if (!consentResult.granted) {
        state = 'needs_consent';
        consentInfo = {
          scope: layer.consent.scope,
          granted: false,
          reason: consentResult.reason,
        };
      } else {
        consentInfo = {
          scope: layer.consent.scope,
          granted: true,
        };
      }
    } else {
      // No consent required for this layer
      consentInfo = { scope: null, granted: true };
    }

    // Food layer specific: needs_setup when unlocked but no NutritionTarget
    if (state === 'on' && layer.key === 'food' && layer.needsSetup) {
      const target = await prisma.nutritionTarget.findFirst({
        where: { userId },
        orderBy: { effectiveFrom: 'desc' },
      });
      if (!target) {
        state = 'needs_setup';
      }
    }

    // Optional consent (device_health for body layer)
    if (layer.optionalConsent?.scope) {
      const optConsent = await checkConsent(prisma, userId, layer.optionalConsent.scope);
      optionalConsentInfo = {
        scope: layer.optionalConsent.scope,
        granted: optConsent.granted,
      };
    }

    layers.push({
      key: layer.key,
      layer: layer.layer,
      state,
      unlockedAt,
      isNew,
      ...(unlockInfo ? { unlock: unlockInfo } : {}),
      ...(consentInfo ? { consent: consentInfo } : {}),
      ...(optionalConsentInfo ? { optionalConsent: optionalConsentInfo } : {}),
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
    .filter((l) => l.state === 'on')
    .flatMap((l) => {
      const layerDef = JOURNEY.layers.find((jl) => jl.key === l.key);
      return layerDef?.layerKeys ?? [];
    });

  const result = [...onLayerKeys, ...ALWAYS_ON_LAYER_KEYS];

  // Add 'medicine' when medical_records consent is granted
  const medicalConsent = await checkConsent(prisma, userId, 'medical_records');
  if (medicalConsent.granted) {
    result.push('medicine');
  }

  return [...new Set(result)]; // Deduplicate
}

export { areFlagsEnabled, checkConsent, computeUnlockProgress };