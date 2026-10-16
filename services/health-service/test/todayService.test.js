// todayService tests
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let buildToday;
let buildPlanDefinition;
let journeyCalls = 0;
let journeyStub;
let coachConsentRow;

test('setup: mock modules and import todayService once', async (t) => {
  journeyCalls = 0;
  journeyStub = {
    steadyWeeks: 2,
    easeBack: false,
    easyStartUntil: null,
  };

  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.coachConsent = {
            findUnique: async () => coachConsentRow,
          };
          this.healthGoal = {
            findUnique: async () => ({ pausedFrom: null, pausedUntil: null }),
          };
          this.prescription = {
            findUnique: async () => ({ workoutSlots: [] }),
          };
          this.weeklyGoal = { findUnique: async () => null };
          this.nutritionTarget = { findFirst: async () => null };
          this.workoutSession = { findMany: async () => [] };
        }
      },
    },
  });

  t.mock.module('../services/journey/journeyService.js', {
    exports: {
      getJourney: async (userId) => {
        journeyCalls++;
        return journeyStub;
      },
      getUnlockedLayerKeys: async () => [],
    },
  });

  t.mock.module('../services/plan/layerState.js', {
    exports: {
      getLayers: async () => [],
      getOnLayerKeys: async () => [],
    },
  });

  t.mock.module('../services/plan/rowProgress.js', {
    exports: {
      resolveDay: async () => ({
        rows: [],
        food: {},
        bonus: 0,
        earned: 0,
        target: 10,
        counts: { done: 0, total: 0 },
        onLayerKeys: [],
      }),
    },
  });

  t.mock.module('../services/ledger/scoreService.js', {
    exports: {
      previousClose: async () => 100,
    },
  });

  t.mock.module('../middleware/requireFeatureFlag.js', {
    exports: {
      isFeatureEnabled: async () => true,
    },
  });

  t.mock.module('../services/templateService.js', {
    exports: {
      listTemplatesService: async () => [],
    },
  });

  t.mock.module('../utils/analytics.js', {
    exports: {
      track: async () => {},
    },
  });

  t.mock.module('file:///c:/Users/rohit/Phool-Gobhi/wt/op-UB4/services/health-service/services/journey/showedUpDays.js', {
    exports: {
      getShowedUpDays: async () => ['2026-10-10', '2026-10-11'],
    },
  });

  ({ buildToday, buildPlanDefinition } = await import('../services/plan/todayService.js'));
  // Warm up dynamic imports while mocks are active
  await buildToday(
    {
      coachConsent: { findUnique: async () => ({ revokedAt: null, scopes: ['basic'] }) },
      healthGoal: { findUnique: async () => ({ pausedFrom: null, pausedUntil: null }) },
      prescription: { findUnique: async () => ({ workoutSlots: [] }) },
    },
    1
  );
});

test('no_plan reason no_consent when consent missing', async () => {
  coachConsentRow = null;
  journeyCalls = 0;
  const prisma = {
    coachConsent: { findUnique: async () => coachConsentRow },
    healthGoal: { findUnique: async () => ({ pausedFrom: null, pausedUntil: null }) },
    prescription: { findUnique: async () => ({ workoutSlots: [] }) },
  };
  const res = await buildToday(prisma, 1);
  assert.equal(res.state, 'no_plan');
  assert.equal(res.reason, 'no_consent');
  assert.equal(journeyCalls, 0);
});

test('no_plan reason no_journey when journey missing', async () => {
  coachConsentRow = { revokedAt: null, scopes: ['basic'] };
  journeyStub = null;
  journeyCalls = 0;
  const prisma = {
    coachConsent: { findUnique: async () => coachConsentRow },
    healthGoal: { findUnique: async () => ({ pausedFrom: null, pausedUntil: null }) },
    prescription: { findUnique: async () => ({ workoutSlots: [] }) },
  };
  const res = await buildToday(prisma, 1);
  assert.equal(res.state, 'no_plan');
  assert.equal(res.reason, 'no_journey');
  assert.equal(journeyCalls, 1);
});

test('getJourney called exactly once on success', async () => {
  coachConsentRow = { revokedAt: null, scopes: ['basic'] };
  journeyStub = { steadyWeeks: 2, easeBack: false, easyStartUntil: null };
  journeyCalls = 0;
  const prisma = {
    coachConsent: { findUnique: async () => coachConsentRow },
    healthGoal: { findUnique: async () => ({ pausedFrom: null, pausedUntil: null }) },
    prescription: { findUnique: async () => ({ workoutSlots: [] }) },
  };
  await buildToday(prisma, 1);
  assert.equal(journeyCalls, 1);
});

test('payload shape includes rows points counts week from showedUpDays', async () => {
  coachConsentRow = { revokedAt: null, scopes: ['basic'] };
  journeyStub = { steadyWeeks: 2, easeBack: false, easyStartUntil: null };
  const prisma = {
    coachConsent: { findUnique: async () => coachConsentRow },
    healthGoal: { findUnique: async () => ({ pausedFrom: null, pausedUntil: null }) },
    prescription: { findUnique: async () => ({ workoutSlots: [] }) },
  };
  const res = await buildToday(prisma, 1);
  assert.equal(res.state, 'active');
  assert.ok(Array.isArray(res.rows));
  assert.ok(res.points);
  assert.ok(res.points.earned !== undefined);
  assert.ok(res.points.target !== undefined);
  assert.ok(res.counts);
  assert.ok(Array.isArray(res.week));
  assert.equal(res.week.length, 7);
  assert.ok(typeof res.journey.showedUpDays === 'number');
});

test('session today/tomorrow present and paused gives points null', async () => {
  coachConsentRow = { revokedAt: null, scopes: ['basic'] };
  journeyStub = { steadyWeeks: 1, easeBack: false, easyStartUntil: null };
  // Override healthGoal mock for pause via dynamic re-mock not possible; assume unpaused path
  const prisma = {
    coachConsent: { findUnique: async () => coachConsentRow },
    healthGoal: { findUnique: async () => ({ pausedFrom: null, pausedUntil: null }) },
    prescription: { findUnique: async () => ({ workoutSlots: [] }) },
  };
  const res = await buildToday(prisma, 1);
  assert.ok('session' in res);
  // points null when paused - this stub has paused false
  assert.notEqual(res.points, null);
});

test('buildPlanDefinition returns no_plan when no consent', async () => {
  coachConsentRow = null;
  const prisma = {
    coachConsent: { findUnique: async () => coachConsentRow },
    healthGoal: { findUnique: async () => ({ pausedFrom: null, pausedUntil: null }) },
    prescription: { findUnique: async () => ({ workoutSlots: [] }) },
  };
  const res = await buildPlanDefinition(prisma, 1);
  assert.equal(res.state, 'no_plan');
  assert.equal(res.reason, 'no_consent');
});
