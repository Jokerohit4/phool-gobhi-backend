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

  const layers = [];
  for (const cfg of JOURNEY.layers) {
    const enabled = await flagsEnabled(cfg);
    if (!enabled) continue;

    const jLayer = journey?.layers?.find(l => l.layer === cfg.layer);
    const unlocked = !!jLayer?.unlocked;
    const unlockedAt = jLayer?.unlockedAt ? new Date(jLayer.unlockedAt) : null;

    if (!unlocked) {
      const unlock = cfg.unlock || {};
      const have = unlock.type === 'showed_up_days' ? journey?.showedUpDays ?? 0
                 : unlock.type === 'steady_weeks' ? journey?.steadyWeeks ?? 0
                 : 0;
      layers.push({
        layer: cfg.layer,
        key: cfg.key,
        state: 'locked',
        unlockedAt: unlockedAt ? unlockedAt.toISOString() : null,
        isNew: false,
        unlock: { type: unlock.type, have, need: unlock.need, earlyAllowed: !!cfg.earlyAllowed },
      });
      continue;
    }

    // consent check
    let needsConsent = false;
    let consentInfo = null;
    if (cfg.consent?.scope) {
      const scope = cfg.consent.scope;
      if (scope === 'coach.basic' || scope === 'coach.supplements') {
        const coachScope = scope === 'coach.basic' ? 'basic' : 'supplements';
        const granted = await hasCoachScopeService(userId, coachScope);
        if (!granted) {
          needsConsent = true;
          consentInfo = { scope, granted: false, reason: 'missing' };
        }
      } else if (scope === 'nutrition') {
        const consent = await getNutritionConsentService(userId);
        if (!consent?.granted) {
          needsConsent = true;
          consentInfo = { scope, granted: false, reason: consent?.needsReconsent ? 'policy_updated' : 'missing' };
        }
      } else if (scope === 'medical_records') {
        const consent = await getMedicalRecordsConsentService(userId);
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
      layers.push(out);
      continue;
    }

    // food setup
    if (cfg.needsSetup) {
      const target = await prisma.nutritionTarget.findUnique({ where: { userId } });
      if (!target) {
        layers.push({
          layer: cfg.layer,
          key: cfg.key,
          state: 'needs_setup',
          unlockedAt: unlockedAt ? unlockedAt.toISOString() : null,
          isNew: !!unlockedAt && (Date.now() - unlockedAt.getTime()) < 3 * 24 * 60 * 60 * 1000,
        });
        continue;
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
    layers.push(outOn);
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
  const { JOURNEY } = await import('../journey/journeyConfig.js');
  const { hasMedicalRecordsConsentService } = await import('../ledger/ledgerConsentService.js');
  const layers = await getLayers(prisma, userId, { journey });
  const onKeys = [];
  for (const l of layers) {
    if (l.state === 'on') {
      const cfg = JOURNEY.layers.find(c => c.layer === l.layer);
      if (cfg?.layerKeys) onKeys.push(...cfg.layerKeys);
    }
  }
  onKeys.push('own');
  const medicalGranted = await hasMedicalRecordsConsentService(userId);
  if (medicalGranted) onKeys.push('medicine');
  return [...new Set(onKeys)];
}
