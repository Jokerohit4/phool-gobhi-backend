// Cycle tracking. Run with:
//   node --experimental-test-module-mocks --test
//
// This feature reverses a recorded architectural decision (FR-27, 2026-09-08,
// which kept zero cycle columns server-side). The tests that matter most are
// therefore the ones covering the containments that make the reversal
// reversible: consent gating, and the rule that cycle data reaches training
// only through ProgrammingMode.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let healthConsent = null;
let cycleProfile = null;
let personalisation = null;
let phases = [];
let dayLogs = [];
let nextDayLogId = 1;
let nextPhaseId = 1;

let svc;

function resetFakes() {
  healthConsent = { userId: 1, revokedAt: null, scopes: ['logs'] };
  cycleProfile = null;
  personalisation = null;
  phases = [];
  dayLogs = [];
  nextDayLogId = 1;
  nextPhaseId = 1;
}

// Dates are compared against "now" inside the service, so window/expiry tests
// anchor themselves to the real clock rather than a fixed age that rots.
function daysFromToday(offsetDays) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addDays(iso, days) {
  return new Date(new Date(iso + 'T00:00:00Z').getTime() + days * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
}

test('setup: stub Prisma, import once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.healthConsent = {
            findUnique: async () => healthConsent,
            update: async ({ data }) => {
              healthConsent = { ...healthConsent, ...data };
              return healthConsent;
            },
          };
          this.cycleTrackingProfile = {
            findUnique: async () => cycleProfile,
            upsert: async ({ update, create }) => {
              cycleProfile = cycleProfile ? { ...cycleProfile, ...update } : { ...create };
              return cycleProfile;
            },
            update: async ({ data }) => {
              cycleProfile = { ...cycleProfile, ...data };
              return cycleProfile;
            },
            updateMany: async ({ data }) => {
              if (cycleProfile) cycleProfile = { ...cycleProfile, ...data };
              return { count: cycleProfile ? 1 : 0 };
            },
            deleteMany: async () => {
              cycleProfile = null;
              return { count: 1 };
            },
          };
          this.cyclePhaseEntry = {
            create: async ({ data }) => {
              const row = { id: nextPhaseId++, ...data };
              phases.push(row);
              return row;
            },
            findFirst: async ({ where } = {}) =>
              [...phases]
                .filter((e) =>
                  (where?.id == null || e.id === where.id) &&
                  (where?.userId == null || (e.userId ?? 1) === where.userId) &&
                  (!where?.phase || e.phase === where.phase) &&
                  (!where?.source || e.source === where.source))
                .sort((a, b) => b.startDate - a.startDate)[0] ?? null,
            update: async ({ where, data }) => {
              const i = phases.findIndex((e) => e.id === where.id);
              phases[i] = { ...phases[i], ...data };
              return phases[i];
            },
            delete: async ({ where }) => {
              phases = phases.filter((e) => e.id !== where.id);
              return { id: where.id };
            },
            findMany: async () => phases,
            count: async ({ where } = {}) => phases.filter(
              (e) => (!where?.phase || e.phase === where.phase) && (!where?.source || e.source === where.source)
            ).length,
            deleteMany: async () => {
              phases = [];
              return { count: 1 };
            },
          };
          this.cycleDayLog = {
            findFirst: async ({ where }) =>
              dayLogs.find((d) => d.userId === where.userId && +d.date === +where.date) ?? null,
            findMany: async ({ where }) =>
              dayLogs
                .filter((d) => d.userId === where.userId)
                .filter((d) => !where.date?.gte || d.date >= where.date.gte)
                .filter((d) => !where.date?.lte || d.date <= where.date.lte)
                .sort((a, b) => b.date - a.date),
            create: async ({ data }) => {
              const row = { id: nextDayLogId++, ...data };
              dayLogs.push(row);
              return row;
            },
            update: async ({ where, data }) => {
              const i = dayLogs.findIndex((d) => d.id === where.id);
              dayLogs[i] = { ...dayLogs[i], ...data };
              return dayLogs[i];
            },
            delete: async ({ where }) => {
              dayLogs = dayLogs.filter((d) => d.id !== where.id);
              return { id: where.id };
            },
            deleteMany: async ({ where }) => {
              const before = dayLogs.length;
              dayLogs = dayLogs.filter(
                (d) => !(d.userId === where.userId && (!where.date || +d.date === +where.date))
              );
              return { count: before - dayLogs.length };
            },
          };
          this.personalisationProfile = {
            findUnique: async () => personalisation,
            upsert: async ({ update, create }) => {
              personalisation = personalisation ? { ...personalisation, ...update } : { ...create };
              return personalisation;
            },
            updateMany: async ({ where, data }) => {
              const hit = personalisation
                && (where.programmingMode == null || personalisation.programmingMode === where.programmingMode);
              if (hit) personalisation = { ...personalisation, ...data };
              return { count: hit ? 1 : 0 };
            },
          };
          // Both forms Prisma has: a list of operations, or a callback handed a
          // transaction client (here, the same fakes).
          this.$transaction = async (ops) =>
            typeof ops === 'function' ? ops(this) : Promise.all(ops);
        }
      },
      Prisma: {},
    },
  });
  svc = await import('../services/cycleTrackingService.js');
});

test('consent requires health consent first, and says so', async () => {
  resetFakes();
  healthConsent = null;
  await assert.rejects(
    () => svc.grantCycleConsentService(1),
    (err) => {
      assert.equal(err.code, 'HEALTH_CONSENT_REQUIRED');
      return true;
    }
  );
});

test('granting adds a scope rather than a second consent record', async () => {
  // One withdrawal, not two the user has to find separately: revoking health
  // consent must take this with it.
  resetFakes();
  await svc.grantCycleConsentService(1, { privacyVersion: 'v1' });
  assert.ok(healthConsent.scopes.includes('cycle_tracking'));
  assert.ok(healthConsent.scopes.includes('logs'), 'existing scopes preserved');
  assert.ok(cycleProfile.consentAt);
});

test('revoking health consent entirely revokes cycle tracking too', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  healthConsent.revokedAt = new Date();
  assert.equal(await svc.hasCycleConsentService(1), false);
});

test('revoking cycle consent does NOT delete the data', async () => {
  // Switching a feature off and destroying months of records are different
  // intentions. Conflating them would delete data the user only meant to stop
  // adding to.
  resetFakes();
  await svc.grantCycleConsentService(1);
  await svc.logPhaseService(1, { startDate: '2026-09-01', phase: 'menstrual' });

  await svc.revokeCycleConsentService(1);

  assert.equal(await svc.hasCycleConsentService(1), false);
  assert.equal(phases.length, 1, 'history survives an opt-out');
});

test('deleting is explicit and removes everything', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await svc.logPhaseService(1, { startDate: '2026-09-01', phase: 'menstrual' });

  await svc.deleteAllCycleDataService(1);

  assert.equal(phases.length, 0);
  assert.equal(cycleProfile, null);
});

test('implausible cycle lengths are rejected as typos', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await assert.rejects(() => svc.updateProfileService(1, { averageCycleLengthDays: 3 }));
  await assert.rejects(() => svc.updateProfileService(1, { averageCycleLengthDays: 400 }));
  await assert.rejects(() => svc.updateProfileService(1, { averagePeriodLengthDays: 40 }));
});

test('a logged period updates the last-period date', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await svc.logPhaseService(1, { startDate: '2026-09-10', phase: 'menstrual' });
  assert.equal(
    cycleProfile.lastPeriodStartDate.toISOString().slice(0, 10),
    '2026-09-10'
  );
});

test('a logged phase is always user_logged, never predicted', async () => {
  // A prediction must never be shown back as something she reported.
  resetFakes();
  await svc.grantCycleConsentService(1);
  const entry = await svc.logPhaseService(1, { startDate: '2026-09-10', phase: 'luteal' });
  assert.equal(entry.source, 'user_logged');
});

test('cycle data reaches training ONLY through ProgrammingMode', async () => {
  // The containment that makes this whole feature reversible: switch the flag
  // off and the training engine keeps reading the same enum it always did.
  resetFakes();
  await svc.grantCycleConsentService(1);

  // A period starting today: the window is open, so the auto-apply happens.
  const entry = await svc.logPhaseService(1, { startDate: daysFromToday(0), phase: 'menstrual' });
  assert.equal(personalisation.programmingMode, 'low_impact_recovery');

  // Once the window has closed it must expire back to neutral — and never
  // have become female_default at any point. (Correcting the start date to
  // three weeks ago is how the window closes here; logging an older period no
  // longer moves the last-period date backwards.)
  await svc.updatePhaseService(1, entry.id, { startDate: daysFromToday(-20) });
  assert.equal(personalisation.programmingMode, 'neutral');
  assert.notEqual(personalisation.programmingMode, 'female_default');
});

test('without consent nothing touches the programming mode', async () => {
  resetFakes();
  personalisation = { userId: 1, programmingMode: 'neutral' };
  const result = await svc.syncProgrammingModeService(1);
  assert.equal(result, null);
  assert.equal(personalisation.programmingMode, 'neutral');
});

test('a user-chosen low-impact mode is never downgraded by cycle data', async () => {
  // Someone who set low-impact after an injury must not be quietly moved off
  // it because their cycle phase advanced. Cycle data may raise caution; it
  // must not remove it — and (female-user audit P1) must not expire her choice
  // when the recovery window passes either.
  resetFakes();
  await svc.grantCycleConsentService(1);
  personalisation = { userId: 1, programmingMode: 'low_impact_recovery', injuryZones: ['knee'] };

  await svc.logPhaseService(1, { startDate: daysFromToday(0), phase: 'menstrual' });

  assert.equal(personalisation.programmingMode, 'low_impact_recovery');
});

test('female_default is user-only: cycle data never writes or moves it', async () => {
  // The "lower-body emphasis" mode is an explicit choice the user makes in
  // Training preferences. Cycle data must neither switch it on silently nor
  // override it while a period is running.
  resetFakes();
  await svc.grantCycleConsentService(1);
  personalisation = { userId: 1, programmingMode: 'female_default', injuryZones: [] };

  await svc.logPhaseService(1, { startDate: daysFromToday(0), phase: 'menstrual' });

  assert.equal(personalisation.programmingMode, 'female_default');
  assert.equal(cycleProfile.managesProgrammingMode, undefined, 'a user choice is never claimed');
});

test('the cycle profile exposes phase, recovery window, suggestion and prediction', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);

  const before = await svc.getProfileService(1);
  assert.equal(before.currentPhase, null);
  assert.equal(before.recoveryModeActiveUntil, null);
  assert.equal(before.suggestedProgrammingMode, 'neutral');
  assert.equal(before.prediction, null, 'fewer than two logged periods is not a prediction');

  await svc.updateProfileService(1, { averageCycleLengthDays: 28, averagePeriodLengthDays: 5 });
  await svc.logPhaseService(1, { startDate: daysFromToday(-28), phase: 'menstrual' });
  await svc.logPhaseService(1, { startDate: daysFromToday(0), phase: 'menstrual' });

  const now = await svc.getProfileService(1);
  assert.equal(now.currentPhase, 'menstrual');
  assert.equal(now.recoveryModeActiveUntil, addDays(daysFromToday(0), 4), '5-day window, inclusive');
  assert.equal(now.suggestedProgrammingMode, 'low_impact_recovery');
  assert.deepEqual(now.prediction, {
    nextPeriodStart: addDays(daysFromToday(0), 28),
    isEstimate: true,
  });
});

test('a single logged period is never echoed back as a prediction', async () => {
  // One period plus an average length: the model must not present the only
  // date she ever logged as a forecast. Two confirmed periods are the floor.
  resetFakes();
  await svc.grantCycleConsentService(1);
  await svc.updateProfileService(1, { averageCycleLengthDays: 28 });
  await svc.logPhaseService(1, { startDate: daysFromToday(-28), phase: 'menstrual' });

  const profile = await svc.getProfileService(1);
  assert.equal(profile.prediction, null);
});

test('closing a period sets its end and leaves its start alone', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  const entry = await svc.logPhaseService(1, { startDate: daysFromToday(-3), phase: 'menstrual' });

  const closed = await svc.updatePhaseService(1, entry.id, { endDate: daysFromToday(0) });
  assert.equal(closed.endDate.toISOString().slice(0, 10), daysFromToday(0));
  assert.equal(closed.startDate.toISOString().slice(0, 10), daysFromToday(-3));
});

test('an end before the start is refused, and null re-opens a period', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  const entry = await svc.logPhaseService(1, {
    startDate: daysFromToday(-3), endDate: daysFromToday(-1), phase: 'menstrual',
  });

  await assert.rejects(
    () => svc.updatePhaseService(1, entry.id, { endDate: daysFromToday(-5) }),
    (err) => err.status === 400
  );
  const reopened = await svc.updatePhaseService(1, entry.id, { endDate: null });
  assert.equal(reopened.endDate, null);
});

test('editing or deleting an entry that is not yours is a 404', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  phases.push({
    id: 99, userId: 2, startDate: new Date(daysFromToday(-3)), endDate: null,
    phase: 'menstrual', source: 'user_logged',
  });

  await assert.rejects(() => svc.updatePhaseService(1, 99, { endDate: daysFromToday(0) }), (e) => e.status === 404);
  await assert.rejects(() => svc.deletePhaseService(1, 99), (e) => e.status === 404);
  assert.equal(phases.length, 1, 'the other account entry survives');
});

test('deleting the latest period moves the last-period date back, deleting the only one clears it', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  const older = await svc.logPhaseService(1, { startDate: daysFromToday(-30), phase: 'menstrual' });
  const newer = await svc.logPhaseService(1, { startDate: daysFromToday(-2), phase: 'menstrual' });
  assert.equal(cycleProfile.lastPeriodStartDate.toISOString().slice(0, 10), daysFromToday(-2));

  await svc.deletePhaseService(1, newer.id);
  assert.equal(cycleProfile.lastPeriodStartDate.toISOString().slice(0, 10), daysFromToday(-30));

  await svc.deletePhaseService(1, older.id);
  assert.equal(cycleProfile.lastPeriodStartDate, null);
});

test('logging a backdated period does not drag the last-period date backwards', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await svc.logPhaseService(1, { startDate: daysFromToday(-2), phase: 'menstrual' });
  await svc.logPhaseService(1, { startDate: daysFromToday(-60), phase: 'menstrual' });
  assert.equal(cycleProfile.lastPeriodStartDate.toISOString().slice(0, 10), daysFromToday(-2));
});

test('with no typed cycle length, two logged periods are enough: it is learned from the gap', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await svc.logPhaseService(1, { startDate: daysFromToday(-60), phase: 'menstrual' });
  await svc.logPhaseService(1, { startDate: daysFromToday(-32), phase: 'menstrual' });
  await svc.logPhaseService(1, { startDate: daysFromToday(-2), phase: 'menstrual' });

  const profile = await svc.getProfileService(1);
  assert.equal(profile.averageCycleLengthDays, null, 'the typed setting is untouched');
  // gaps are 28 and 30 -> mean 29
  assert.equal(profile.prediction.nextPeriodStart, addDays(daysFromToday(-2), 29));
});

test('a typed cycle length wins over the learned one', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await svc.updateProfileService(1, { averageCycleLengthDays: 35 });
  await svc.logPhaseService(1, { startDate: daysFromToday(-30), phase: 'menstrual' });
  await svc.logPhaseService(1, { startDate: daysFromToday(0), phase: 'menstrual' });

  const profile = await svc.getProfileService(1);
  assert.equal(profile.prediction.nextPeriodStart, addDays(daysFromToday(0), 35));
});

test('an implausible gap (a missed log) gives no prediction rather than a wild one', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await svc.logPhaseService(1, { startDate: daysFromToday(-200), phase: 'menstrual' });
  await svc.logPhaseService(1, { startDate: daysFromToday(0), phase: 'menstrual' });

  assert.equal((await svc.getProfileService(1)).prediction, null);
});

test('deleting all cycle data also removes the per-day symptom log', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await svc.upsertDayLogService(1, daysFromToday(-1), { flow: 'light', symptoms: ['cramps'] });
  assert.equal(dayLogs.length, 1);

  await svc.deleteAllCycleDataService(1);

  assert.equal(dayLogs.length, 0);
});

test('a day log stores flow and symptoms and reads back newest first', async () => {
  resetFakes();
  const d1 = daysFromToday(-2);
  const d2 = daysFromToday(-1);
  await svc.upsertDayLogService(1, d1, { flow: 'heavy', symptoms: ['cramps', 'fatigue'] });
  await svc.upsertDayLogService(1, d2, { flow: 'light' });

  const list = await svc.listDayLogsService(1);
  assert.deepEqual(list.map((r) => r.date), [d2, d1]);
  assert.deepEqual(list[1], { date: d1, flow: 'heavy', symptoms: ['cramps', 'fatigue'] });
});

test('updating one field of a day leaves the others alone', async () => {
  resetFakes();
  const d = daysFromToday(-1);
  await svc.upsertDayLogService(1, d, { flow: 'medium', symptoms: ['bloating'] });
  const out = await svc.upsertDayLogService(1, d, { symptoms: ['bloating', 'fatigue'] });
  assert.deepEqual(out, { date: d, flow: 'medium', symptoms: ['bloating', 'fatigue'] });
  assert.equal(dayLogs.length, 1, 'same day is one row, not two');
});

test('clearing everything on a day removes the row instead of keeping an empty one', async () => {
  resetFakes();
  const d = daysFromToday(-1);
  await svc.upsertDayLogService(1, d, { flow: 'light', symptoms: ['acne'] });
  await svc.upsertDayLogService(1, d, { flow: null, symptoms: [] });
  assert.equal(dayLogs.length, 0);
});

test('only the fixed vocabularies are accepted - no free text can be stored', async () => {
  resetFakes();
  const d = daysFromToday(-1);
  for (const bad of [
    { flow: 'torrential' },
    { mood: 'happy' },
    { symptoms: ['a free text diagnosis'] },
    { symptoms: 'cramps' },
  ]) {
    await assert.rejects(() => svc.upsertDayLogService(1, d, bad), (err) => err.status === 400);
  }
  assert.equal(dayLogs.length, 0);
});

test('a malformed or future day is refused', async () => {
  resetFakes();
  await assert.rejects(() => svc.upsertDayLogService(1, 'yesterday', { flow: 'light' }), (e) => e.status === 400);
  await assert.rejects(() => svc.upsertDayLogService(1, '2026-02-30', { flow: 'light' }), (e) => e.status === 400);
  await assert.rejects(
    () => svc.upsertDayLogService(1, daysFromToday(3), { flow: 'light' }),
    (e) => e.status === 400
  );
});

test("one person's day log is never read or removed through another's id", async () => {
  resetFakes();
  const d = daysFromToday(-1);
  await svc.upsertDayLogService(1, d, { flow: 'light' });

  assert.deepEqual(await svc.listDayLogsService(2), []);
  await svc.deleteDayLogService(2, d);
  assert.equal(dayLogs.length, 1, "user 2's delete must not touch user 1's row");

  await svc.deleteDayLogService(1, d);
  assert.equal(dayLogs.length, 0);
});

// --- Recovery mode is released with the data that justified it --------------

test('delete-all mid-period hands back the mode the feature set', async () => {
  // The profile is the only record that cycle sync owns the mode. Deleting it
  // alone would leave her on low_impact_recovery with nothing able to clear it.
  resetFakes();
  await svc.grantCycleConsentService(1);
  await svc.logPhaseService(1, { startDate: daysFromToday(0), phase: 'menstrual' });
  assert.equal(personalisation.programmingMode, 'low_impact_recovery');
  assert.equal(cycleProfile.managesProgrammingMode, true);

  await svc.deleteAllCycleDataService(1);

  assert.equal(cycleProfile, null);
  assert.equal(personalisation.programmingMode, 'neutral');
});

test('delete-all leaves a mode the user chose alone', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  personalisation = { userId: 1, programmingMode: 'low_impact_recovery', injuryZones: ['knee'] };
  await svc.logPhaseService(1, { startDate: daysFromToday(0), phase: 'menstrual' });

  await svc.deleteAllCycleDataService(1);

  assert.equal(personalisation.programmingMode, 'low_impact_recovery', 'her injury setting stays');
});

test('delete-all never touches female_default', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  personalisation = { userId: 1, programmingMode: 'female_default', injuryZones: [] };
  await svc.logPhaseService(1, { startDate: daysFromToday(0), phase: 'menstrual' });

  await svc.deleteAllCycleDataService(1);

  assert.equal(personalisation.programmingMode, 'female_default');
});

test('delete-all with no profile and no personalisation is fine', async () => {
  resetFakes();
  await assert.doesNotReject(() => svc.deleteAllCycleDataService(1));
});

test('revoking consent mid-period releases the mode now, not at the window end', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await svc.logPhaseService(1, { startDate: daysFromToday(0), phase: 'menstrual' });
  assert.equal(personalisation.programmingMode, 'low_impact_recovery');

  await svc.revokeCycleConsentService(1);

  assert.equal(personalisation.programmingMode, 'neutral');
  assert.equal(cycleProfile.managesProgrammingMode, false, 'nothing is owned any more');
  assert.equal(phases.length, 1, 'the data is still not deleted by revoking');
});

test('revoking consent leaves a user-chosen mode alone', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  personalisation = { userId: 1, programmingMode: 'low_impact_recovery', injuryZones: ['knee'] };
  await svc.logPhaseService(1, { startDate: daysFromToday(0), phase: 'menstrual' });

  await svc.revokeCycleConsentService(1);

  assert.equal(personalisation.programmingMode, 'low_impact_recovery');
});

test('granting again mid-period re-applies the mode', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await svc.logPhaseService(1, { startDate: daysFromToday(0), phase: 'menstrual' });
  await svc.revokeCycleConsentService(1);

  await svc.grantCycleConsentService(1);
  await svc.getProfileService(1);

  assert.equal(personalisation.programmingMode, 'low_impact_recovery');
  assert.equal(cycleProfile.managesProgrammingMode, true);
});

// --- Period entries are validated on the way in ------------------------------

const rejects400 = (fn, status = 400) => assert.rejects(fn, (e) => e.status === status);

test('logging a period refuses bad dates instead of a 500', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await rejects400(() => svc.logPhaseService(1, { startDate: 'not-a-date', phase: 'menstrual' }));
  await rejects400(() => svc.logPhaseService(1, { startDate: '2026-02-31', phase: 'menstrual' }));
  await rejects400(() => svc.logPhaseService(1, { startDate: 12345, phase: 'menstrual' }));
  await rejects400(() => svc.logPhaseService(1, {
    startDate: daysFromToday(-3), endDate: 'nope', phase: 'menstrual',
  }));
  assert.equal(phases.length, 0);
});

test('logging a period refuses an end before the start', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await rejects400(() => svc.logPhaseService(1, {
    startDate: daysFromToday(-2), endDate: daysFromToday(-5), phase: 'menstrual',
  }));
  assert.equal(phases.length, 0);
});

test('logging a period refuses a start in the future', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await rejects400(() => svc.logPhaseService(1, { startDate: daysFromToday(3), phase: 'menstrual' }));
  assert.equal(phases.length, 0);
});

test('a period longer than the ceiling is refused, and exactly the ceiling is fine', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await rejects400(() => svc.logPhaseService(1, {
    startDate: daysFromToday(-30), endDate: daysFromToday(-10), phase: 'menstrual',
  }));
  await assert.doesNotReject(() => svc.logPhaseService(1, {
    startDate: daysFromToday(-30), endDate: daysFromToday(-17), phase: 'menstrual',
  }));
});

test('overlapping and duplicate periods are refused with 409', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await svc.logPhaseService(1, {
    startDate: daysFromToday(-10), endDate: daysFromToday(-6), phase: 'menstrual',
  });

  // Same start, a start inside it, and a range that swallows it.
  await rejects400(() => svc.logPhaseService(1, { startDate: daysFromToday(-10), phase: 'menstrual' }), 409);
  await rejects400(() => svc.logPhaseService(1, { startDate: daysFromToday(-8), phase: 'menstrual' }), 409);
  await rejects400(() => svc.logPhaseService(1, {
    startDate: daysFromToday(-12), endDate: daysFromToday(-4), phase: 'menstrual',
  }), 409);
  // Touching on a shared day counts as overlap; the day after does not.
  await rejects400(() => svc.logPhaseService(1, {
    startDate: daysFromToday(-6), endDate: daysFromToday(-4), phase: 'menstrual',
  }), 409);
  await assert.doesNotReject(() => svc.logPhaseService(1, {
    startDate: daysFromToday(-5), endDate: daysFromToday(-3), phase: 'menstrual',
  }));
  assert.equal(phases.length, 2);
});

test('an open period does not block the next one, but closing it over the next is refused', async () => {
  // Forgetting to end a period must not lock her out of logging the next.
  resetFakes();
  await svc.grantCycleConsentService(1);
  const first = await svc.logPhaseService(1, { startDate: daysFromToday(-20), phase: 'menstrual' });
  await svc.logPhaseService(1, { startDate: daysFromToday(-12), phase: 'menstrual' });

  await rejects400(() => svc.updatePhaseService(1, first.id, { endDate: daysFromToday(-12) }), 409);
  await assert.doesNotReject(() => svc.updatePhaseService(1, first.id, { endDate: daysFromToday(-16) }));
});

test('other phases are not subject to the period span and overlap rules', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await svc.logPhaseService(1, {
    startDate: daysFromToday(-30), endDate: daysFromToday(-20), phase: 'luteal',
  });
  await assert.doesNotReject(() => svc.logPhaseService(1, {
    startDate: daysFromToday(-28), endDate: daysFromToday(-18), phase: 'luteal',
  }));
});

test('editing a period is held to the same rules', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await svc.logPhaseService(1, {
    startDate: daysFromToday(-14), endDate: daysFromToday(-10), phase: 'menstrual',
  });
  const b = await svc.logPhaseService(1, {
    startDate: daysFromToday(-6), endDate: daysFromToday(-2), phase: 'menstrual',
  });

  await rejects400(() => svc.updatePhaseService(1, b.id, { startDate: 'garbage' }));
  await rejects400(() => svc.updatePhaseService(1, b.id, { startDate: daysFromToday(2) }));
  await rejects400(() => svc.updatePhaseService(1, b.id, { startDate: daysFromToday(-11) }), 409);
  await rejects400(() => svc.updatePhaseService(1, b.id, { endDate: daysFromToday(-30) }));
  // Its own old range is not a clash with itself.
  await assert.doesNotReject(() => svc.updatePhaseService(1, b.id, { endDate: daysFromToday(-3) }));
});

test('an entry saved before the checks existed can still have an unrelated edit', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  phases.push({
    id: 50, userId: 1, startDate: new Date(daysFromToday(-60)), endDate: new Date(daysFromToday(-30)),
    phase: 'menstrual', source: 'user_logged',
  });
  // Nothing that affects the span changes, so nothing is re-validated.
  await assert.doesNotReject(() => svc.updatePhaseService(1, 50, {}));
});

test('lastPeriodStartDate through the profile call is validated too', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await rejects400(() => svc.updateProfileService(1, { lastPeriodStartDate: 'soon' }));
  await rejects400(() => svc.updateProfileService(1, { lastPeriodStartDate: daysFromToday(5) }));

  const ok = await svc.updateProfileService(1, { lastPeriodStartDate: daysFromToday(-9) });
  assert.equal(ok.lastPeriodStartDate, daysFromToday(-9));
  const cleared = await svc.updateProfileService(1, { lastPeriodStartDate: null });
  assert.equal(cleared.lastPeriodStartDate, null);
});

test('each refusal carries a code the app can turn into its own wording', async () => {
  resetFakes();
  await svc.grantCycleConsentService(1);
  await svc.logPhaseService(1, {
    startDate: daysFromToday(-10), endDate: daysFromToday(-6), phase: 'menstrual',
  });
  const code = async (fn) => fn().then(() => null, (e) => e.code);

  assert.equal(await code(() => svc.logPhaseService(1, { startDate: daysFromToday(-8), phase: 'menstrual' })), 'PERIOD_OVERLAP');
  assert.equal(await code(() => svc.logPhaseService(1, {
    startDate: daysFromToday(-60), endDate: daysFromToday(-40), phase: 'menstrual',
  })), 'PERIOD_TOO_LONG');
  assert.equal(await code(() => svc.logPhaseService(1, {
    startDate: daysFromToday(-30), endDate: daysFromToday(-33), phase: 'menstrual',
  })), 'PERIOD_END_BEFORE_START');
  assert.equal(await code(() => svc.logPhaseService(1, { startDate: daysFromToday(4), phase: 'menstrual' })), 'DATE_IN_FUTURE');
});
