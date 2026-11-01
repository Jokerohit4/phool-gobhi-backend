// Workout photo + full-data capture: finish durations / body-weight snapshot,
// per-set restSeconds / completedAt, and the photo upload with its one-time
// server-rolled 1-5 coin reward.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let sessions = [];
let sets = [];
let biometricRows = [];
let creditCalls = [];
let savedPhotos = [];
let deletedPhotos = [];

let svc;

test('setup', async (t) => {
  t.mock.module('../services/routineJourneyService.js', { exports: { recordRoutineWorkout: async () => null } });
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.workoutSession = {
            findUnique: async ({ where }) => {
              const s = sessions.find((x) => x.id === where.id);
              return s ? { exercises: [], ...s } : null;
            },
            update: async ({ where, data }) => {
              const s = sessions.find((x) => x.id === where.id);
              Object.assign(s, data);
              return { exercises: [], ...s };
            },
          };
          this.workoutSet = {
            findUnique: async ({ where }) => {
              const s = sets.find((x) => x.id === where.id);
              return s ? { ...s, sessionExercise: { sessionId: s.sessionId } } : null;
            },
            update: async ({ where, data }) => {
              const s = sets.find((x) => x.id === where.id);
              Object.assign(s, data);
              return s;
            },
          };
          this.biometricEntry = {
            groupBy: async () => {
              const metrics = [...new Set(biometricRows.map((r) => r.metric))];
              return metrics.map((metric) => ({
                metric,
                _max: { localDate: biometricRows.filter((r) => r.metric === metric).map((r) => r.localDate).sort().pop() },
              }));
            },
            findMany: async () => biometricRows,
          };
        }
      },
      Prisma: {},
    },
  });
  t.mock.module(new URL('../utils/notifyChallengeService.js', import.meta.url).href, {
    exports: {
      notifyWorkoutFinished: async () => ({ verified: false, credited: false }),
    },
  });
  t.mock.module(new URL('../utils/notifyWorkoutPhoto.js', import.meta.url).href, {
    exports: {
      creditWorkoutPhotoCoins: async (args) => {
        creditCalls.push(args);
        return globalThis.__creditOk !== false;
      },
    },
  });
  t.mock.module(new URL('../services/ledger/foodPhotoStorage.js', import.meta.url).href, {
    exports: {
      saveWorkoutPhoto: async ({ userId }) => {
        const p = `food/${userId}/workout/${savedPhotos.length}.jpg`;
        savedPhotos.push(p);
        return p;
      },
      signedPhotoUrl: async (p) => `https://signed.example/${p}`,
      deletePhotos: async (paths) => { deletedPhotos.push(...paths); return { deleted: paths.length, failed: [] }; },
    },
  });
  svc = await import('../services/workoutSessionService.js');
});

function reset() {
  sessions = [];
  sets = [];
  biometricRows = [];
  creditCalls = [];
  savedPhotos = [];
  deletedPhotos = [];
  globalThis.__creditOk = true;
}
const seed = (over = {}) => {
  const s = { id: sessions.length + 1, userId: 1, startedAt: new Date(), endedAt: null, localDate: '2026-11-01', coinsAwarded: false, photoStoragePath: null, photoRewardCoins: null, ...over };
  sessions.push(s);
  return s;
};
const photo = { buffer: Buffer.from('x'), mimeType: 'image/jpeg' };

test('finish stores activeSeconds, pausedSeconds and the latest weight as bodyWeightKg', async () => {
  reset();
  biometricRows = [
    { metric: 'weight', value: 71.4, localDate: '2026-10-30', createdAt: new Date() },
    { metric: 'sleep', value: 7, localDate: '2026-10-31', createdAt: new Date() },
  ];
  const s = seed();
  const out = await svc.finishSessionService(s.id, 1, { activeSeconds: 1800, pausedSeconds: 120 });
  assert.equal(out.activeSeconds, 1800);
  assert.equal(out.pausedSeconds, 120);
  assert.equal(out.bodyWeightKg, 71.4);
  assert.equal(out.photoUrl, null);
  assert.equal('photoStoragePath' in out, false);
});

test('finish ignores invalid durations and leaves bodyWeightKg null with no weight', async () => {
  reset();
  const s = seed();
  const out = await svc.finishSessionService(s.id, 1, { activeSeconds: -5, pausedSeconds: 999999 });
  assert.equal(out.activeSeconds, undefined);
  assert.equal(out.pausedSeconds, undefined);
  assert.equal(out.bodyWeightKg, null);
  assert.ok(out.endedAt);
});

test('sanitizeSeconds bounds', () => {
  assert.equal(svc.sanitizeSeconds(0), 0);
  assert.equal(svc.sanitizeSeconds(86400), 86400);
  assert.equal(svc.sanitizeSeconds(86401), undefined);
  assert.equal(svc.sanitizeSeconds(1.5), undefined);
  assert.equal(svc.sanitizeSeconds('abc'), undefined);
  assert.equal(svc.sanitizeSeconds(null), undefined);
});

test('updateSet: restSeconds + completed sets completedAt; unchecking clears it', async () => {
  reset();
  const s = seed();
  sets.push({ id: 10, sessionId: s.id, completed: false, completedAt: null, restSeconds: null });
  const done = await svc.updateSetService(s.id, 10, 1, { completed: true, restSeconds: 90 });
  assert.equal(done.restSeconds, 90);
  assert.ok(done.completedAt instanceof Date);
  const undone = await svc.updateSetService(s.id, 10, 1, { completed: false });
  assert.equal(undone.completedAt, null);
  assert.equal(undone.restSeconds, 90, 'restSeconds untouched when omitted');
});

test('updateSet: invalid restSeconds ignored; restSeconds-only works', async () => {
  reset();
  const s = seed();
  sets.push({ id: 11, sessionId: s.id, completed: true, completedAt: new Date(0), restSeconds: null });
  const bad = await svc.updateSetService(s.id, 11, 1, { completed: true, restSeconds: -1 });
  assert.equal(bad.restSeconds, null);
  assert.equal(bad.completedAt.getTime(), 0, 'already-completed set keeps its original completedAt');
  const ok = await svc.updateSetService(s.id, 11, 1, { restSeconds: 45 });
  assert.equal(ok.restSeconds, 45);
});

test('photo upload: unfinished session -> 409 SESSION_NOT_FINISHED, nothing stored or paid', async () => {
  reset();
  const s = seed();
  await assert.rejects(svc.uploadSessionPhotoService(s.id, 1, photo), (e) => e.status === 409 && e.code === 'SESSION_NOT_FINISHED');
  assert.equal(savedPhotos.length, 0);
  assert.equal(creditCalls.length, 0);
});

test('photo upload: non-owner gets 404', async () => {
  reset();
  const s = seed({ endedAt: new Date() });
  await assert.rejects(svc.uploadSessionPhotoService(s.id, 2, photo), (e) => e.status === 404);
  assert.equal(savedPhotos.length, 0);
});

test('photo upload: pays the rolled coins once, keyed on the session; second upload does not pay', async () => {
  reset();
  const s = seed({ endedAt: new Date() });
  const first = await svc.uploadSessionPhotoService(s.id, 1, photo, { rng: () => 4 });
  assert.deepEqual(first.reward, { coins: 4, credited: true });
  assert.equal(first.data.photoRewardCoins, 4);
  assert.match(first.data.photoUrl, /^https:\/\/signed\.example\//);
  assert.ok(sessions[0].photoUploadedAt);
  assert.equal(creditCalls.length, 1);
  assert.deepEqual(creditCalls[0], { userId: 1, sessionId: s.id, amount: 4 });

  let rolled = false;
  const second = await svc.uploadSessionPhotoService(s.id, 1, photo, { rng: () => { rolled = true; return 5; } });
  assert.deepEqual(second.reward, { coins: 4, credited: false });
  assert.equal(rolled, false, 'must not roll again');
  assert.equal(creditCalls.length, 1, 'must not pay again');
  assert.equal(deletedPhotos.length, 1, 'replaced photo object is reclaimed');
});

test('photo upload: failed credit keeps the photo, persists no reward, retry can pay', async () => {
  reset();
  const s = seed({ endedAt: new Date() });
  globalThis.__creditOk = false;
  const first = await svc.uploadSessionPhotoService(s.id, 1, photo, { rng: () => 3 });
  assert.deepEqual(first.reward, { coins: 0, credited: false });
  assert.equal(sessions[0].photoRewardCoins, null);
  assert.ok(sessions[0].photoStoragePath);
  globalThis.__creditOk = true;
  const retry = await svc.uploadSessionPhotoService(s.id, 1, photo, { rng: () => 2 });
  assert.deepEqual(retry.reward, { coins: 2, credited: true });
});

test('photo reward roll (default CSPRNG) always lands in 1..5 and hits every value', async () => {
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    reset();
    const s = seed({ endedAt: new Date() });
    const { reward } = await svc.uploadSessionPhotoService(s.id, 1, photo);
    assert.ok(Number.isInteger(reward.coins) && reward.coins >= 1 && reward.coins <= 5);
    seen.add(reward.coins);
  }
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4, 5]);
});
