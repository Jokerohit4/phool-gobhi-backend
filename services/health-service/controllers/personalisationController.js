import * as personalisationService from '../services/personalisationService.js';
import { serializeDecimals } from '../utils/serializeDecimals.js';

const EXPERIENCE_LEVELS = ['none', 'lt_1_year', 'one_to_three_years', 'over_three_years'];
const ENERGY_PATTERNS = ['morning', 'afternoon', 'evening'];
const PROGRAMMING_MODES = ['neutral', 'female_default', 'low_impact_recovery'];
const INJURY_ZONES = ['knee', 'shoulder', 'lower_back', 'wrist', 'neck'];

// Same posture as measurementController's bounds: reject typos and unit
// mix-ups, never comment on the value itself.
const HEIGHT_MIN_CM = 90;
const HEIGHT_MAX_CM = 250;
const WEIGHT_MIN_KG = 20;
const WEIGHT_MAX_KG = 400;

export const getProfile = async (req, res) => {
  try {
    const profile = await personalisationService.getProfileService(req.userId);
    res.json({
      data: {
        ...serializeDecimals(profile),
        // The client renders the chip sets from this rather than hardcoding
        // its own copy, so adding a zone/level later needs no app release.
        options: {
          experienceLevels: EXPERIENCE_LEVELS,
          energyPatterns: ENERGY_PATTERNS,
          injuryZones: INJURY_ZONES,
          programmingModes: PROGRAMMING_MODES,
        },
      },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const updateProfile = async (req, res) => {
  try {
    const { heightCm, setupWeightKg, experienceLevel, injuryZones, energyPattern, preferredRestDay } =
      req.body || {};

    if (heightCm !== undefined && heightCm !== null) {
      const h = Number(heightCm);
      if (!Number.isInteger(h) || h < HEIGHT_MIN_CM || h > HEIGHT_MAX_CM) {
        return res.status(400).json({ error: `heightCm must be between ${HEIGHT_MIN_CM} and ${HEIGHT_MAX_CM}` });
      }
    }
    if (setupWeightKg !== undefined && setupWeightKg !== null) {
      const w = Number(setupWeightKg);
      if (!Number.isFinite(w) || w < WEIGHT_MIN_KG || w > WEIGHT_MAX_KG) {
        return res.status(400).json({ error: `setupWeightKg must be between ${WEIGHT_MIN_KG} and ${WEIGHT_MAX_KG}` });
      }
    }
    if (experienceLevel !== undefined && experienceLevel !== null
        && !EXPERIENCE_LEVELS.includes(experienceLevel)) {
      return res.status(400).json({ error: `experienceLevel must be one of: ${EXPERIENCE_LEVELS.join(', ')}` });
    }
    if (energyPattern !== undefined && energyPattern !== null
        && !ENERGY_PATTERNS.includes(energyPattern)) {
      return res.status(400).json({ error: `energyPattern must be one of: ${ENERGY_PATTERNS.join(', ')}` });
    }
    if (injuryZones !== undefined && injuryZones !== null) {
      if (!Array.isArray(injuryZones) || injuryZones.some((z) => !INJURY_ZONES.includes(z))) {
        return res.status(400).json({ error: `injuryZones must be a subset of: ${INJURY_ZONES.join(', ')}` });
      }
    }
    if (preferredRestDay !== undefined && preferredRestDay !== null) {
      const d = Number(preferredRestDay);
      if (!Number.isInteger(d) || d < 0 || d > 6) {
        return res.status(400).json({ error: 'preferredRestDay must be an integer 0-6 (0 = Sunday)' });
      }
    }

    const profile = await personalisationService.upsertProfileService(req.userId, {
      heightCm, setupWeightKg, experienceLevel, injuryZones, energyPattern, preferredRestDay,
    });
    res.json({ data: serializeDecimals(profile) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// FR-25/27. The client sends only the derived mode — never the reason behind
// it (see the ProgrammingMode schema comment). Anything but neutral requires
// a privacyVersion, which is what records that consent was given.
export const setProgrammingMode = async (req, res) => {
  try {
    const { programmingMode, privacyVersion } = req.body || {};
    if (!PROGRAMMING_MODES.includes(programmingMode)) {
      return res.status(400).json({ error: `programmingMode must be one of: ${PROGRAMMING_MODES.join(', ')}` });
    }
    const profile = await personalisationService.setProgrammingModeService(
      req.userId,
      programmingMode,
      privacyVersion,
    );
    res.json({ data: serializeDecimals(profile) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
