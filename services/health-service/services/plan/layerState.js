import { currentNutritionTarget } from '../ledger/currentTarget.js';

/**
 * Computes every layer's state (left out / locked / needs_consent / needs_setup / on)
 * from the journey, flags and consents.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} userId
 * @param {{journey?: object, flags?: object}} [options] journey = a getJourney() result; flags from cached app-config when absent
 * @returns {Promise<object[]>} Layer[] as in the /plan/today payload
 */
export async function getLayers(prisma, userId, { journey, flags } = {}) {
  if (journey === undefined) {
    const { getJourney } = await import('../journey/journeyService.js');
    journey = await getJourney(userId);
  }
  const { JOURNEY } = await import('../journey/journeyConfig.js');
  const { isFeatureEnabled } = await import('../../middleware/requireFeatureFlag.js');
  const { hasCoachScopeService } = await import('../coachConsentService.js');
  const { getNutritionConsentService, getMedicalRecordsConsentService, hasNutritionScopeService, hasMedicalRecordsScopeService } = await import('../ledger/ledgerConsentService.js');

  async function flagsEnabled(layer) {
    if (!layer.flags?.length) return true;
    for (const f of layer.flags) {
      // flags object passed in tests may map name -> bool
      if (flags && typeof flags[f] !== 'undefined') {
        if (!flags[f]) return false;
      } else {
        const enabled = await isFeatureEnabled(f);
        if (!enabled) return false;
      }
    }
    return true;
  }

  // Layers used to be evaluated strictly one after another, each awaiting its own
  // consent / target query. They are independent, so evaluate them concurrently
  // (Promise.all keeps config order), and share one lookup per consent scope /
  // target for the duration of this call — several layers name the same scope.
  const memo = new Map();
  const once = (key, fn) => {
    if (!memo.has(key)) memo.set(key, fn());
    return memo.get(key);
  };

  // Returns the layer entry, or null when the layer's flag is off.
  async function evaluateLayer(cfg) {
    const enabled = await flagsEnabled(cfg);
    if (!enabled) return null;

    const jLayer = journey?.layers?.find(l => l.layer === cfg.layer);
    const unlocked = !!jLayer?.unlocked;
    const unlockedAt = jLayer?.unlockedAt ? new Date(jLayer.unlockedAt) : null;

    if (!unlocked) {
      const unlock = cfg.unlock || {};
      const have = unlock.type === 'showed_up_days' ? journey?.showedUpDays ?? 0
                 : unlock.type === 'steady_weeks' ? journey?.steadyWeeks ?? 0
                 : unlock.type === 'elapsed_days' ? journey?.elapsedDays ?? 0
                 : 0;
      return {
        layer: cfg.layer,
        key: cfg.key,
        state: 'locked',
        unlockedAt: unlockedAt ? unlockedAt.toISOString() : null,
        isNew: false,
        unlock: { type: unlock.type, have, need: unlock.need, earlyAllowed: !!cfg.earlyAllowed },
      };
    }

    // consent check
    let needsConsent = false;
    let consentInfo = null;
    if (cfg.consent?.scope) {
      const scope = cfg.consent.scope;
      if (scope === 'coach.basic' || scope === 'coach.supplements') {
        const coachScope = scope === 'coach.basic' ? 'basic' : 'supplements';
        const granted = await once(`coach:${coachScope}`, () => hasCoachScopeService(userId, coachScope));
        if (!granted) {
          needsConsent = true;
          consentInfo = { scope, granted: false, reason: 'missing' };
        }
      } else if (scope === 'nutrition') {
        const consent = await once('nutrition', () => getNutritionConsentService(userId));
        if (!consent?.granted) {
          needsConsent = true;
          consentInfo = { scope, granted: false, reason: consent?.needsReconsent ? 'policy_updated' : 'missing' };
        }
      } else if (scope === 'medical_records') {
        const consent = await once('medical_records', () => getMedicalRecordsConsentService(userId));
        if (!consent?.granted) {
          needsConsent = true;
          consentInfo = { scope, granted: false, reason: consent?.needsReconsent ? 'policy_updated' : 'missing' };
        }
      }
    }

    if (needsConsent) {
      const out = {
        layer: cfg.layer,
        key: cfg.key,
        state: 'needs_consent',
        unlockedAt: unlockedAt ? unlockedAt.toISOString() : null,
        isNew: !!unlockedAt && (Date.now() - unlockedAt.getTime()) < 3 * 24 * 60 * 60 * 1000,
        consent: consentInfo,
      };
      if (cfg.optionalConsent) {
        out.optionalConsent = { scope: cfg.optionalConsent.scope, granted: false };
      }
      return out;
    }

    // food setup
    if (cfg.needsSetup) {
      const target = await once('nutritionTarget', () => currentNutritionTarget(prisma, userId));
      if (!target) {
        return {
          layer: cfg.layer,
          key: cfg.key,
          state: 'needs_setup',
          unlockedAt: unlockedAt ? unlockedAt.toISOString() : null,
          isNew: !!unlockedAt && (Date.now() - unlockedAt.getTime()) < 3 * 24 * 60 * 60 * 1000,
        };
      }
    }

    const isNew = unlockedAt && (Date.now() - unlockedAt.getTime()) < 3 * 24 * 60 * 60 * 1000;
    const outOn = {
      layer: cfg.layer,
      key: cfg.key,
      state: 'on',
      unlockedAt: unlockedAt ? unlockedAt.toISOString() : null,
      isNew: !!isNew,
    };
    if (cfg.consent?.scope) {
      outOn.consent = { scope: cfg.consent.scope, granted: true };
    }
    return outOn;
  }

  const evaluated = await Promise.all(JOURNEY.layers.map(evaluateLayer));
  return evaluated.filter(Boolean);
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
export async function getOnLayerKeys(prisma, userId, { journey, layers: resolvedLayers, medicalGranted: knownMedicalGranted } = {}) {
  const { JOURNEY } = await import('../journey/journeyConfig.js');
  const { hasMedicalRecordsConsentService } = await import('../ledger/ledgerConsentService.js');
  // Callers assembling both views can reuse one consent/setup snapshot.
  const layers = resolvedLayers ?? await getLayers(prisma, userId, { journey });
  const onKeys = [];
  for (const l of layers) {
    if (l.state === 'on') {
      const cfg = JOURNEY.layers.find(c => c.layer === l.layer);
      if (cfg?.layerKeys) {
        let keys = cfg.layerKeys;
        if (journey?.wellnessOnly) {
          const focuses = new Set(journey.wellnessFocuses ?? []);
          keys = keys.filter((key) => {
            if (key === 'workout') return false;
            if (key === 'food') return focuses.has('balanced_eating');
            if (key === 'steps') return focuses.has('daily_movement') || focuses.has('energy');
            if (key === 'sleep') return focuses.has('sleep') || focuses.has('energy');
            return true;
          });
        }
        onKeys.push(...keys);
      }
    }
  }
  onKeys.push('own');
  // A caller that already looked this up (buildToday runs it in parallel with the
  // layer evaluation) passes it in and skips the extra round-trip.
  const medicalGranted = knownMedicalGranted ?? await hasMedicalRecordsConsentService(userId);
  if (medicalGranted) onKeys.push('medicine');
  return [...new Set(onKeys)];
}
