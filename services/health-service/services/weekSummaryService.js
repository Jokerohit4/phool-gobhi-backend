import { isFeatureEnabled } from '../middleware/requireFeatureFlag.js';
import { isoDayIST, weekStartOf, weekDays, shiftDay, COUNTED_WORKOUT_WHERE } from '../utils/sessionDay.js';
import { isIsoDay } from './ledger/isoDay.js';
import { sumFoodLogs } from './ledger/nutritionService.js';
import { nutritionTargetFromHistory } from './ledger/currentTarget.js';
import { resolveDay } from './plan/rowProgress.js';
import { getLayers, getOnLayerKeys } from './plan/layerState.js';
import { hasCoachScopeService } from './coachConsentService.js';
import { resolveGoalService } from './goalService.js';
import { getShowedUpDays } from './journey/showedUpDays.js';
import { foodStatus, waterMet, summarizeDays } from './weekSummary/definitions.js';
import redis from '../utils/redisClient.js';

export function resolveWeek(week, today = isoDayIST()) {
  const current = weekStartOf(today);
  const start = week === undefined ? current : week;
  if (typeof start !== 'string' || !isIsoDay(start) || weekStartOf(start) !== start || start > current) {
    throw { status: 400, code: 'INVALID_WEEK', error: 'week must be a Monday on or before the current IST week' };
  }
  return start;
}

// Use persisted unlocks. getJourney() syncs unlocks, rebuilds plans and emits
// events, which must not happen as a side effect of this review endpoint.
export async function weekSummaryAccess(prisma, userId) {
  const basic = await hasCoachScopeService(userId, 'basic');
  const progress = basic ? await prisma.journeyProgress.findUnique({ where: { userId } }) : null;
  if (!progress) return { layers: [], onLayerKeys: [] };
  const journey = {
    ...progress,
    layers: (progress.unlocked ?? []).map(u => ({ layer: u.layer, unlocked: true, unlockedAt: u.at })),
  };
  const state = await getLayers(prisma, userId, { journey });
  const resolvedKeys = await getOnLayerKeys(prisma, userId, { journey, layers: state });
  const [healthMetrics, healthLedger] = await Promise.all([
    isFeatureEnabled('healthMetrics'), isFeatureEnabled('healthLedger'),
  ]);
  // Enforce the food gate here too, including keys passed to today's resolver.
  const onLayerKeys = resolvedKeys.filter(key => key !== 'food' || (healthMetrics && healthLedger));
  const layers = ['plan'];
  if (onLayerKeys.includes('food')) layers.push('food');
  if (onLayerKeys.includes('water')) layers.push('water');
  if (onLayerKeys.includes('workout')) layers.push('workouts');
  return { layers, onLayerKeys };
}

export async function getWeekSummary(prisma, { userId, week, now = new Date() }, deps = {}) {
  const today = isoDayIST(now);
  const weekStart = resolveWeek(week, today);
  const dates = weekDays(weekStart);
  const weekEnd = dates[6];
  const isCurrentWeek = weekStart === weekStartOf(today);
  const access = await (deps.access ?? weekSummaryAccess)(prisma, userId);
  const { layers, onLayerKeys } = access;
  const signature = JSON.stringify([today, layers, onLayerKeys]);
  const cache = deps.cache ?? redis;
  const key = `health:week:${userId}:${weekStart}`;
  // Re-check consent/layers before every cache hit, including consent withdrawal.
  try {
    const cached = JSON.parse(await cache.get(key));
    if (cached?.signature === signature) return cached.data;
  } catch { /* cache failure must not fail a read */ }

  const range = { userId, localDate: { in: dates.filter(d => d <= today) } };
  const [foodLogs, waterRows, snapshots, workouts, history, goal, healthGoal, showedUp] = await Promise.all([
    layers.includes('food') ? prisma.foodLog.findMany({ where: range, orderBy: [{ slot: 'asc' }, { createdAt: 'asc' }] }) : [],
    layers.includes('water') ? prisma.waterLog.groupBy({ by: ['localDate'], where: range, _sum: { ml: true } }) : [],
    layers.includes('plan') ? prisma.scoreDaySnapshot.findMany({ where: range }) : [],
    layers.includes('workouts') ? prisma.workoutSession.findMany({ where: { ...range, ...COUNTED_WORKOUT_WHERE }, select: { localDate: true } }) : [],
    layers.some(l => l === 'food' || l === 'water') ? prisma.nutritionTarget.findMany({ where: { userId }, orderBy: { effectiveFrom: 'asc' } }) : [],
    layers.includes('workouts') ? (deps.goal ?? (id => resolveGoalService(id, { persist: false })))(userId) : null,
    layers.length ? prisma.healthGoal.findUnique({ where: { userId } }) : null,
    layers.length ? (deps.showedUp ?? ((id, from, to) => getShowedUpDays(id, from, { to, limit: 7 })))(userId, weekStart, weekEnd) : [],
  ]);
  const snapshotByDay = new Map(snapshots.map(s => [s.localDate, s]));
  const waterByDay = new Map(waterRows.map(r => [r.localDate, Number(r._sum.ml) || 0]));
  const showedUpDays = new Set(showedUp);
  const days = [];
  for (const localDate of dates) {
    const isToday = localDate === today;
    const isFuture = localDate > today;
    const snapshot = snapshotByDay.get(localDate);
    const paused = !isFuture && (snapshot ? snapshot.paused === true
      : Boolean(healthGoal?.pausedFrom && healthGoal?.pausedUntil && localDate >= healthGoal.pausedFrom && localDate <= healthGoal.pausedUntil));
    const day = { localDate, isToday, isFuture, paused };
    if (layers.includes('plan')) {
      if (isFuture) day.plan = null;
      else if (!isToday) {
        // Legacy snapshots have no counts or target decision. Unknown is not a miss.
        const summary = snapshot?.planSummary;
        day.plan = { done: summary?.done ?? null, total: summary?.total ?? null, targetHit: summary?.targetHit ?? null, source: 'snapshot' };
      } else {
        const live = await (deps.resolveDay ?? resolveDay)(prisma, { userId, localDate, onLayerKeys });
        day.plan = { ...live.counts, targetHit: live.earned >= live.target, source: 'live' };
      }
    }
    const target = nutritionTargetFromHistory(history, localDate);
    if (layers.includes('food')) {
      if (isFuture) day.food = null;
      else {
        const summed = sumFoodLogs(foodLogs.filter(l => l.localDate === localDate));
        const food = {
          logCount: summed.logCount,
          mealSlotsCovered: ['breakfast', 'lunch', 'dinner'].filter(slot => summed.bySlot[slot]?.count > 0).length,
          kcal: summed.totals.kcal, targetKcal: target?.kcal == null ? null : Number(target.kcal), pendingCount: summed.pendingCount,
        };
        day.food = { status: foodStatus({ ...food, isToday }), ...food };
      }
    }
    if (layers.includes('water')) {
      const ml = waterByDay.get(localDate) ?? 0;
      const targetMl = target?.waterMl == null ? null : Number(target.waterMl);
      day.water = isFuture ? null : { ml, targetMl, met: !isToday && waterMet(ml, targetMl) };
    }
    if (layers.includes('workouts')) day.workout = isFuture ? null : { counted: workouts.some(w => w.localDate === localDate) };
    day.showedUp = isFuture ? null : showedUpDays.has(localDate);
    days.push(day);
  }
  const data = {
    weekStart, weekEnd, isCurrentWeek, prevWeek: shiftDay(weekStart, -7), nextWeek: isCurrentWeek ? null : shiftDay(weekStart, 7),
    daysElapsed: dates.filter(d => d <= today).length, pausedDays: days.filter(d => d.paused).length,
    layers, days, totals: summarizeDays(days, layers, goal, workouts.length),
  };
  try { await cache.set(key, JSON.stringify({ signature, data }), 'EX', isCurrentWeek ? 60 : 600); } catch { /* best effort */ }
  return data;
}
