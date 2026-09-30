import { randomUUID } from 'node:crypto';
import { PG_SYSTEMS, PG_OBSERVATION, pgCoding } from './codeSystems.js';
import {
  NRCES, SECTIONS, SECTION_ORDER, BIOMETRIC_MAP, CALORIES_BURNED, STEPS, HEART_RATE, toQuantity,
} from './codeMaps.js';

// Stage 0 of ABHA-FHIR-INTEGRATION.md (§D.1): turn a range series - the SAME
// object buildRangeSeriesService hands the JSON and CSV exports - into an
// FHIR R4 document Bundle whose Composition is an NRCeS WellnessRecord
// (IG v6.5.0).
//
// Pure on purpose. No Prisma, no network, no clock (generatedAt and ids are
// injected), so:
//   - the "export and screen never disagree" invariant is testable: feed one
//     fixture to seriesToCsv and to this, compare the numbers;
//   - the transport layers that come later (an insurer share, ABDM HIP push)
//     ask this function for a Bundle and never learn how tables are shaped.
// Nothing ABDM-specific is imported here. ABHA identity arrives in Stage 1 as
// one more Patient.identifier, and that is the only change this file expects.
//
// What this file refuses to do, by design, and why:
//   - emit a Condition. HealthCondition is the user's own words, never coded
//     (see schema comment); a coded Condition would read as us diagnosing.
//     The export response reports how many were withheld instead.
//   - emit a predicted cycle phase. Only user_logged rows ever reach here.
//   - emit set-level strength data. The IG has no profile for it; sessions go
//     out as one Observation each with summary components. The JSON export
//     keeps the detail.
//   - claim conformance. That is the HAPI validator's call (§D.1), not ours.

const BUNDLE_PROFILE = `${NRCES}/DocumentBundle`;
const WELLNESS_PROFILE = `${NRCES}/WellnessRecord`;
const PATIENT_PROFILE = `${NRCES}/Patient`;
const OBS_CATEGORY = 'http://terminology.hl7.org/CodeSystem/observation-category';
const V2_0203 = 'http://terminology.hl7.org/CodeSystem/v2-0203';

// Which standard observation-category each section's entries carry. Optional
// in the profiles, but it is what lets a generic FHIR reader file a vitals
// row as vitals without knowing our sections.
const CATEGORY = {
  vitalSigns: ['vital-signs', 'Vital Signs'],
  bodyMeasurement: ['exam', 'Exam'],
  physicalActivity: ['activity', 'Activity'],
  womenHealth: ['exam', 'Exam'],
  lifestyle: ['social-history', 'Social History'],
  otherObservations: ['survey', 'Survey'],
};

const iso = (v) => (v == null ? undefined : v instanceof Date ? v.toISOString() : String(v));

/**
 * @param {object} series  buildRangeSeriesService output (any includes).
 * @param {object} opts
 * @param {number} opts.userId
 * @param {Date|string} opts.generatedAt  injected clock
 * @param {() => string} [opts.newId]     injected id factory (uuid by default)
 * @returns {{ bundle: object, conversionWarnings: object[] }}
 */
export function seriesToWellnessBundle(series, { userId, generatedAt, newId = randomUUID } = {}) {
  if (!Number.isInteger(userId)) throw new Error('seriesToWellnessBundle: integer userId required');
  const stamp = iso(generatedAt);
  if (!stamp) throw new Error('seriesToWellnessBundle: generatedAt required');

  const warnings = [];
  const patientId = newId();
  const deviceId = newId();
  const patientRef = { reference: `urn:uuid:${patientId}` };
  const deviceRef = { reference: `urn:uuid:${deviceId}` };
  const bySection = Object.fromEntries(SECTION_ORDER.map((k) => [k, []]));

  // One Observation builder so every row gets the same subject, provenance
  // tag and profile claim - the places a hand-rolled resource would drift.
  function add(sectionKey, { coding, text, effective, issued, value, components, source, note }) {
    const section = SECTIONS[sectionKey];
    const [catCode, catDisplay] = CATEGORY[sectionKey];
    const obs = {
      resourceType: 'Observation',
      id: newId(),
      meta: {
        profile: [section.profile],
        ...(source ? { tag: [{ system: PG_SYSTEMS.dataSource, code: source, display: source }] } : {}),
      },
      status: 'final',
      category: [{ coding: [{ system: OBS_CATEGORY, code: catCode, display: catDisplay }] }],
      code: { coding, text },
      subject: patientRef,
      // A 'YYYY-MM-DD' string is a valid FHIR dateTime at day precision (a
      // timezone is only required once hours/minutes appear), so the user's
      // own calendar day goes out as-is - no invented midnight, no invented
      // offset. `issued` is the server's instant for when we were told:
      // together they say "for Tuesday, recorded Wednesday 09:12Z", which is
      // the honest shape of a self-reported ledger (§D.6).
      ...(effective?.start ? { effectivePeriod: { start: iso(effective.start), end: iso(effective.end) } } : { effectiveDateTime: effective }),
      ...(issued ? { issued: iso(issued) } : {}),
      performer: [patientRef],
      ...value,
      ...(components?.length ? { component: components } : {}),
      ...(note ? { note: [{ text: note }] } : {}),
    };
    bySection[sectionKey].push(obs);
  }

  const pg = (entry) => pgCoding(PG_SYSTEMS.observation, entry);
  const component = (entry, quantity) => ({ code: { coding: [pg(entry)], text: entry.display }, valueQuantity: quantity });
  const qty = (value, unit) => toQuantity(value, unit, warnings);

  for (const b of series.biometrics || []) {
    const m = BIOMETRIC_MAP[b.metric];
    if (!m) {
      warnings.push({ metric: b.metric, reason: 'no FHIR mapping for this metric; row omitted' });
      continue;
    }
    add(m.section, {
      coding: m.coding,
      text: m.text,
      effective: b.localDate,
      issued: b.recordedAt,
      value: { valueQuantity: qty(b.value, b.unit) },
      source: b.source,
    });
  }

  for (const s of series.sessions || []) {
    // A rest log is the absence of activity, not an activity - putting it in
    // Physical Activity would make "logged a rest day" read as a workout.
    if (s.type === 'rest') continue;
    const components = [];
    if (s.durationMinutes != null) components.push(component(PG_OBSERVATION.durationMinutes, qty(s.durationMinutes, 'minutes')));
    components.push(component(PG_OBSERVATION.completedSets, qty(s.completedSets, 'sets')));
    components.push(component(PG_OBSERVATION.volumeKg, qty(s.volumeKg, 'kg')));
    if (s.rpe != null) components.push(component(PG_OBSERVATION.rpe, qty(s.rpe, 'score')));
    add('physicalActivity', {
      coding: [
        pg(PG_OBSERVATION.workoutSession),
        ...(s.type ? [{ system: PG_SYSTEMS.workoutType, code: s.type, display: s.type }] : []),
      ],
      text: `Workout session${s.type ? ` (${s.type})` : ''}`,
      effective: { start: s.startedAt, end: s.endedAt },
      issued: s.recordedAt,
      value: {},
      components,
      // 'app', not 'manual': some sessions are drafts the server opened from
      // a verified gym check-in. How that check-in was verified lives in
      // booking-service (§C.0) - Stage 0 does not claim it; Stage 2's
      // insurer view will, once attendanceMethod is copied across.
      source: 'app',
    });
  }

  for (const r of series.exerciseRecords || []) {
    const components = [component(PG_OBSERVATION.durationMinutes, qty(Math.round(r.durationSeconds / 60), 'minutes'))];
    if (r.distanceMeters != null) components.push(component(PG_OBSERVATION.distance, qty(r.distanceMeters, 'm')));
    if (r.caloriesBurned != null) components.push({ code: { coding: [CALORIES_BURNED], text: 'Calories burned' }, valueQuantity: qty(r.caloriesBurned, 'kcal') });
    if (r.avgHeartRateBpm != null) components.push(component(PG_OBSERVATION.avgHeartRate, qty(r.avgHeartRateBpm, 'bpm')));
    add('physicalActivity', {
      coding: [pg(PG_OBSERVATION.exerciseRecord), { system: PG_SYSTEMS.exerciseType, code: r.type, display: r.type }],
      text: `Exercise (${r.type})`,
      effective: { start: r.startedAt, end: r.endedAt },
      issued: r.recordedAt,
      value: {},
      components,
      source: r.source,
    });
  }

  for (const a of series.dailyActivity || []) {
    // One Observation per measure per day rather than one with components:
    // steps and calories each have their own value-set concept, and a reader
    // looking for "steps" should find a steps Observation.
    const base = { effective: a.localDate, issued: a.recordedAt, source: a.source };
    if (a.steps != null) add('physicalActivity', { ...base, coding: [STEPS], text: 'Steps', value: { valueQuantity: qty(a.steps, 'steps') } });
    if (a.activeCalories != null) add('physicalActivity', { ...base, coding: [CALORIES_BURNED], text: 'Active calories burned', value: { valueQuantity: qty(a.activeCalories, 'kcal') } });
    if (a.distanceMeters != null) add('physicalActivity', { ...base, coding: [pg(PG_OBSERVATION.dailyDistance)], text: 'Distance', value: { valueQuantity: qty(a.distanceMeters, 'm') } });
    if (a.restingHeartRateBpm != null) {
      add('vitalSigns', {
        ...base,
        coding: [HEART_RATE, pg(PG_OBSERVATION.restingHeartRate)],
        text: 'Resting heart rate',
        value: { valueQuantity: qty(a.restingHeartRateBpm, 'bpm') },
      });
    }
  }

  for (const s of series.scoreSnapshots || []) {
    // The ledger's frozen day. No IG concept exists for it (§C.2): it rides
    // in Other Observations under our own code, with the rules version as
    // `method` so anyone can ask "which rules produced 72?".
    add('otherObservations', {
      coding: [pg(PG_OBSERVATION.adherenceScoreDaily)],
      text: 'Daily plan-adherence score',
      effective: s.localDate,
      issued: s.recordedAt,
      value: {
        valueQuantity: qty(s.close, 'score'),
        method: { text: `rules ${s.rulesVersion}` },
      },
      components: [
        component(PG_OBSERVATION.scoreOpen, qty(s.open, 'score')),
        component(PG_OBSERVATION.scoreHigh, qty(s.high, 'score')),
        component(PG_OBSERVATION.scoreLow, qty(s.low, 'score')),
        { code: { coding: [pg(PG_OBSERVATION.scorePaused)], text: PG_OBSERVATION.scorePaused.display }, valueBoolean: !!s.paused },
      ],
      source: 'derived',
    });
  }

  for (const c of series.planCompletions || []) {
    add('otherObservations', {
      coding: [pg(PG_OBSERVATION.planItemCompleted)],
      text: 'Plan item completed',
      effective: c.localDate,
      // `issued` is when the tick was recorded. A tick made days after the
      // localDate is visible as such - which is the point of a ledger.
      issued: c.recordedAt,
      value: {
        valueCodeableConcept: {
          coding: c.kind ? [{ system: PG_SYSTEMS.planItemKind, code: c.kind, display: c.kind }] : [],
          text: c.kind || 'unknown',
        },
      },
      components: [component(PG_OBSERVATION.points, qty(c.points, 'points'))],
      source: c.how || 'manual',
    });
  }

  for (const d of series.foodDayTotals || []) {
    const note = 'Totals of the foods logged that day. Nutrient values are app estimates, not laboratory measurements.';
    add('lifestyle', {
      coding: [pg(PG_OBSERVATION.dailyEnergyIntake)],
      text: 'Estimated energy intake',
      effective: d.localDate,
      issued: d.recordedAt,
      value: { valueQuantity: qty(d.kcal, 'kcal') },
      components: [component(PG_OBSERVATION.foodEntries, qty(d.entries, 'entries'))],
      source: 'manual',
      note,
    });
    add('lifestyle', {
      coding: [pg(PG_OBSERVATION.dailyProteinIntake)],
      text: 'Estimated protein intake',
      effective: d.localDate,
      issued: d.recordedAt,
      value: { valueQuantity: qty(d.proteinG, 'g') },
      source: 'manual',
      note,
    });
  }

  for (const e of series.cycleLogged || []) {
    add('womenHealth', {
      coding: [pg(PG_OBSERVATION.cyclePhaseLogged)],
      text: 'Cycle phase (logged)',
      effective: e.endDate ? { start: e.startDate, end: e.endDate } : e.startDate,
      issued: e.recordedAt,
      value: { valueCodeableConcept: { coding: [{ system: PG_SYSTEMS.cyclePhase, code: e.phase, display: e.phase }], text: e.phase } },
      source: 'user_logged',
    });
  }

  const sections = [];
  const observations = [];
  for (const key of SECTION_ORDER) {
    const rows = bySection[key];
    if (!rows.length) continue;
    observations.push(...rows);
    sections.push({
      title: SECTIONS[key].title,
      entry: rows.map((o) => ({ reference: `urn:uuid:${o.id}` })),
    });
  }
  if (!sections.length) {
    // The profile needs at least one section and FHIR's cmp-1 needs a section
    // to have text, entries or sub-sections. An empty range is a real answer,
    // so say it rather than fail.
    sections.push({
      title: SECTIONS.otherObservations.title,
      text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">No records in this range.</div>' },
      emptyReason: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/list-empty-reason', code: 'nilknown', display: 'Nil Known' }] },
    });
  }

  const compositionId = newId();
  const composition = {
    resourceType: 'Composition',
    id: compositionId,
    meta: { profile: [WELLNESS_PROFILE] },
    status: 'final',
    type: { text: 'Wellness Record' },
    subject: patientRef,
    date: stamp,
    // Self-reported data, assembled by our app: the person is an author, the
    // app is the other. No Practitioner - nobody clinical signed this.
    author: [patientRef, deviceRef],
    title: 'Wellness Record',
    section: sections,
  };

  const patient = {
    resourceType: 'Patient',
    id: patientId,
    meta: { profile: [PATIENT_PROFILE] },
    // Our internal id only. health-service holds no name or date of birth
    // (age lives in HealthGoal, name in auth-service); the NRCeS Patient
    // profile requires an identifier, not a name. Stage 1 adds the ABHA
    // address as a second identifier (type code ABHA) when the user links one.
    identifier: [{
      type: { coding: [{ system: V2_0203, code: 'MR', display: 'Medical record number' }] },
      system: PG_SYSTEMS.userId,
      value: String(userId),
    }],
  };

  const device = {
    resourceType: 'Device',
    id: deviceId,
    deviceName: [{ name: 'Phool Gobhi', type: 'user-friendly-name' }],
  };

  const entry = (resource) => ({ fullUrl: `urn:uuid:${resource.id}`, resource });
  const bundle = {
    resourceType: 'Bundle',
    id: newId(),
    meta: { versionId: '1', lastUpdated: stamp, profile: [BUNDLE_PROFILE] },
    identifier: { system: PG_SYSTEMS.bundleId, value: compositionId },
    type: 'document',
    timestamp: stamp,
    entry: [entry(composition), entry(patient), entry(device), ...observations.map(entry)],
  };
  return { bundle, conversionWarnings: warnings };
}

// Every slice buildRangeSeriesService can add, minus the one that needs its own
// opt-in. The controller passes this, plus 'cycleLogged' only when asked.
export const FHIR_DEFAULT_INCLUDES = Object.freeze([
  'provenance', 'exerciseRecords', 'dailyActivity', 'planCompletions', 'scoreSnapshots', 'foodDayTotals',
]);
