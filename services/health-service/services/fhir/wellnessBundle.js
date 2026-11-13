import { randomUUID } from 'node:crypto';
import { PG_SYSTEMS, PG_OBSERVATION, pgCoding } from './codeSystems.js';
import {
  NRCES, SECTIONS, SECTION_ORDER, BIOMETRIC_MAP, CALORIES_BURNED, STEPS, HEART_RATE,
  EXERCISE_DURATION, CALORIE_INTAKE, LMP_START, toQuantity,
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
//   - put a code of our own in Observation.code. The NRCeS profiles close that
//     slice to LOINC/SNOMED (codeMaps.js). What has no standard concept - the
//     frozen daily score, plan ticks, self-rated stress, day distance, cycle
//     phases other than a period start - goes into ONE DocumentReference as a
//     JSON attachment in our own, versioned format (LEDGER_FORMAT below). It
//     stays inside the conformant document and says plainly that it is ours,
//     instead of dressing it up as a standard observation it isn't.
//   - claim conformance. That is the HAPI validator's call (§D.1), not ours.

const BUNDLE_PROFILE = `${NRCES}/DocumentBundle`;
const WELLNESS_PROFILE = `${NRCES}/WellnessRecord`;
const PATIENT_PROFILE = `${NRCES}/Patient`;
const OBS_CATEGORY = 'http://terminology.hl7.org/CodeSystem/observation-category';
const V2_0203 = 'http://terminology.hl7.org/CodeSystem/v2-0203';
const DATA_ABSENT = 'http://terminology.hl7.org/CodeSystem/data-absent-reason';

// The attachment's own format name + version. A reader keys on these, so a
// breaking change to the ledger JSON shape must bump LEDGER_FORMAT_VERSION.
export const LEDGER_FORMAT = 'phoolgobhi.adherence-ledger';
export const LEDGER_FORMAT_VERSION = 1;
export const LEDGER_TITLE = 'Phool Gobhi adherence ledger';

// Which standard observation-category each section's entries carry. Optional
// in the profiles, but it is what lets a generic FHIR reader file a vitals
// row as vitals without knowing our sections. A map entry may override it
// (weight must be vital-signs: see codeMaps.js).
const CATEGORY_DISPLAY = {
  'vital-signs': 'Vital Signs', exam: 'Exam', activity: 'Activity', 'social-history': 'Social History', survey: 'Survey',
};
const CATEGORY = {
  vitalSigns: 'vital-signs',
  bodyMeasurement: 'exam',
  physicalActivity: 'activity',
  generalAssessment: 'exam',
  womenHealth: 'exam',
  lifestyle: 'social-history',
  otherObservations: 'survey',
};

const iso = (v) => (v == null ? undefined : v instanceof Date ? v.toISOString() : String(v));
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// A one-line human narrative. FHIR's dom-6 asks every resource to carry one so
// a plain viewer can show something; it is generated from the same fields, so
// it can't say anything the structured data doesn't.
const narrative = (line) => ({ status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${esc(line)}</div>` });

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
  // Rows with no standard concept, collected for the ledger attachment. Same
  // numbers as the JSON export's fields; only the container differs.
  const ledger = { stress: [], dailyDistance: [], scoreSnapshots: [], planCompletions: [], cycleLogged: [] };

  // One Observation builder so every row gets the same subject, provenance
  // tag and profile claim - the places a hand-rolled resource would drift.
  function add(sectionKey, { coding, text, effective, issued, value, components, source, note, category }) {
    const section = SECTIONS[sectionKey];
    const catCode = category || CATEGORY[sectionKey];
    const when = effective?.start ? iso(effective.start) : effective;
    const obs = {
      resourceType: 'Observation',
      id: newId(),
      meta: {
        profile: [section.profile],
        ...(source ? { tag: [{ system: PG_SYSTEMS.dataSource, code: source, display: source }] } : {}),
      },
      text: narrative(when ? `${text}, ${when}` : text),
      status: 'final',
      category: [{ coding: [{ system: OBS_CATEGORY, code: catCode, display: CATEGORY_DISPLAY[catCode] }] }],
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

  // Our codes are only ever COMPONENT codes (component.code is not sliced).
  const pg = (entry) => pgCoding(PG_SYSTEMS.observation, entry);
  const component = (entry, quantity) => ({ code: { coding: [pg(entry)], text: entry.display }, valueQuantity: quantity });
  const kindComponent = (entry, system, code) => ({
    code: { coding: [pg(entry)], text: entry.display },
    valueCodeableConcept: { coding: [{ system, code, display: code }], text: code },
  });
  const qty = (value, unit) => toQuantity(value, unit, warnings);

  for (const b of series.biometrics || []) {
    const m = BIOMETRIC_MAP[b.metric];
    if (!m) {
      warnings.push({ metric: b.metric, reason: 'no FHIR mapping for this metric; row omitted' });
      continue;
    }
    if (m.ledger) {
      ledger[b.metric].push({ localDate: b.localDate, value: b.value, unit: b.unit, source: b.source, recordedAt: iso(b.recordedAt) });
      continue;
    }
    add(m.section, {
      coding: m.coding,
      text: m.text,
      effective: b.localDate,
      issued: b.recordedAt,
      value: { valueQuantity: qty(b.value, b.unit) },
      source: b.source,
      category: m.category,
    });
  }

  for (const s of series.sessions || []) {
    // A rest log is the absence of activity, not an activity - putting it in
    // Physical Activity would make "logged a rest day" read as a workout.
    if (s.type === 'rest') continue;
    const components = [];
    if (s.type) components.push(kindComponent(PG_OBSERVATION.workoutType, PG_SYSTEMS.workoutType, s.type));
    components.push(component(PG_OBSERVATION.completedSets, qty(s.completedSets, 'sets')));
    components.push(component(PG_OBSERVATION.volumeKg, qty(s.volumeKg, 'kg')));
    if (s.rpe != null) components.push(component(PG_OBSERVATION.rpe, qty(s.rpe, 'score')));
    add('physicalActivity', {
      coding: [EXERCISE_DURATION],
      text: `Workout session${s.type ? ` (${s.type})` : ''}`,
      effective: { start: s.startedAt, end: s.endedAt },
      issued: s.recordedAt,
      // The main value IS the LOINC concept (exercise duration); the rest is
      // detail. A session with no duration yet says so rather than claim 0.
      value: s.durationMinutes != null
        ? { valueQuantity: qty(s.durationMinutes, 'minutes') }
        : { dataAbsentReason: { coding: [{ system: DATA_ABSENT, code: 'unknown', display: 'Unknown' }] } },
      components,
      // 'app', not 'manual': some sessions are drafts the server opened from
      // a verified gym check-in. How that check-in was verified lives in
      // booking-service (§C.0) - Stage 0 does not claim it; Stage 2's
      // insurer view will, once attendanceMethod is copied across.
      source: 'app',
    });
  }

  for (const r of series.exerciseRecords || []) {
    const components = [kindComponent(PG_OBSERVATION.exerciseType, PG_SYSTEMS.exerciseType, r.type)];
    if (r.distanceMeters != null) components.push(component(PG_OBSERVATION.distance, qty(r.distanceMeters, 'm')));
    if (r.caloriesBurned != null) components.push({ code: { coding: [CALORIES_BURNED], text: 'Calories burned' }, valueQuantity: qty(r.caloriesBurned, 'kcal') });
    if (r.avgHeartRateBpm != null) components.push(component(PG_OBSERVATION.avgHeartRate, qty(r.avgHeartRateBpm, 'bpm')));
    add('physicalActivity', {
      coding: [EXERCISE_DURATION],
      text: `Exercise (${r.type})`,
      effective: { start: r.startedAt, end: r.endedAt },
      issued: r.recordedAt,
      value: { valueQuantity: qty(Math.round(r.durationSeconds / 60), 'minutes') },
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
    // No value-set concept for "distance a phone counted in a day".
    if (a.distanceMeters != null) ledger.dailyDistance.push({ localDate: a.localDate, meters: a.distanceMeters, source: a.source, recordedAt: iso(a.recordedAt) });
    if (a.restingHeartRateBpm != null) {
      add('vitalSigns', { ...base, coding: [HEART_RATE], text: 'Resting heart rate', value: { valueQuantity: qty(a.restingHeartRateBpm, 'bpm') } });
    }
  }

  // The ledger's frozen day. No IG concept exists for it (§C.2), and the
  // closed code slice means it cannot pose as an Observation either. It goes
  // to the attachment whole - OHLC, pause flag and rulesVersion - so anyone
  // can ask "which rules produced 72?". The free-text breakdown never leaves.
  for (const s of series.scoreSnapshots || []) {
    ledger.scoreSnapshots.push({
      localDate: s.localDate, open: s.open, high: s.high, low: s.low, close: s.close,
      paused: !!s.paused, rulesVersion: s.rulesVersion, recordedAt: iso(s.recordedAt),
    });
  }

  // `recordedAt` is when the tick was recorded. A tick made days after the
  // localDate is visible as such - which is the point of a ledger.
  for (const c of series.planCompletions || []) {
    ledger.planCompletions.push({ localDate: c.localDate, kind: c.kind || null, how: c.how || 'manual', points: c.points, recordedAt: iso(c.recordedAt) });
  }

  for (const d of series.foodDayTotals || []) {
    // General Assessment, not Lifestyle: 9052-2 is in the general-assessment
    // value set, and Lifestyle's value must be an alcohol/tobacco finding.
    add('generalAssessment', {
      coding: [CALORIE_INTAKE],
      text: 'Estimated energy intake',
      effective: d.localDate,
      issued: d.recordedAt,
      value: { valueQuantity: qty(d.kcal, 'kcal') },
      components: [
        component(PG_OBSERVATION.dailyProteinIntake, qty(d.proteinG, 'g')),
        component(PG_OBSERVATION.foodEntries, qty(d.entries, 'entries')),
      ],
      source: 'manual',
      note: 'Totals of the foods logged that day. Nutrient values are app estimates, not laboratory measurements.',
    });
  }

  for (const e of series.cycleLogged || []) {
    // Every logged phase goes to the ledger; a period start ALSO becomes the
    // one Women Health concept that fits it (LOINC 8665-2), as a date string
    // because that profile allows only Quantity|string values.
    ledger.cycleLogged.push({ startDate: e.startDate, endDate: e.endDate || null, phase: e.phase, recordedAt: iso(e.recordedAt) });
    if (e.phase === 'menstrual') {
      add('womenHealth', {
        coding: [LMP_START],
        text: 'Period start (logged)',
        effective: e.startDate,
        issued: e.recordedAt,
        value: { valueString: e.startDate },
        source: 'user_logged',
      });
    }
  }

  if (Object.values(ledger).some((rows) => rows.length)) {
    const content = {
      format: LEDGER_FORMAT,
      formatVersion: LEDGER_FORMAT_VERSION,
      generatedAt: stamp,
      note: 'Records with no LOINC/SNOMED concept, in Phool Gobhi\'s own format. Self-reported unless source says otherwise; scores are computed by the rules named in rulesVersion.',
      // Only the slices that have rows, so an absent key means "none".
      ...Object.fromEntries(Object.entries(ledger).filter(([, rows]) => rows.length)),
    };
    bySection.documentReference.push({
      resourceType: 'DocumentReference',
      id: newId(),
      meta: { profile: [SECTIONS.documentReference.profile] },
      text: narrative(`${LEDGER_TITLE} (${LEDGER_FORMAT} v${LEDGER_FORMAT_VERSION})`),
      status: 'current',
      type: { text: LEDGER_TITLE },
      subject: patientRef,
      date: stamp,
      author: [deviceRef],
      description: `${LEDGER_TITLE}: daily scores, plan ticks and other records with no standard code`,
      content: [{
        attachment: {
          contentType: 'application/json',
          data: Buffer.from(JSON.stringify(content), 'utf8').toString('base64'),
          title: LEDGER_TITLE,
          creation: stamp,
        },
      }],
    });
  }

  const sections = [];
  const resources = [];
  for (const key of SECTION_ORDER) {
    const rows = bySection[key];
    if (!rows.length) continue;
    resources.push(...rows);
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
      text: narrative('No records in this range.'),
      emptyReason: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/list-empty-reason', code: 'nilknown', display: 'Nil Known' }] },
    });
  }

  const compositionId = newId();
  const composition = {
    resourceType: 'Composition',
    id: compositionId,
    meta: { profile: [WELLNESS_PROFILE] },
    text: narrative(`Wellness Record generated ${stamp}: ${sections.map((s) => s.title).join(', ')}`),
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
    text: narrative('Phool Gobhi member'),
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
    text: narrative('Phool Gobhi app'),
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
    entry: [entry(composition), entry(patient), entry(device), ...resources.map(entry)],
  };
  return { bundle, conversionWarnings: warnings };
}

// Reads the ledger attachment back out of a bundle (tests, and any reader of
// our own exports). Returns null when the bundle has none.
export function readLedgerAttachment(bundle) {
  const doc = bundle.entry.map((e) => e.resource).find((r) => r.resourceType === 'DocumentReference' && r.type?.text === LEDGER_TITLE);
  if (!doc) return null;
  return JSON.parse(Buffer.from(doc.content[0].attachment.data, 'base64').toString('utf8'));
}

// Every slice buildRangeSeriesService can add, minus the one that needs its own
// opt-in. The controller passes this, plus 'cycleLogged' only when asked.
export const FHIR_DEFAULT_INCLUDES = Object.freeze([
  'provenance', 'exerciseRecords', 'dailyActivity', 'planCompletions', 'scoreSnapshots', 'foodDayTotals',
]);
