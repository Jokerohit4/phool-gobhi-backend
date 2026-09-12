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

// 1-based day-of-plan, NOT clamped — can run past totalDays once the plan
// has genuinely finished, and callers that need "which day's content do I
// show" clamp this themselves (see getActivePlanService). Keeping the raw
// count separate from the clamped one is what lets isFinished be computed
// honestly: a clamped value can never tell "still on day 28" apart from
// "day 51, still clamped to 28".
function rawDayNumber(startedOn, now = new Date()) {
  const elapsed = Math.floor((toLocalDateOnly(now) - toLocalDateOnly(startedOn)) / MS_PER_DAY);
  return elapsed + 1;
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
  const raw = rawDayNumber(active.startedOn);
  const dayNumber = Math.min(Math.max(raw, 1), totalDays);
  const { weekIndex, dayIndex } = dayNumberToWeekAndDay(dayNumber);
  const isLastDay = dayNumber === totalDays;
  const isFinished = raw > totalDays;

  // Persisted the first time it's observed true, same convention
  // goalService.resolveGoalService uses for a derived fact that shouldn't
  // recompute differently between two reads — completedAt was previously
  // set only on create/restart (always null) and never had anything that
  // set it true, so a finished plan could never actually be marked
  // finished. This is that missing write, made exactly once.
  let completedAt = active.completedAt;
  if (isFinished && !completedAt) {
    const updated = await prisma.userActivePlan.update({
      where: { userId },
      data: { completedAt: new Date() },
    });
    completedAt = updated.completedAt;
  }

  const planDay = await prisma.workoutPlanDay.findUnique({
    where: { planId_weekIndex_dayIndex: { planId: active.planId, weekIndex, dayIndex } },
    include: { template: { include: { exercises: { include: { exercise: true }, orderBy: { order: 'asc' } } } } },
  });

  return {
    planId: active.planId,
    planKey: active.plan.key,
    planName: active.plan.name,
    startedOn: active.startedOn,
    completedAt,
    totalDays,
    dayNumber,
    weekIndex,
    dayIndex,
    isLastDay,
    isFinished,
    // Null template on a valid plan day means a scheduled rest day, not a
    // seeding gap — see the WorkoutPlanDay.templateId schema comment.
    // Still returned once finished (the last day's content), so a client
    // that hasn't shipped a "plan complete" screen yet degrades to
    // "showing the last day forever" instead of a blank state.
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
