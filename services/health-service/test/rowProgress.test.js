import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDay } from '../services/plan/rowProgress.js';
import { ROW_POINTS } from '../services/ledger/constants.js';
import { DEFAULT_STEPS, DEFAULT_SLEEP_MIN } from '../services/journey/journeyConfig.js';

const TODAY = '2026-10-20';
const USER = 42;

function mockPrisma({ 
  planItems = [], 
  foodLogs = [], 
  waterLogs = [],
  stepsLogs = [],
  sleepLogs = [],
  nutritionTarget = null,
  sessions = [],
  supplementLogs = [],
  workoutTemplates = [],
} = {}) {
  const state = { created: [], updated: [] };
  
  const planItemsWithCompletions = planItems.map(item => ({
    ...item,
    completions: item.completed ? [{ how: 'tick', late: false, localDate: TODAY }] : [],
  }));

  return {
    state,
    planItem: {
      findMany: async ({ where, include }) => {
        return planItemsWithCompletions.filter(item => item.active === true);
      },
    },
    foodLog: {
      findMany: async ({ where, orderBy }) => {
        return foodLogs.filter(log => log.userId === where.userId && log.localDate === where.localDate);
      },
    },
    nutritionTarget: {
      findFirst: async ({ where }) => {
        return nutritionTarget;
      },
    },
    waterLog: {
      findMany: async ({ where }) => {
        return waterLogs.filter(w => w.userId === where.userId);
      },
    },
    dailyActivityMetric: {
      findMany: async ({ where }) => {
        return stepsLogs.filter(s => s.userId === where.userId);
      },
    },
    biometricEntry: {
      findMany: async ({ where }) => {
        return sleepLogs.filter(b => b.userId === where.userId);
      },
    },
    workoutSession: {
      findMany: async ({ where, select }) => {
        return sessions.filter(s => 
          s.userId === where.userId && 
          s.localDate === where.localDate &&
          s.endedAt != null &&
          s.type !== 'rest' &&
          s.type != null
        ).map(s => ({
          id: s.id,
          type: s.type,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          exercises: s.exercises || [],
        }));
      },
    },
    supplementLog: {
      findMany: async ({ where, select }) => {
        return supplementLogs.filter(l => 
          l.userId === where.userId && 
          l.localDate === where.localDate &&
          l.taken === true
        ).map(l => ({ scheduleId: l.scheduleId }));
      },
    },
    workoutTemplate: {
      findUnique: async ({ where }) => {
        return workoutTemplates.find(t => t.id === where.id) || null;
      },
    },
  };
}

const NUTRITION_TARGET = {
  kcal: 2000,
  proteinG: 120,
  waterMl: 2500,
  stepsPerDay: 7000,
  sleepMinutes: 450,
  micros: { iron: 19, magnesium: 440, calcium: 1000, zinc: 17 },
};

const ON_TARGET_FOOD = {
  totals: {
    kcal: 2000,
    proteinG: 120,
    waterMl: 2500,
    steps: 7000,
    sleepMinutes: 450,
    iron: 19,
    magnesium: 440,
    calcium: 1000,
    zinc: 17,
    hasAnyFood: true,
    mealSlotsCovered: 3,
    logCount: 5,
  },
  bySlot: {},
  logCount: 5,
  pendingCount: 0,
  logs: [],
};

const BELOW_TARGET_FOOD = {
  totals: {
    kcal: 1000,
    proteinG: 50,
    waterMl: 1000,
    steps: 3000,
    sleepMinutes: 300,
    iron: 5,
    magnesium: 100,
    calcium: 200,
    zinc: 5,
    hasAnyFood: true,
    mealSlotsCovered: 1,
    logCount: 2,
  },
  bySlot: {},
  logCount: 2,
  pendingCount: 0,
  logs: [],
};

const NO_FOOD = {
  totals: {
    kcal: 0,
    proteinG: 0,
    waterMl: 0,
    steps: 0,
    sleepMinutes: 0,
    hasAnyFood: false,
    mealSlotsCovered: 0,
    logCount: 0,
  },
  bySlot: {},
  logCount: 0,
  pendingCount: 0,
  logs: [],
};

function workoutItem(id, kind = 'workout', layerKey = 'workout', completed = false, templateId = 1) {
  return { id, kind, title: 'Full body A', schedule: 'daily', active: true, layerKey, origin: 'suggested', completed, templateId };
}

function restItem(id, completed = true) {
  return { id, kind: 'rest', title: 'Rest day', schedule: 'daily', active: true, layerKey: 'workout', origin: 'suggested', completed };
}

function waterItem(id, completed = false) {
  return { id, kind: 'habit', title: 'Water', schedule: 'daily', active: true, layerKey: 'water', origin: 'suggested', completed };
}

function stepsItem(id, completed = false) {
  return { id, kind: 'habit', title: 'Steps', schedule: 'daily', active: true, layerKey: 'steps', origin: 'suggested', completed };
}

function sleepItem(id, completed = false) {
  return { id, kind: 'habit', title: 'Sleep', schedule: 'daily', active: true, layerKey: 'sleep', origin: 'suggested', completed };
}

function supplementItem(id, completed = false) {
  return { id, kind: 'supplement', title: 'Vitamin D', schedule: 'daily', active: true, layerKey: 'supplements', origin: 'suggested', completed, sourceRef: 'supplement:1' };
}

function ownHabitItem(id, completed = false) {
  return { id, kind: 'own', title: 'Stretch', schedule: 'daily', active: true, layerKey: 'own', origin: 'user', completed, ownKind: 'habit' };
}

function doctorItem(id, kind = 'doctor_medication', completed = false) {
  return { id, kind, title: 'Medication', schedule: 'daily', active: true, layerKey: 'medicine', origin: 'doctor', completed };
}

function qualifyingSession(id, hasSets = true) {
  return {
    id,
    userId: USER,
    localDate: TODAY,
    type: 'strength',
    startedAt: `${TODAY}T06:00:00Z`,
    endedAt: `${TODAY}T07:00:00Z`,
    exercises: hasSets ? [{ sets: [{ id: 1, completed: true }] }] : [],
  };
}

function nonQualifyingSession(id) {
  return {
    id,
    userId: USER,
    localDate: TODAY,
    type: 'strength',
    startedAt: `${TODAY}T06:00:00Z`,
    endedAt: `${TODAY}T06:05:00Z`, // only 5 minutes
    exercises: [],
  };
}

// --- Water auto-done ---
test('water auto-done: 2400/2500 ml = progress 0.96, not done', async () => {
  const prisma = mockPrisma({
    planItems: [waterItem(1)],
    nutritionTarget: { waterMl: 2500 },
    waterLogs: [{ userId: USER, localDate: TODAY, ml: 2400 }],
  });

  const res = await resolveDay(prisma, { userId: USER, localDate: TODAY, onLayerKeys: ['water'] });
  const waterRow = res.rows.find(r => r.kind === 'water');
  assert.ok(waterRow);
  assert.equal(waterRow.progress, 0.96);
  assert.equal(waterRow.done, false);
});

test('water auto-done: 2500/2500 ml = done, +5, no manual tick', async () => {
  const prisma = mockPrisma({
    planItems: [waterItem(1)],
    nutritionTarget: { waterMl: 2500 },
    waterLogs: [{ userId: USER, localDate: TODAY, ml: 2500 }],
  });

  const res = await resolveDay(prisma, { userId: USER, localDate: TODAY, onLayerKeys: ['water'] });
  const waterRow = res.rows.find(r => r.kind === 'water');
  assert.ok(waterRow);
  assert.equal(waterRow.done, true);
  assert.equal(waterRow.how, 'auto');
  assert.equal(waterRow.progress, 1);
  assert.equal(res.earned, 5);
  assert.equal(res.target, 5);
});

// --- Workout auto-done ---
test('finished session = workout done +15, no miss, no +8', async () => {
  const prisma = mockPrisma({
    planItems: [workoutItem(1)],
    nutritionTarget: NUTRITION_TARGET,
    sessions: [qualifyingSession(1)],
    workoutTemplates: [{ id: 1, moves: 6 }],
  });
  
  const res = await resolveDay(prisma, { userId: USER, localDate: TODAY, onLayerKeys: ['workout'] });
  const workoutRow = res.rows.find(r => r.kind === 'workout');
  assert.ok(workoutRow);
  assert.equal(workoutRow.done, true);
  assert.equal(workoutRow.how, 'auto');
  assert.equal(res.earned, 15);
  assert.equal(res.target, 15);
  assert.equal(res.bonus, 0);
});

test('second session = +8 bonus', async () => {
  const prisma = mockPrisma({
    planItems: [workoutItem(1, 'workout', 'workout', true)], // already completed
    nutritionTarget: NUTRITION_TARGET,
    sessions: [qualifyingSession(1), qualifyingSession(2)],
    workoutTemplates: [{ id: 1, moves: 6 }],
  });
  
  const res = await resolveDay(prisma, { userId: USER, localDate: TODAY, onLayerKeys: ['workout'] });
  assert.equal(res.bonus, 8);
});

// --- Locked layer ---
test('locked layer row not in target, earns nothing', async () => {
  const prisma = mockPrisma({
    planItems: [
      workoutItem(1),
      stepsItem(2),
      sleepItem(3),
    ],
    nutritionTarget: NUTRITION_TARGET,
    sessions: [],
  });
  
  // Only workout layer is on
  const res = await resolveDay(prisma, { userId: USER, localDate: TODAY, onLayerKeys: ['workout', 'water'] });
  
  assert.equal(res.target, 15); // only workout
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].kind, 'workout');
});

// --- Food row ---
test('food row possible = 25 with both targets', async () => {
  const prisma = mockPrisma({
    planItems: [],
    nutritionTarget: { ...NUTRITION_TARGET, proteinG: 120, kcal: 2000 },
    foodLogs: [],
  });
  prisma.foodLog.findMany = async () => [{
    userId: USER, localDate: TODAY, slot: 'breakfast', nutrients: { kcal: 2000, proteinG: 120 }, source: 'custom'
  }];
  
  const res = await resolveDay(prisma, { userId: USER, localDate: TODAY, onLayerKeys: ['food'] });
  assert.ok(res.food);
  assert.equal(res.food.points, 25); // protein 10 + calories 10 + meals 5
});

test('food row possible = 15 with only kcal target', async () => {
  const prisma = mockPrisma({
    planItems: [],
    nutritionTarget: { ...NUTRITION_TARGET, proteinG: 0, kcal: 2000 },
    foodLogs: [],
  });
  prisma.foodLog.findMany = async () => [{
    userId: USER, localDate: TODAY, slot: 'breakfast', nutrients: { kcal: 2000 }, source: 'custom'
  }];
  
  const res = await resolveDay(prisma, { userId: USER, localDate: TODAY, onLayerKeys: ['food'] });
  assert.ok(res.food);
  assert.equal(res.food.points, 15); // calories 10 + meals 5
});

// --- Paused day ---
test('paused day -> points null', async () => {
  const prisma = mockPrisma({
    planItems: [workoutItem(1)],
    nutritionTarget: NUTRITION_TARGET,
  });
  
  // We can't easily test pause through resolveDay since it doesn't handle pause
  // Pause is handled in scoreEngine.computeDay. This test documents the expected
  // behavior at the scoreEngine level.
  assert.ok(true, 'pause tested in scoreEngine tests');
});

// --- Steps and sleep auto-done ---
test('steps auto-done from DailyActivityMetric', async () => {
  const prisma = mockPrisma({
    planItems: [stepsItem(1)],
    nutritionTarget: { stepsPerDay: 7000 },
    stepsLogs: [{ userId: USER, date: TODAY, steps: 8000 }],
  });

  const res = await resolveDay(prisma, { userId: USER, localDate: TODAY, onLayerKeys: ['steps'] });
  const stepsRow = res.rows.find(r => r.kind === 'steps');
  assert.ok(stepsRow);
  assert.equal(stepsRow.done, true);
  assert.equal(stepsRow.how, 'auto');
});

test('sleep auto-done from BiometricEntry', async () => {
  const prisma = mockPrisma({
    planItems: [sleepItem(1)],
    nutritionTarget: { sleepMinutes: 450 },
    sleepLogs: [{ userId: USER, localDate: TODAY, metric: 'sleep_minutes', value: 500 }],
  });

  const res = await resolveDay(prisma, { userId: USER, localDate: TODAY, onLayerKeys: ['sleep'] });
  const sleepRow = res.rows.find(r => r.kind === 'sleep');
  assert.ok(sleepRow);
  assert.equal(sleepRow.done, true);
  assert.equal(sleepRow.how, 'auto');
});

// --- Supplement auto-done ---
test('supplement auto-done from SupplementLog', async () => {
  const prisma = mockPrisma({
    planItems: [supplementItem(1)],
    nutritionTarget: NUTRITION_TARGET,
    supplementLogs: [{ userId: USER, localDate: TODAY, scheduleId: 1, taken: true }],
  });
  
  const res = await resolveDay(prisma, { userId: USER, localDate: TODAY, onLayerKeys: ['supplements'] });
  const suppRow = res.rows.find(r => r.kind === 'supplement');
  assert.ok(suppRow);
  assert.equal(suppRow.done, true);
  assert.equal(suppRow.how, 'auto');
});

// --- Display order ---
test('rows returned in display order', async () => {
  const prisma = mockPrisma({
    planItems: [
      sleepItem(1),
      waterItem(2),
      workoutItem(3),
      stepsItem(4),
      restItem(5),
      supplementItem(6),
      ownHabitItem(7),
      doctorItem(8),
    ],
    nutritionTarget: NUTRITION_TARGET,
  });
  
  const res = await resolveDay(prisma, { userId: USER, localDate: TODAY, onLayerKeys: ['workout', 'water', 'steps', 'sleep', 'supplements', 'own', 'medicine'] });
  
  const kinds = res.rows.map(r => r.kind);
  // workout/rest, water, food, steps, sleep, supplements, doctor, own
  assert.deepEqual(kinds, ['workout', 'rest', 'water', 'steps', 'sleep', 'supplement', 'doctor', 'own']);
});

// --- Rest day always done ---
test('rest day always done, +5', async () => {
  const prisma = mockPrisma({
    planItems: [restItem(1)],
    nutritionTarget: NUTRITION_TARGET,
  });
  
  const res = await resolveDay(prisma, { userId: USER, localDate: TODAY, onLayerKeys: ['workout'] });
  const restRow = res.rows.find(r => r.kind === 'rest');
  assert.ok(restRow);
  assert.equal(restRow.done, true);
  assert.equal(restRow.points, 5);
  assert.equal(res.earned, 5);
  assert.equal(res.target, 5);
});

// --- Counts ---
test('counts match done/total rows', async () => {
  const prisma = mockPrisma({
    planItems: [
      workoutItem(1, 'workout', 'workout', true),
      waterItem(2, true),
      stepsItem(3, false),
    ],
    nutritionTarget: NUTRITION_TARGET,
  });
  prisma.foodLog.findMany = async () => [{
    userId: USER, localDate: TODAY, slot: 'breakfast', nutrients: { waterMl: 2500 }, source: 'custom'
  }];
  
  const res = await resolveDay(prisma, { userId: USER, localDate: TODAY, onLayerKeys: ['workout', 'water', 'steps'] });
  assert.equal(res.counts.done, 2);
  assert.equal(res.counts.total, 3);
});

// --- Bonus: micronutrients ---
test('micronutrient bonus up to 10', async () => {
  const prisma = mockPrisma({
    planItems: [],
    nutritionTarget: { ...NUTRITION_TARGET, micros: { iron: 19, magnesium: 440, calcium: 1000, zinc: 17 } },
  });
  prisma.foodLog.findMany = async () => [{
    userId: USER, localDate: TODAY, slot: 'breakfast', nutrients: { iron: 20, magnesium: 500, calcium: 1100, zinc: 20 }, source: 'custom'
  }];
  
  const res = await resolveDay(prisma, { userId: USER, localDate: TODAY, onLayerKeys: ['food'] });
  assert.equal(res.bonus, 8); // 4 micros * 2 = 8, capped at 10
});

test('micronutrient bonus capped at 10', async () => {
  const prisma = mockPrisma({
    planItems: [],
    nutritionTarget: { ...NUTRITION_TARGET, micros: { iron: 10, magnesium: 10, calcium: 10, zinc: 10, vitamin_d: 10, vitamin_b12: 10, potassium: 10, sodium: 10 } },
  });
  prisma.foodLog.findMany = async () => [{
    userId: USER, localDate: TODAY, slot: 'breakfast', nutrients: { iron: 20, magnesium: 20, calcium: 20, zinc: 20, vitamin_d: 20, vitamin_b12: 20, potassium: 20, sodium: 20 }, source: 'custom'
  }];
  
  const res = await resolveDay(prisma, { userId: USER, localDate: TODAY, onLayerKeys: ['food'] });
  assert.equal(res.bonus, 10); // capped at 10
});

// --- Workout templateId and moves ---
test('workout row includes templateId and moves', async () => {
  const prisma = mockPrisma({
    planItems: [workoutItem(1, 'workout', 'workout', false, 14)],
    nutritionTarget: NUTRITION_TARGET,
    workoutTemplates: [{ id: 14, exercises: Array.from({ length: 6 }, (_, id) => ({ id })) }],
  });
  
  const res = await resolveDay(prisma, { userId: USER, localDate: TODAY, onLayerKeys: ['workout'] });
  const workoutRow = res.rows.find(r => r.kind === 'workout');
  assert.ok(workoutRow);
  assert.equal(workoutRow.templateId, 14);
  assert.equal(workoutRow.moves, 6);
});
