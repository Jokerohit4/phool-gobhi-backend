// Stage 0 of ABHA-FHIR-INTEGRATION.md: the FHIR WellnessRecord export.
//
// What's under test is the contract the design doc rests on, not FHIR itself
// (conformance is the HAPI validator's job, run out of CI):
//   1. buildRangeSeriesService with no `include` is byte-identical to what the
//      JSON/CSV download has always returned, and makes the same two reads.
//   2. One fixture -> JSON, CSV and FHIR carry the same numbers. That is the
//      "an export and the screen never disagree" rule, asserted.
//   3. The refusals: no Condition, no predicted cycle phase, no cycle at all
//      unless included, no rest day as activity.
//   4. Every quantity is UCUM-coded or reported as a warning.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const reads = [];
let fx = {};
const track = (name, rows) => async (args) => {
  reads.push({ name, args });
  return typeof rows === 'function' ? rows(args) : rows;
};

let exportService, seriesToWellnessBundle, FHIR_DEFAULT_INCLUDES;

test('setup: mock prisma once, import once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.workoutSession = { findMany: track('workoutSession', () => fx.sessions) };
          this.biometricEntry = { findMany: track('biometricEntry', () => fx.biometrics) };
          this.exerciseRecord = { findMany: track('exerciseRecord', () => fx.records) };
          this.dailyActivityMetric = { findMany: track('dailyActivityMetric', () => fx.activity) };
          this.planItemCompletion = { findMany: track('planItemCompletion', () => fx.completions) };
          this.scoreDaySnapshot = { findMany: track('scoreDaySnapshot', () => fx.snapshots) };
          this.foodLog = { findMany: track('foodLog', () => fx.foodLogs) };
          this.cyclePhaseEntry = {
            findMany: track('cyclePhaseEntry', (args) => fx.cycle.filter((e) => e.source === args.where.source)),
            count: async ({ where }) => fx.cycle.filter((e) => e.source === where.source).length,
          };
          this.healthCondition = { count: async () => fx.conditionCount };
          this.medicalDocument = { count: async () => fx.documentCount };
        }
      },
      Prisma: {},
    },
  });
  exportService = await import('../services/exportService.js');
  ({ seriesToWellnessBundle, FHIR_DEFAULT_INCLUDES } = await import('../services/fhir/wellnessBundle.js'));
});

function fixture() {
  return {
    sessions: [
      {
        id: 1, localDate: '2026-09-08',
        startedAt: new Date('2026-09-08T03:30:00Z'), endedAt: new Date('2026-09-08T04:30:00Z'),
        type: 'strength', rpe: 7, gymId: 9, bookingId: 100,
        exercises: [{
          exercise: { name: 'Bench Press', muscleGroup: 'chest' },
          sets: [
            { completed: true, weightKg: 60, reps: 8 },
            { completed: true, weightKg: 60, reps: 8 },
            { completed: false, weightKg: 60, reps: 8 },
          ],
        }],
      },
      {
        id: 2, localDate: '2026-09-09',
        startedAt: new Date('2026-09-09T03:30:00Z'), endedAt: new Date('2026-09-09T03:31:00Z'),
        type: 'rest', rpe: null, gymId: null, bookingId: null, exercises: [],
      },
    ],
    biometrics: [
      { localDate: '2026-09-08', metric: 'weight', value: '74.20', unit: 'kg', source: 'manual', createdAt: new Date('2026-09-09T03:42:00Z') },
      { localDate: '2026-09-08', metric: 'body_fat', value: '18.50', unit: 'percent', source: 'manual', createdAt: new Date('2026-09-08T15:00:00Z') },
      { localDate: '2026-09-08', metric: 'resting_hr', value: '61.00', unit: 'bpm', source: 'health_connect', createdAt: new Date('2026-09-08T16:00:00Z') },
    ],
    records: [
      { id: 5, source: 'gps_tracker', type: 'run', startedAt: new Date('2026-09-08T00:30:00Z'), endedAt: new Date('2026-09-08T01:00:00Z'),
        durationSeconds: 1800, caloriesBurned: 310, distanceMeters: '5012.40', avgHeartRateBpm: 152, createdAt: new Date('2026-09-08T01:01:00Z') },
    ],
    activity: [
      { date: '2026-09-08', steps: 9120, activeCalories: 420, distanceMeters: '6400.00', restingHeartRateBpm: 60, source: 'health_connect', syncedAt: new Date('2026-09-08T18:00:00Z') },
    ],
    completions: [
      { localDate: '2026-09-08', how: 'manual', points: 10, createdAt: new Date('2026-09-10T05:00:00Z'), planItem: { kind: 'habit' } },
    ],
    snapshots: [
      { localDate: '2026-09-08', open: 40, high: 81, low: 38, close: 72, paused: false, rulesVersion: 'score-v3', breakdown: [{ label: 'Paneer tikka' }], closedAt: new Date('2026-09-08T18:30:00Z') },
    ],
    foodLogs: [
      { localDate: '2026-09-08', nutrients: { kcal: 612.4, proteinG: 31.25 }, createdAt: new Date('2026-09-08T07:00:00Z') },
      { localDate: '2026-09-08', nutrients: { kcal: 488.1, proteinG: 20.1 }, createdAt: new Date('2026-09-08T14:00:00Z') },
    ],
    cycle: [
      { startDate: new Date('2026-09-02T00:00:00Z'), endDate: new Date('2026-09-06T00:00:00Z'), phase: 'menstrual', source: 'user_logged', createdAt: new Date('2026-09-06T10:00:00Z') },
      { startDate: new Date('2026-09-30T00:00:00Z'), endDate: null, phase: 'menstrual', source: 'predicted', createdAt: new Date('2026-09-06T10:00:00Z') },
    ],
    conditionCount: 2,
    documentCount: 1,
  };
}

// Deterministic ids so assertions can follow references.
function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

// What FR-16 returned before `include` existed, for the same fixture, written
// out literally. If this string changes, a user's existing download changed.
const LEGACY_JSON = JSON.stringify({
  sessions: [
    { sessionId: 1, localDate: '2026-09-08', startedAt: '2026-09-08T03:30:00.000Z', endedAt: '2026-09-08T04:30:00.000Z', durationMinutes: 60, type: 'strength', rpe: 7, gymId: 9, bookingId: 100, exerciseCount: 1, completedSets: 2, volumeKg: 960 },
    { sessionId: 2, localDate: '2026-09-09', startedAt: '2026-09-09T03:30:00.000Z', endedAt: '2026-09-09T03:31:00.000Z', durationMinutes: 1, type: 'rest', rpe: null, gymId: null, bookingId: null, exerciseCount: 0, completedSets: 0, volumeKg: 0 },
  ],
  biometrics: [
    { localDate: '2026-09-08', metric: 'weight', value: 74.2, unit: 'kg', source: 'manual' },
    { localDate: '2026-09-08', metric: 'body_fat', value: 18.5, unit: 'percent', source: 'manual' },
    { localDate: '2026-09-08', metric: 'resting_hr', value: 61, unit: 'bpm', source: 'health_connect' },
  ],
});

test('no include: byte-identical to the legacy shape, and only the two legacy reads', async () => {
  fx = fixture();
  for (const opts of [undefined, {}, { include: [] }]) {
    reads.length = 0;
    const series = await exportService.buildRangeSeriesService(1, { from: '2026-09-01', to: '2026-09-30' }, opts);
    assert.equal(JSON.stringify(series), LEGACY_JSON);
    assert.deepEqual(reads.map((r) => r.name).sort(), ['biometricEntry', 'workoutSession']);
  }
});

test('an unknown include fails loudly instead of silently dropping a table', async () => {
  fx = fixture();
  await assert.rejects(
    exportService.buildRangeSeriesService(1, {}, { include: ['scoreSnapshot'] }),
    /unknown include: scoreSnapshot/,
  );
});

test('provenance adds recordedAt without reordering or changing any legacy field', async () => {
  fx = fixture();
  const legacy = JSON.parse(LEGACY_JSON);
  const series = await exportService.buildRangeSeriesService(1, {}, { include: ['provenance'] });
  const strip = ({ recordedAt, ...rest }) => rest;
  assert.deepEqual(JSON.parse(JSON.stringify(series.biometrics.map(strip))), legacy.biometrics);
  assert.deepEqual(JSON.parse(JSON.stringify(series.sessions.map(strip))), legacy.sessions);
  assert.equal(series.biometrics[0].recordedAt.toISOString(), '2026-09-09T03:42:00.000Z');
});

test('cycle: predictions are never read; logged phases only when included', async () => {
  fx = fixture();
  const without = await exportService.buildRangeSeriesService(1, {}, { include: [...FHIR_DEFAULT_INCLUDES] });
  assert.equal(without.cycleLogged, undefined);
  const withCycle = await exportService.buildRangeSeriesService(1, {}, { include: [...FHIR_DEFAULT_INCLUDES, 'cycleLogged'] });
  assert.deepEqual(withCycle.cycleLogged.map((e) => e.startDate), ['2026-09-02']);
  const { bundle } = seriesToWellnessBundle(withCycle, { userId: 1, generatedAt: new Date('2026-09-30T10:00:00Z'), newId: ids() });
  const text = JSON.stringify(bundle);
  assert.doesNotMatch(text, /2026-09-30T00|predicted/);
  const noCycle = seriesToWellnessBundle(without, { userId: 1, generatedAt: new Date('2026-09-30T10:00:00Z'), newId: ids() });
  assert.ok(!noCycle.bundle.entry[0].resource.section.some((s) => s.title === 'Women Health'));
});

// Minimal CSV reader for the two-table file seriesToCsv writes. Only needs to
// handle what the fixture contains (no embedded quotes).
function parseCsvTables(csv) {
  const tables = {};
  let name = null;
  let header = null;
  for (const line of csv.split('\n')) {
    if (line.startsWith('# ')) { name = line.slice(2); tables[name] = []; header = null; continue; }
    if (!line) continue;
    const cells = line.split(',');
    if (!header) { header = cells; continue; }
    tables[name].push(Object.fromEntries(header.map((h, i) => [h, cells[i]])));
  }
  return tables;
}

const obsByCode = (bundle, code) => bundle.entry
  .map((e) => e.resource)
  .filter((r) => r.resourceType === 'Observation' && r.code.coding.some((c) => c.code === code));
const componentValue = (obs, code) => obs.component.find((c) => c.code.coding.some((x) => x.code === code))?.valueQuantity?.value;

test('invariant: JSON, CSV and FHIR carry the same numbers for the same range', async () => {
  fx = fixture();
  const json = await exportService.buildRangeSeriesService(1, {});
  const csv = parseCsvTables(exportService.seriesToCsv(json));
  const series = await exportService.buildRangeSeriesService(1, {}, { include: [...FHIR_DEFAULT_INCLUDES] });
  const { bundle } = seriesToWellnessBundle(series, { userId: 1, generatedAt: '2026-09-30T10:00:00Z', newId: ids() });

  // Biometrics: value per metric, identical in all three.
  const loincFor = { weight: '29463-7', body_fat: '41982-0', resting_hr: 'resting-heart-rate' };
  for (const row of json.biometrics) {
    const csvRow = csv.biometrics.find((r) => r.metric === row.metric && r.localDate === row.localDate);
    const [obs] = obsByCode(bundle, loincFor[row.metric]).filter((o) => o.effectiveDateTime === row.localDate && o.meta.tag?.[0].code === row.source);
    assert.ok(obs, `no FHIR observation for ${row.metric}`);
    assert.equal(Number(csvRow.value), row.value);
    assert.equal(obs.valueQuantity.value, row.value, `${row.metric} differs between JSON and FHIR`);
  }

  // Sessions: volume, sets, minutes. The rest day is in JSON/CSV, not in FHIR.
  const strength = json.sessions.find((s) => s.type === 'strength');
  const csvStrength = csv.sessions.find((r) => r.sessionId === String(strength.sessionId));
  const [obs] = obsByCode(bundle, 'workout-session');
  assert.equal(obsByCode(bundle, 'workout-session').length, 1, 'rest session must not become an activity');
  for (const [field, code] of [['volumeKg', 'volume-kg'], ['completedSets', 'completed-sets'], ['durationMinutes', 'duration-minutes'], ['rpe', 'rpe']]) {
    assert.equal(Number(csvStrength[field]), strength[field]);
    assert.equal(componentValue(obs, code), strength[field], `${field} differs between JSON and FHIR`);
  }
  assert.equal(obs.effectivePeriod.start, strength.startedAt.toISOString());
});

test('the bundle is a WellnessRecord document whose references all resolve', async () => {
  fx = fixture();
  const series = await exportService.buildRangeSeriesService(1, {}, { include: [...FHIR_DEFAULT_INCLUDES] });
  const { bundle } = seriesToWellnessBundle(series, { userId: 7, generatedAt: '2026-09-30T10:00:00Z', newId: ids() });
  assert.equal(bundle.type, 'document');
  assert.equal(bundle.meta.versionId, '1');
  assert.ok(bundle.identifier.system && bundle.identifier.value);
  const [first] = bundle.entry;
  assert.equal(first.resource.resourceType, 'Composition', 'a document bundle starts with its Composition');
  assert.equal(first.resource.type.text, 'Wellness Record');
  const allowed = new Set(['Vital Signs', 'Body Measurement', 'Physical Activity', 'General Assessment', 'Women Health', 'Lifestyle', 'Other Observations', 'Document Reference']);
  const fullUrls = new Set(bundle.entry.map((e) => e.fullUrl));
  for (const section of first.resource.section) {
    assert.ok(allowed.has(section.title), `unknown section title ${section.title}`);
    for (const ref of section.entry || []) assert.ok(fullUrls.has(ref.reference), `dangling ${ref.reference}`);
  }
  const patient = bundle.entry.find((e) => e.resource.resourceType === 'Patient').resource;
  assert.equal(patient.identifier[0].value, '7');
  // The score keeps its rules version and never ships the free-text breakdown.
  const [score] = obsByCode(bundle, 'adherence-score-daily');
  assert.equal(score.valueQuantity.value, 72);
  assert.match(score.method.text, /score-v3/);
  assert.doesNotMatch(JSON.stringify(bundle), /Paneer tikka/);
  // Food totals are summed per day and flagged as estimates.
  const [kcal] = obsByCode(bundle, 'daily-energy-intake');
  assert.equal(kcal.valueQuantity.value, 1101);
  assert.match(kcal.note[0].text, /estimates/);
  // A late tick is visible as late.
  const [tick] = obsByCode(bundle, 'plan-item-completed');
  assert.equal(tick.effectiveDateTime, '2026-09-08');
  assert.equal(tick.issued, '2026-09-10T05:00:00.000Z');
});

test('never a Condition, and every quantity is UCUM or a reported warning', async () => {
  fx = fixture();
  const series = await exportService.buildRangeSeriesService(1, {}, { include: [...FHIR_DEFAULT_INCLUDES, 'cycleLogged'] });
  series.biometrics.push({ localDate: '2026-09-08', metric: 'weight', value: 150, unit: 'lb', source: 'manual' });
  const { bundle, conversionWarnings } = seriesToWellnessBundle(series, { userId: 1, generatedAt: '2026-09-30T10:00:00Z', newId: ids() });
  assert.ok(!bundle.entry.some((e) => e.resource.resourceType === 'Condition'));
  const quantities = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if ('value' in node && 'unit' in node && !('resourceType' in node)) quantities.push(node);
    for (const v of Object.values(node)) walk(v);
  };
  walk(bundle);
  const uncoded = quantities.filter((q) => q.system !== 'http://unitsofmeasure.org');
  assert.deepEqual(uncoded.map((q) => q.unit), ['lb']);
  assert.deepEqual(conversionWarnings.map((w) => w.unit), ['lb']);
});

test('an empty range is still a valid-shaped document', () => {
  const { bundle } = seriesToWellnessBundle({ sessions: [], biometrics: [] }, { userId: 1, generatedAt: '2026-09-30T10:00:00Z', newId: ids() });
  const [section] = bundle.entry[0].resource.section;
  assert.equal(section.title, 'Other Observations');
  assert.ok(section.emptyReason && section.text);
});

test('withheld items are counted with a reason, cycle only when not included', async () => {
  fx = fixture();
  const withheld = await exportService.countFhirWithheldService(1, {});
  assert.deepEqual(withheld.map((w) => [w.kind, w.count]), [['HealthCondition', 2], ['MedicalDocument', 1], ['CyclePhaseEntry', 1]]);
  for (const w of withheld) assert.ok(w.reason.length > 20);
  const included = await exportService.countFhirWithheldService(1, { cycleIncluded: true });
  assert.ok(!included.some((w) => w.kind === 'CyclePhaseEntry'));
  const refused = await exportService.countFhirWithheldService(1, { cycleReason: 'consent not granted' });
  assert.equal(refused.find((w) => w.kind === 'CyclePhaseEntry').reason, 'consent not granted');
});
