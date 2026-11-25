import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGoalSchedule, goalPlanView, normalizeGoalDraft, prepareGoalPlan, recordGoalTask, saveGoalPlan,
} from '../services/plan/goalPlanService.js';

const start = '2026-11-30';
const input = {
  title: 'Walk regularly', type: 'routine', days: 10, steps: 7500, walkMinutes: 20,
  walkDays: [1, 3, 5], waterMl: 2200, sleepMinutes: 450,
  nutrition: { kcal: 2200, protein: 120, fat: 80 },
  workouts: [{ id: 'a', title: 'Strength', weekday: 1, minutes: 35, exercises: [
    { name: 'Squat', sets: 3, reps: 10 },
    { name: 'Plank', sets: 2, seconds: 30 },
  ] }],
};

function storage() {
  let row;
  return {
    goalPlan: {
      async findUnique() { return row && structuredClone(row); },
      async create({ data }) {
        row = { ...data, revision: 1 };
        return structuredClone(row);
      },
      async updateMany({ where, data }) {
        if (row.revision !== where.revision) return { count: 0 };
        row = { ...row, ...data, revision: row.revision + 1 };
        return { count: 1 };
      },
    },
  };
}

test('progression has exact end targets, rest days and stable nutrition', () => {
  for (const days of [6, 31]) assert.throws(() => normalizeGoalDraft({ ...input, days }), { status: 400 });
  const schedule = buildGoalSchedule(normalizeGoalDraft(input), start);
  assert.equal(schedule.length, 10);
  assert.equal(schedule[0].tasks.find((task) => task.key === 'steps').amount, 6000);
  assert.equal(schedule.at(-1).tasks.find((task) => task.key === 'steps').amount, 7500);
  assert.equal(schedule[1].tasks.some((task) => task.key === 'walk'), false);
  assert.equal(schedule[0].tasks.find((task) => task.key === 'workout-a').exercises[1].seconds, 30);
  assert.equal(schedule[0].nutrition.carbs, 250);
  assert.deepEqual(schedule[0].nutrition, schedule.at(-1).nutrition);
});

test('prediabetes uses agreed meal habits and does not generate nutrition targets', () => {
  const draft = normalizeGoalDraft({ ...input, type: 'glucose', reviewDate: '2026-12-20' });
  const [day] = buildGoalSchedule(draft, start);
  assert.equal(draft.nutrition, null);
  assert.equal(day.tasks.some((task) => task.key === 'calories'), false);
  assert.equal(day.tasks.some((task) => task.key === 'meals'), true);
});

test('walking, step and water preferences use the existing dated tasks', () => {
  const draft = normalizeGoalDraft({ ...input, habits: ['walking', 'steps', 'track'] });
  const { schedule, ...state } = prepareGoalPlan(draft, null, start);
  assert.ok(schedule.every(day => !day.tasks.some(task => task.key.startsWith('habit-'))));
  assert.equal(goalPlanView({ ...state, schedule }, start).plan.milestone.kind, 'walks');
});

test('an unrecorded walk moves the estimate to the next scheduled walk', async () => {
  const prisma = storage();
  const draft = { ...input, days: 7 };
  const saved = await saveGoalPlan(prisma, 42, { draft, revision: 0 }, start);
  assert.equal(saved.plan.milestone.estimate, '2026-12-04');
  const afterFirst = '2026-12-01';
  const row = await prisma.goalPlan.findUnique({ where: { userId: 42 } });
  assert.equal(goalPlanView(row, afterFirst).plan.milestone.estimate, '2026-12-07');
  assert.equal(goalPlanView(row, afterFirst).plan.milestone.delay, 3);
  const corrected = await recordGoalTask(prisma, 42, { date: start, key: 'walk', done: true }, afterFirst);
  assert.equal(corrected.plan.milestone.delay, 0);
});

test('edits update future tasks, preserve past and checked targets, and resist stale writes', async () => {
  const prisma = storage();
  const saved = await saveGoalPlan(prisma, 42, { draft: input, revision: 0 }, start);
  assert.equal(saved.plan.revision, 1);
  assert.equal((await saveGoalPlan(prisma, 42, { draft: input, revision: 0 }, start)).plan.revision, 1);
  const done = await recordGoalTask(prisma, 42, { date: start, key: 'walk', done: true }, start);
  assert.equal(done.plan.milestone.earned, 10);
  assert.equal((await recordGoalTask(prisma, 42, { date: start, key: 'walk', done: true }, start)).plan.revision, 2);
  await assert.rejects(recordGoalTask(prisma, 42, { date: '2026-12-01', key: 'steps', done: true }, start), { status: 400 });
  const tomorrow = '2026-12-01';
  const revised = { ...input, steps: 8500, workouts: [] };
  const checkedPreview = prepareGoalPlan(normalizeGoalDraft(revised), done.plan, tomorrow);
  await assert.rejects(saveGoalPlan(prisma, 42, { draft: revised, revision: 1 }, tomorrow), { status: 409 });
  const edited = await saveGoalPlan(prisma, 42, { draft: revised, revision: 2 }, tomorrow);
  assert.deepEqual(checkedPreview.schedule, edited.plan.schedule);
  assert.deepEqual(edited.plan.schedule[0], saved.plan.schedule[0]);
  assert.equal(edited.plan.schedule.at(-1).tasks[0].amount, 8500);
  const onDec3 = goalPlanView(edited.plan, '2026-12-03');
  assert.equal(onDec3.plan.milestone.earned, 10);
  assert.ok(onDec3.plan.milestone.delay > 0);
});

test('an ended plan can restart with the same targets while keeping the previous phase', async () => {
  const prisma = storage();
  await saveGoalPlan(prisma, 42, { draft: input, revision: 0 }, start);
  const recorded = await recordGoalTask(prisma, 42, { date: start, key: 'walk', done: true }, start);
  const next = '2027-01-15';
  const ended = goalPlanView(await prisma.goalPlan.findUnique(), next);
  assert.equal(ended.plan.expired, true);
  const open = await saveGoalPlan(prisma, 42, { draft: input, revision: recorded.plan.revision }, next);
  assert.equal(open.plan.expired, false);
  assert.equal(open.plan.schedule[0].date, next);
  assert.equal(open.plan.history.length, input.days);
  assert.deepEqual(open.plan.completions[start], ['walk']);
  assert.equal(open.plan.milestone.earned, 0);
  const replay = await saveGoalPlan(prisma, 42, { draft: input, revision: recorded.plan.revision }, next);
  assert.equal(replay.plan.revision, open.plan.revision);
});
