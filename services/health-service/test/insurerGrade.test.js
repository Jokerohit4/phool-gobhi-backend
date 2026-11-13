// ig-v1, the insurer-grade summary. What these pin, in order of how bad it
// would be to lose them:
//   - device-synced data cannot move a single number (Apple 5.1.3 / Health
//     Connect policy),
//   - every visit is bucketed by how it was proven, and only scans count as
//     verified - a manual override or a legacy/unknown row never does,
//   - the preview and the would-be-signed payload are one deterministic object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInsurerGrade, canonicalize, validateRange, IG_RULES_VERSION } from '../services/share/insurerGrade.js';
import { buildInsurerGradeService } from '../services/share/insurerGradeService.js';

const NOW = new Date('2026-10-01T06:00:00.000Z'); // 11:30 IST, 1 Oct
const RANGE = { from: '2026-09-28', to: '2026-10-04' }; // Mon..Sun

// IST 10:00 on a given day, as a UTC instant.
const at = (d) => new Date(`${d}T10:00:00+05:30`);

const SESSIONS = [
  { bookingId: 1, localDate: '2026-09-28', attendedAt: at('2026-09-28'), attendanceMethod: 'qr_scan' },
  { bookingId: 2, localDate: '2026-09-29', attendedAt: at('2026-09-29'), attendanceMethod: 'qr_geofence_self' },
  { bookingId: 3, localDate: '2026-09-30', attendedAt: at('2026-09-30'), attendanceMethod: 'manual_verify' },
  { bookingId: 4, localDate: '2026-09-30', attendedAt: at('2026-09-30'), attendanceMethod: 'manual_override' },
  { bookingId: 5, localDate: '2026-10-01', attendedAt: null, attendanceMethod: null }, // legacy / client-attached
  { bookingId: null, localDate: '2026-10-01', attendedAt: null, attendanceMethod: null }, // not visit-shaped
];

function base(extra = {}) {
  return computeInsurerGrade({ ...RANGE, sessions: SESSIONS, weeklyGoal: { sessionsPerWeek: 3 }, now: NOW, ...extra });
}

test('rulesVersion is stamped and the period is explicit', () => {
  const out = base();
  assert.equal(out.rulesVersion, IG_RULES_VERSION);
  assert.deepEqual(out.period, { from: '2026-09-28', to: '2026-10-04', days: 7, timeZone: 'Asia/Kolkata' });
});

test('visits are bucketed by evidence; only QR and geofence count as verified', () => {
  const { gymVisits } = base();
  assert.equal(gymVisits.total, 5, 'a session without a bookingId is not a gym visit');
  assert.equal(gymVisits.verified, 2);
  assert.deepEqual(gymVisits.byEvidence, {
    verified_qr: 1, verified_geofence: 1, partner_manual: 1, manual_override: 1, unknown_provenance: 1,
  });
});

test('an unrecognised attendance method is unknown provenance, never verified', () => {
  const out = computeInsurerGrade({
    ...RANGE, now: NOW,
    sessions: [{ bookingId: 9, attendedAt: at('2026-09-28'), attendanceMethod: 'trust_me' }],
  });
  assert.equal(out.gymVisits.verified, 0);
  assert.equal(out.gymVisits.byEvidence.unknown_provenance, 1);
});

test('a week is met on verified evidence only; the looser reading is reported beside it, labelled', () => {
  const [week] = base().weeks;
  assert.equal(week.weekStart, '2026-09-28');
  assert.equal(week.verifiedVisits, 2);
  assert.equal(week.metOnVerified, false, 'goal 3, only 2 scanned visits');
  assert.equal(week.metIncludingSelfReported, true, '2 verified + 1 partner-manual reaches 3');
});

test('device data cannot move the score - not even when handed straight to the function', () => {
  const clean = base();
  const polluted = base({
    exerciseRecords: [
      { source: 'healthkit', startedAt: at('2026-09-29'), endedAt: at('2026-09-29'), createdAt: at('2026-09-29') },
      { source: 'health_connect', startedAt: at('2026-09-30'), endedAt: at('2026-09-30'), createdAt: at('2026-09-30') },
    ],
    // Inputs the function does not take at all must be ignored, not merged.
    dailyActivity: [{ localDate: '2026-09-29', steps: 20000, activeKcal: 900 }],
    nutritionTarget: { calories: 2000 },
    activityIsMeasured: true,
  });
  assert.deepEqual(polluted, clean);
});

test('manual and in-app GPS activities are counted as self_reported', () => {
  const out = base({
    exerciseRecords: [
      { source: 'manual', startedAt: at('2026-09-29'), endedAt: at('2026-09-29'), createdAt: at('2026-09-29') },
      { source: 'gps_tracker', startedAt: at('2026-09-30'), endedAt: at('2026-09-30'), createdAt: at('2026-09-30') },
    ],
  });
  assert.equal(out.selfReported.activities, 2);
  assert.equal(out.selfReported.evidence, 'self_reported');
});

test('nutrition and doctor plan items are excluded; workout/habit/rest ticks count', () => {
  const planItems = [
    { id: 1, kind: 'workout', schedule: 'daily', active: true },
    { id: 2, kind: 'nutrition', schedule: 'daily', active: true },
    { id: 3, kind: 'doctor_medication', schedule: 'daily', active: true },
    { id: 4, kind: 'habit', schedule: 'daily', active: true },
  ];
  const completions = [
    { planItemId: 1, localDate: '2026-09-28', createdAt: at('2026-09-28') },
    { planItemId: 2, localDate: '2026-09-28', createdAt: at('2026-09-28') },
    { planItemId: 3, localDate: '2026-09-28', createdAt: at('2026-09-28') },
    { planItemId: 4, localDate: '2026-09-29', createdAt: at('2026-09-29') },
  ];
  const out = base({ planItems, completions });
  assert.deepEqual(out.selfReported.planTicks, { workout: 1, habit: 1, rest: 0 });
  // Two allowed daily items x 4 days up to and including today (28 Sep..1 Oct).
  assert.equal(out.selfReported.plannedPlanTicks, 8);
});

test('paused days are not counted as planned, and are reported', () => {
  const planItems = [{ id: 1, kind: 'workout', schedule: 'daily', active: true }];
  const out = base({ planItems, pause: { pausedFrom: '2026-09-29', pausedUntil: '2026-09-30' } });
  assert.equal(out.pausedDays.count, 2);
  assert.equal(out.selfReported.plannedPlanTicks, 2, '4 days up to today minus 2 paused');
});

test('a tick entered days after the day it claims is reported as a late entry', () => {
  const planItems = [{ id: 1, kind: 'habit', schedule: 'daily', active: true }];
  const completions = [
    { planItemId: 1, localDate: '2026-09-28', createdAt: at('2026-09-28') },          // same day
    { planItemId: 1, localDate: '2026-09-29', createdAt: new Date('2026-10-01T06:30:00+05:30') }, // backfilled
  ];
  const { lateEntries } = base({ planItems, completions });
  assert.equal(lateEntries.entries, 2);
  assert.equal(lateEntries.late, 1);
  assert.equal(lateEntries.maxLagHours, 30.5);
});

test('every excluded category is listed with a reason', () => {
  const cats = base().excluded.map((e) => e.category);
  for (const c of ['device_health_data', 'nutrition', 'biometrics', 'medical', 'cycle', 'ledger_score']) {
    assert.ok(cats.includes(c), `missing exclusion: ${c}`);
  }
});

test('range validation: malformed, inverted and over-long ranges are 400s', () => {
  assert.throws(() => validateRange({ from: 'x', to: '2026-10-01' }), (e) => e.status === 400);
  assert.throws(() => validateRange({ from: '2026-10-02', to: '2026-10-01' }), (e) => e.code === 'INVALID_RANGE');
  assert.throws(() => validateRange({ from: '2025-01-01', to: '2026-10-01' }), (e) => e.code === 'RANGE_TOO_LONG');
});

test('canonicalize is deterministic regardless of key order', () => {
  assert.equal(canonicalize({ b: 1, a: { d: [2, 1], c: null } }), canonicalize({ a: { c: null, d: [2, 1] }, b: 1 }));
});

test('same inputs -> same payload hash, so preview and signed payload are provably the same', async () => {
  const prisma = {
    workoutSession: { findMany: async () => SESSIONS },
    exerciseRecord: { findMany: async () => [] },
    weeklyGoal: { findUnique: async () => ({ sessionsPerWeek: 3 }) },
  };
  const a = await buildInsurerGradeService(prisma, { userId: 1, ...RANGE, now: NOW, ledgerAllowed: false });
  const b = await buildInsurerGradeService(prisma, { userId: 1, ...RANGE, now: new Date(NOW.getTime() + 60000), ledgerAllowed: false });
  assert.equal(a.canonicalSha256, b.canonicalSha256, 'generatedAt must not be inside the hashed payload');
  assert.ok(a.payload.excluded.some((e) => e.category === 'plan_ticks'), 'ledger off is stated, not shown as zeros');
});

test('the service never asks the DB for device-synced records', async () => {
  let recordWhere;
  const prisma = {
    workoutSession: { findMany: async () => [] },
    exerciseRecord: { findMany: async ({ where }) => ((recordWhere = where), []) },
    weeklyGoal: { findUnique: async () => null },
  };
  await buildInsurerGradeService(prisma, { userId: 1, ...RANGE, now: NOW, ledgerAllowed: false });
  assert.deepEqual(recordWhere.source, { in: ['manual', 'gps_tracker'] });
});
