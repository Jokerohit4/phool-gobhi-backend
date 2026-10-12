// Journey thresholds — single source of truth for the coach journey.
// Matches the Contracts section of phool-gobhi-build-plan.html exactly.

export const JOURNEY = {
  layers: [
    { layer: 1, key: 'basics',      layerKeys: ['workout','water'],  unlock: { type: 'start' } },
    { layer: 2, key: 'food',        layerKeys: ['food'],             unlock: { type: 'showed_up_days', need: 3 }, earlyAllowed: true },
    { layer: 3, key: 'body',        layerKeys: ['steps','sleep'],    unlock: { type: 'steady_weeks', need: 2 } },
    { layer: 4, key: 'supplements', layerKeys: ['supplements'],      unlock: { type: 'steady_weeks', need: 4 } },
    { layer: 5, key: 'health',      layerKeys: ['health'],           unlock: { type: 'steady_weeks', need: 6 } },
  ],
  startLayer: { new_to_gym: 1, restarting_after_break: 2, experienced: 5 },
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