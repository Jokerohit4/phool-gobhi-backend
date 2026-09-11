import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Multi-week plans (D-02/H-22, docs/../sprint2/PG-HUNT-001) — a thin
// sequence over the same WorkoutTemplate/WorkoutSession machinery the rest
// of this service already has. Starting a plan sets one row
// (UserActivePlan); everything about "what day is it" is derived on read
// from that row's startedOn, never stored as a separate pointer — same
// "derive, don't duplicate" principle consistencyStreakService uses, for
// the same reason: a stored currentDay could desync from calendar reality
// (a missed day, a timezone edge) in a way a pure function of `today -
// startedOn` cannot.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toLocalDateOnly(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

// 1-based day-of-plan, capped at the plan's total length. Never negative,
// never zero, never past the end — so week/day math downstream can assume
// a value that's always a valid position in the plan.
function calendarDayNumber(startedOn, totalDays, now = new Date()) {
  const elapsed = Math.floor((toLocalDateOnly(now) - toLocalDateOnly(startedOn)) / MS_PER_DAY);
  return Math.min(Math.max(elapsed + 1, 1), totalDays);
}

function dayNumberToWeekAndDay(dayNumber) {
  return {
    weekIndex: Math.floor((dayNumber - 1) / 7) + 1,
    dayIndex: ((dayNumber - 1) % 7) + 1,
  };
}

export async function listPlansService() {
  return prisma.workoutPlan.findMany({
    where: { isSystem: true },
    orderBy: { id: 'asc' },
  });
}

// Never 404s — no active plan is a valid state (H-20's empty-state screen:
// "no plan yet — grab the 4-week starter"), same convention every other
// GET in this service uses for "hasn't set this up" rather than treating
// it as an error.
export async function getActivePlanService(userId) {
  const active = await prisma.userActivePlan.findUnique({
    where: { userId },
    include: { plan: true },
  });
  if (!active) return null;

  const totalDays = active.plan.weeks * 7;
  const dayNumber = calendarDayNumber(active.startedOn, totalDays);
  const { weekIndex, dayIndex } = dayNumberToWeekAndDay(dayNumber);
  const isLastDay = dayNumber === totalDays;

  const planDay = await prisma.workoutPlanDay.findUnique({
    where: { planId_weekIndex_dayIndex: { planId: active.planId, weekIndex, dayIndex } },
    include: { template: { include: { exercises: { include: { exercise: true }, orderBy: { order: 'asc' } } } } },
  });

  return {
    planId: active.planId,
    planKey: active.plan.key,
    planName: active.plan.name,
    startedOn: active.startedOn,
    completedAt: active.completedAt,
    totalDays,
    dayNumber,
    weekIndex,
    dayIndex,
    isLastDay,
    // Null template on a valid plan day means a scheduled rest day, not a
    // seeding gap — see the WorkoutPlanDay.templateId schema comment.
    todayTemplate: planDay?.template ?? null,
  };
}

// Starting a plan REPLACES any current one (one active plan per user, v1's
// deliberate simplicity constraint — see the UserActivePlan schema
// comment). Restarting the SAME plan resets startedOn to today rather than
// silently no-op'ing, so "start over" behaves the way a user asking for it
// would expect.
export async function startPlanService(userId, planKey) {
  const plan = await prisma.workoutPlan.findUnique({ where: { key: planKey } });
  if (!plan || !plan.isSystem) {
    const err = new Error('Plan not found');
    err.status = 404;
    throw err;
  }
  await prisma.userActivePlan.upsert({
    where: { userId },
    create: { userId, planId: plan.id, startedOn: new Date() },
    update: { planId: plan.id, startedOn: new Date(), completedAt: null },
  });
  return getActivePlanService(userId);
}

export async function abandonPlanService(userId) {
  await prisma.userActivePlan.deleteMany({ where: { userId } });
}
