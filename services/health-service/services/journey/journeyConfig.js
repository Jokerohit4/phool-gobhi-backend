import { isoDayIST } from '../../utils/sessionDay.js';
// Journey thresholds — single source of truth for the coach journey.
// Matches the Contracts section of phool-gobhi-build-plan.html exactly.

export const JOURNEY = {
  // The single layer table (one-plan Contracts). consent is the scope required
  // to turn the layer on; null means no consent needed. flags lists the
  // app-config feature flags the layer requires — the server omits a layer
  // whose flags are off. needsSetup is Food's NutritionTarget precondition.
  // optionalConsent is an extra scope that, when held, auto-fills the layer
  // (device health for body) but is never required.
  layers: [
    { layer: 1, key: 'basics',      layerKeys: ['workout','water'],  unlock: { type: 'start' },
      consent: { scope: 'coach.basic' }, flags: ['coachJourney'] },
    { layer: 2, key: 'food',        layerKeys: ['food'],             unlock: { type: 'showed_up_days', need: 3 }, earlyAllowed: true,
      consent: { scope: 'nutrition' }, flags: ['healthMetrics','healthLedger'], needsSetup: true },
    { layer: 3, key: 'body',        layerKeys: ['steps','sleep'],    unlock: { type: 'elapsed_days', need: 7 },
      consent: null, flags: ['coachJourney'], optionalConsent: { scope: 'device_health' } },
    { layer: 4, key: 'supplements', layerKeys: ['supplements'],      unlock: { type: 'elapsed_days', need: 10 },
      consent: { scope: 'coach.supplements' }, flags: ['coachJourney'] },
    { layer: 5, key: 'health',      layerKeys: ['health'],           unlock: { type: 'elapsed_days', need: 15 },
      consent: { scope: 'medical_records' }, flags: ['healthMetrics','healthLedger'] },
  ],
  startLayer: { new_to_gym: 1, just_started: 1, restarting_after_break: 2, experienced: 5 },
  easyStartDays: 14,
  inactivePauseAfterDays: 7,
  steadyWeekMinDays: 2,
  defaultWaterMl: 2500,
  milestones: [ // shown to experienced users instead of locks
    { key: 'league',          label: '4 steady weeks', needSteadyWeeks: 4, requiresSocial: true },
    { key: 'strength_check',  label: 'Strength check-in', needSteadyWeeks: 6 },
    { key: 'health_report',   label: '30-day health report', needDaysSinceStart: 30 },
  ],
};

// Helpers derived from JOURNEY.layers
export const LAYER_OF_LAYER_KEY = Object.fromEntries(
  JOURNEY.layers.flatMap((l) => l.layerKeys.map((k) => [k, l.layer])),
);

export function layerKeysUpTo(startLayer) {
  return JOURNEY.layers.filter((l) => l.layer <= Number(startLayer)).flatMap((l) => l.layerKeys);
}

export function unlockConfigForLayerKey(layerKey) {
  const layer = JOURNEY.layers.find((l) => l.layerKeys.includes(layerKey));
  return layer?.unlock ?? null;
}

export function earlyAllowedForLayerKey(layerKey) {
  const layer = JOURNEY.layers.find((l) => l.layerKeys.includes(layerKey));
  return layer?.earlyAllowed === true;
}

// Own and doctor rows are never locked by the journey. own needs no consent;
// medicine is shown only while medical_records is granted (getOnLayerKeys
// handles that — callers never add these keys themselves).
export const ALWAYS_ON_LAYER_KEYS = ['own', 'medicine'];

// The 9 wire row kinds on the today payload (Contracts · Rows). The food row
// is synthesised, not a PlanItem; the other 8 map to PlanItem kinds.
export const ROW_KINDS = [
  'workout', 'rest', 'water', 'steps', 'sleep', 'supplement', 'own', 'doctor', 'food',
];

// Fallback daily targets when the Prescription has no value (Contracts ·
// rebuild: steps default 6000, sleep default 420 minutes).
export const DEFAULT_STEPS = 6000;
export const DEFAULT_SLEEP_MIN = 420;

// Start layer by experience level (Contracts · Start layer). Applied on every
// read, not only at start; start layer only unlocks, consent is still required.
export function startLayerFor(level) {
  return JOURNEY.startLayer[level] ?? 1;
}
export function elapsedJourneyDays(startedAt, now = new Date()) {
  const day = date => isoDayIST(new Date(date));
  return Math.max(0, Math.floor((Date.parse(day(now)) - Date.parse(day(startedAt))) / 86400000));
}
