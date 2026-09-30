import { PG_SYSTEMS, PG_OBSERVATION, pgCoding } from './codeSystems.js';

// Terminology bindings for the FHIR export (ABHA-FHIR-INTEGRATION.md §C.1).
//
// Two jobs, both deliberately table-driven so a reviewer can check them
// against the IG without reading any logic:
//   1. BiometricMetric -> LOINC code + WellnessRecord section + profile.
//   2. Our stored unit strings -> UCUM.
//
// LOINC displays are copied from the NRCeS value sets in IG 6.5.0
// (ValueSet-ndhm-body-measurement / -physical-activity / -vital-signs) where
// the code is in one, because the NRCeS Observation profile makes
// coding.display mandatory in its LOINC slice. Codes NOT in those value sets
// (body fat, HRV) are standard LOINC used under the extensible binding,
// because no value-set concept fits them.

export const LOINC = 'http://loinc.org';
export const UCUM = 'http://unitsofmeasure.org';
export const NRCES = 'https://nrces.in/ndhm/fhir/r4/StructureDefinition';

// Section title (the WellnessRecord slice discriminator is `title`, fixed
// strings) and the profile each Observation in that section must claim.
export const SECTIONS = Object.freeze({
  vitalSigns: { title: 'Vital Signs', profile: `${NRCES}/ObservationVitalSigns` },
  bodyMeasurement: { title: 'Body Measurement', profile: `${NRCES}/ObservationBodyMeasurement` },
  physicalActivity: { title: 'Physical Activity', profile: `${NRCES}/ObservationPhysicalActivity` },
  womenHealth: { title: 'Women Health', profile: `${NRCES}/ObservationWomenHealth` },
  lifestyle: { title: 'Lifestyle', profile: `${NRCES}/ObservationLifestyle` },
  otherObservations: { title: 'Other Observations', profile: `${NRCES}/Observation` },
});
// Order the IG lists them in, so every bundle reads the same way.
export const SECTION_ORDER = ['vitalSigns', 'bodyMeasurement', 'physicalActivity', 'womenHealth', 'lifestyle', 'otherObservations'];

const loinc = (code, display) => ({ system: LOINC, code, display });

// Where each BiometricMetric lands. Note sleep sits in Physical Activity, not
// Lifestyle: the IG's own physical-activity value set carries LOINC 93832-4
// "Sleep duration", and following the IG beats following our intuition.
export const BIOMETRIC_MAP = Object.freeze({
  weight: { section: 'bodyMeasurement', coding: [loinc('29463-7', 'Body weight')], text: 'Body weight' },
  body_fat: { section: 'bodyMeasurement', coding: [loinc('41982-0', 'Percentage of body fat Measured')], text: 'Body fat' },
  // 8867-4 "Heart rate" is the value-set concept; the PG coding beside it says
  // "resting", which is what the number actually is.
  resting_hr: {
    section: 'vitalSigns',
    coding: [loinc('8867-4', 'Heart rate'), pgCoding(PG_SYSTEMS.observation, PG_OBSERVATION.restingHeartRate)],
    text: 'Resting heart rate',
  },
  hrv: { section: 'vitalSigns', coding: [loinc('80404-7', 'R-R interval.standard deviation (Heart rate variability)')], text: 'Heart rate variability' },
  sleep_minutes: { section: 'physicalActivity', coding: [loinc('93832-4', 'Sleep duration')], text: 'Sleep duration' },
  steps: { section: 'physicalActivity', coding: [loinc('55423-8', 'Number of steps in unspecified time Pedometer')], text: 'Steps' },
  // A 1-10 self-rating has no LOINC concept; it's a patient-reported number
  // with no clinical scale behind it, so it goes to Other Observations rather
  // than pretending to be a lifestyle finding.
  stress: { section: 'otherObservations', coding: [pgCoding(PG_SYSTEMS.observation, PG_OBSERVATION.stressSelfReport)], text: 'Self-rated stress' },
});

export const CALORIES_BURNED = loinc('41981-2', 'Calories burned');
export const STEPS = BIOMETRIC_MAP.steps.coding[0];
export const HEART_RATE = loinc('8867-4', 'Heart rate');

// Stored unit string -> UCUM. The left side is what biometricService.METRIC_UNITS
// writes (it overwrites whatever the client sent), plus the units the other
// slices use. `{...}` is UCUM's annotation syntax for dimensionless counts.
const UNIT_MAP = Object.freeze({
  kg: { unit: 'kg', code: 'kg' },
  percent: { unit: '%', code: '%' },
  '%': { unit: '%', code: '%' },
  bpm: { unit: 'beats/minute', code: '/min' },
  minutes: { unit: 'min', code: 'min' },
  min: { unit: 'min', code: 'min' },
  seconds: { unit: 's', code: 's' },
  count: { unit: 'steps', code: '{steps}' },
  steps: { unit: 'steps', code: '{steps}' },
  ms: { unit: 'ms', code: 'ms' },
  score: { unit: 'score', code: '{score}' },
  kcal: { unit: 'kcal', code: 'kcal' },
  g: { unit: 'g', code: 'g' },
  m: { unit: 'm', code: 'm' },
  sets: { unit: 'sets', code: '{sets}' },
  points: { unit: 'points', code: '{points}' },
  entries: { unit: 'entries', code: '{entries}' },
});

// A Quantity for `value` in our unit. An unknown unit is NOT guessed at: the
// quantity keeps the human unit string with no UCUM system (still valid FHIR,
// just not machine-comparable) and the caller gets a warning to surface, so a
// new metric added without a mapping shows up in the export response instead
// of being silently mislabelled.
export function toQuantity(value, ourUnit, warnings) {
  const m = UNIT_MAP[ourUnit];
  if (!m) {
    if (warnings) warnings.push({ unit: ourUnit, reason: 'no UCUM mapping; emitted as free-text unit' });
    return { value, unit: ourUnit };
  }
  return { value, unit: m.unit, system: UCUM, code: m.code };
}
