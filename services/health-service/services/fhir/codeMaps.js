
// Terminology bindings for the FHIR export (ABHA-FHIR-INTEGRATION.md §C.1).
//
// Two jobs, both deliberately table-driven so a reviewer can check them
// against the IG without reading any logic:
//   1. BiometricMetric -> LOINC code + WellnessRecord section + profile.
//   2. Our stored unit strings -> UCUM.
//
// THE RULE THAT SHAPES THIS FILE (found by running the HAPI validator against
// IG 6.5.0, 2026-09-30): the NRCeS base Observation profile CLOSES the slicing
// on Observation.code.coding by system - a coding must be LOINC or SNOMED CT,
// nothing else - and every WellnessRecord section profile inherits that. The
// section value sets are bound "extensible", which only lets us reach for
// OTHER LOINC/SNOMED codes, never a code system of our own. So:
//   - every `coding` below is LOINC (display copied from the NRCeS value set
//     where the code is in one; the LOINC slice makes display mandatory);
//   - our own detail rides in Observation.component, whose code is NOT sliced;
//   - things with no LOINC/SNOMED concept at all (the daily adherence score,
//     plan ticks, self-rated stress, day distance, non-menstrual cycle phases)
//     are not Observations: they travel in one DocumentReference, as a JSON
//     attachment in our own documented format (wellnessBundle.js).
// Codes outside the value sets (body fat %, HRV, exercise duration) are real
// LOINC used under the extensible binding; the validator checks them against
// LOINC when run with a terminology server.

export const LOINC = 'http://loinc.org';
export const SNOMED = 'http://snomed.info/sct';
export const UCUM = 'http://unitsofmeasure.org';
export const NRCES = 'https://nrces.in/ndhm/fhir/r4/StructureDefinition';

// Section title (the WellnessRecord slice discriminator is `title`, fixed
// strings) and the profile each entry in that section must claim.
export const SECTIONS = Object.freeze({
  vitalSigns: { title: 'Vital Signs', profile: `${NRCES}/ObservationVitalSigns` },
  bodyMeasurement: { title: 'Body Measurement', profile: `${NRCES}/ObservationBodyMeasurement` },
  physicalActivity: { title: 'Physical Activity', profile: `${NRCES}/ObservationPhysicalActivity` },
  generalAssessment: { title: 'General Assessment', profile: `${NRCES}/ObservationGeneralAssessment` },
  womenHealth: { title: 'Women Health', profile: `${NRCES}/ObservationWomenHealth` },
  lifestyle: { title: 'Lifestyle', profile: `${NRCES}/ObservationLifestyle` },
  otherObservations: { title: 'Other Observations', profile: `${NRCES}/Observation` },
  documentReference: { title: 'Document Reference', profile: `${NRCES}/DocumentReference` },
});
// Order the IG lists them in, so every bundle reads the same way.
export const SECTION_ORDER = [
  'vitalSigns', 'bodyMeasurement', 'physicalActivity', 'generalAssessment',
  'womenHealth', 'lifestyle', 'otherObservations', 'documentReference',
];

const loinc = (code, display) => ({ system: LOINC, code, display });

export const HEART_RATE = loinc('8867-4', 'Heart rate');
export const CALORIES_BURNED = loinc('41981-2', 'Calories burned');
export const STEPS = loinc('55423-8', 'Number of steps in unspecified time Pedometer');
// Not in the physical-activity value set (which has no workout concept), so
// used under the extensible binding: the closest LOINC for "a bout of
// exercise lasting N minutes". Sets/volume/RPE/type ride as components.
export const EXERCISE_DURATION = loinc('55411-3', 'Exercise duration');
// In the general-assessment value set. Food totals go here, not Lifestyle:
// Lifestyle's value must be a CodeableConcept from alcohol/tobacco findings.
export const CALORIE_INTAKE = loinc('9052-2', 'Calorie intake total');
// Women Health value set; value[x] there is Quantity|string, so the date
// travels as a string.
export const LMP_START = loinc('8665-2', 'Last menstrual period start date');

// Where each BiometricMetric lands. Sleep sits in Physical Activity, not
// Lifestyle: the IG's own physical-activity value set carries LOINC 93832-4
// "Sleep duration", and following the IG beats following our intuition.
// `category` overrides the section default where a core R4 vital-signs
// profile is triggered by the code (29463-7 -> bodyweight, 8867-4 ->
// heartrate), because those profiles REQUIRE the vital-signs category.
// A metric absent here with `ledger: true` goes to the ledger attachment.
export const BIOMETRIC_MAP = Object.freeze({
  weight: { section: 'bodyMeasurement', coding: [loinc('29463-7', 'Body weight')], text: 'Body weight', category: 'vital-signs' },
  body_fat: { section: 'bodyMeasurement', coding: [loinc('41982-0', 'Percentage of body fat Measured')], text: 'Body fat' },
  // 8867-4 is the value-set concept; "resting" is said in code.text because a
  // second, custom coding is exactly what the closed slice rejects.
  resting_hr: { section: 'vitalSigns', coding: [HEART_RATE], text: 'Resting heart rate' },
  hrv: { section: 'vitalSigns', coding: [loinc('80404-7', 'R-R interval.standard deviation (Heart rate variability)')], text: 'Heart rate variability' },
  sleep_minutes: { section: 'physicalActivity', coding: [loinc('93832-4', 'Sleep duration')], text: 'Sleep duration' },
  steps: { section: 'physicalActivity', coding: [STEPS], text: 'Steps' },
  // A 1-10 self-rating has no LOINC/SNOMED concept and no clinical scale
  // behind it; it goes to the ledger rather than borrowing a code that means
  // something else.
  stress: { ledger: true },
});

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
