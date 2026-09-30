// Our own FHIR code systems, for the things no standard terminology names.
//
// WHERE these may appear is narrower than it first looked. The NRCeS
// Observation profiles close Observation.code.coding to LOINC and SNOMED CT
// (validator, IG 6.5.0 - see codeMaps.js), so NONE of these codes is ever an
// Observation's main code. They are used only where FHIR leaves the coding
// open: Observation.component.code (sets, volume, RPE, protein...),
// meta.tag (data source), and identifier systems. Everything that has no
// standard concept at all - the adherence score, plan ticks, self-rated
// stress - leaves in the ledger DocumentReference instead (wellnessBundle.js).
// If you add an entry here, first check it isn't in codeMaps.js's LOINC table
// under another name.
//
// The URIs live under phoolgobhi.com so they are ours to define and never
// collide with anyone else's; they do not need to resolve to be valid FHIR.

export const PG_BASE = 'https://phoolgobhi.com/fhir';

export const PG_SYSTEMS = Object.freeze({
  observation: `${PG_BASE}/CodeSystem/observation`,
  workoutType: `${PG_BASE}/CodeSystem/workout-type`,
  exerciseType: `${PG_BASE}/CodeSystem/exercise-type`,
  planItemKind: `${PG_BASE}/CodeSystem/plan-item-kind`,
  cyclePhase: `${PG_BASE}/CodeSystem/cycle-phase`,
  // meta.tag on every Observation: where the value came from. This is the
  // provenance an insurer-grade view (Stage 2) filters on - a
  // healthkit/health_connect tag means "device data", which Apple 5.1.3(i)
  // and Google's Health Connect policy forbid passing to an insurer.
  dataSource: `${PG_BASE}/CodeSystem/data-source`,
  userId: `${PG_BASE}/sid/user-id`,
  bundleId: `${PG_BASE}/sid/bundle-id`,
});

// Observation codes that have no standard equivalent. Displays are what a
// human reading the raw JSON sees, so they are plain words.
export const PG_OBSERVATION = Object.freeze({
  workoutSession: { code: 'workout-session', display: 'Workout session' },
  exerciseRecord: { code: 'exercise-record', display: 'Exercise record' },
  adherenceScoreDaily: { code: 'adherence-score-daily', display: 'Daily plan-adherence score' },
  planItemCompleted: { code: 'plan-item-completed', display: 'Plan item completed' },
  dailyEnergyIntake: { code: 'daily-energy-intake', display: 'Estimated energy intake for the day' },
  dailyProteinIntake: { code: 'daily-protein-intake', display: 'Estimated protein intake for the day' },
  stressSelfReport: { code: 'stress-self-report', display: 'Self-rated stress' },
  restingHeartRate: { code: 'resting-heart-rate', display: 'Resting heart rate' },
  dailyDistance: { code: 'daily-distance', display: 'Distance moved in the day' },
  cyclePhaseLogged: { code: 'cycle-phase-logged', display: 'Menstrual cycle phase, as logged by the user' },
  // component codes
  workoutType: { code: 'workout-type', display: 'Workout type' },
  exerciseType: { code: 'exercise-type', display: 'Exercise type' },
  durationMinutes: { code: 'duration-minutes', display: 'Duration' },
  completedSets: { code: 'completed-sets', display: 'Completed sets' },
  volumeKg: { code: 'volume-kg', display: 'Training volume (weight x reps)' },
  rpe: { code: 'rpe', display: 'Rate of perceived exertion (1-10)' },
  distance: { code: 'distance', display: 'Distance' },
  avgHeartRate: { code: 'avg-heart-rate', display: 'Average heart rate' },
  scoreOpen: { code: 'score-open', display: 'Score at start of day' },
  scoreHigh: { code: 'score-high', display: 'Highest score in the day' },
  scoreLow: { code: 'score-low', display: 'Lowest score in the day' },
  scorePaused: { code: 'score-paused', display: 'Day was paused' },
  points: { code: 'points', display: 'Points earned' },
  foodEntries: { code: 'food-entries', display: 'Food log entries that day' },
});

export function pgCoding(system, { code, display }) {
  return { system, code, display };
}
