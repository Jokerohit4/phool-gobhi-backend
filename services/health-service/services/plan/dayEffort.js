/**
 * "Effort" - the Today card's running points.
 *
 * The score engine pays all-or-nothing: a water row is worth 5 once the full
 * target is logged and 0 before it, food pays only at protein >= 90%, calories
 * within 10%, or three main meals. That is right for the frozen daily score,
 * but on the Today card it made every log invisible: someone who drank two
 * glasses and ate a meal saw 0 / 45 and no sign the app had noticed.
 *
 * This layer sits on top and only ever ADDS what the engine already counted:
 *
 *   - a row that is done credits exactly what the engine paid (`row.earned`);
 *   - a row with progress credits a share of its points, never the whole of
 *     them (that stays the engine's, on completion), and never zero once
 *     anything was logged;
 *   - mood check-ins are a row of their own, here only.
 *
 * It does NOT touch `earned`, `target`, `bonus` or `score` in the payload, so
 * the frozen daily snapshot, the Health Score and every penalty are exactly
 * what they were. A day closes on completed rows alone; effort is what you can
 * see filling while you do them.
 *
 * Over-eating is never credited: calories earn up to the target and a little
 * past it (the engine's own +-10% band) and nothing beyond, so eating more is
 * not a way to a bigger number (the guard in `ledger/constants.js`).
 */
import { ROW_POINTS } from '../ledger/constants.js';

/** One mood check-in is worth this, two a day (morning, night) = `mood`. */
export const MOOD_ROW_POINTS = 4;
export const MOOD_CHECKINS_PER_DAY = 2;

const HABIT_KINDS = new Set(['water', 'steps', 'sleep']);

/**
 * A share of `max` for a 0..1 ratio: 0 for nothing, at least 1 for anything,
 * at most `max - 1` until it is actually complete (completion is the engine's).
 */
export function partialPoints(max, ratio) {
  if (!(ratio > 0) || !(max > 0)) return 0;
  if (ratio >= 1) return max;
  return Math.min(max - 1, Math.max(1, Math.round(max * ratio)));
}

function foodCredit(row, { nutritionTarget, totals }) {
  const engineEarned = Number(row.earned) || 0;
  if (!nutritionTarget || !totals) return engineEarned;
  const proteinTarget = Number(nutritionTarget.proteinG) || 0;
  const kcalTarget = Number(nutritionTarget.kcal) || 0;

  let credit = 0;
  if (proteinTarget > 0) {
    const ratio = (Number(totals.proteinG) || 0) / proteinTarget;
    // The engine pays at 90%, so 90% is "full" here too.
    credit += ratio >= 0.9 ? ROW_POINTS.foodProtein : partialPoints(ROW_POINTS.foodProtein, ratio / 0.9);
  }
  if (kcalTarget > 0) {
    const ratio = (Number(totals.kcal) || 0) / kcalTarget;
    if (ratio <= 1.1) {
      credit += ratio >= 0.9 ? ROW_POINTS.foodCalories : partialPoints(ROW_POINTS.foodCalories, ratio / 0.9);
    }
    // Beyond the on-target band: no credit for the calories part.
  }
  const meals = Math.min(3, Number(totals.mealSlotsCovered) || 0);
  credit += meals >= 3 ? ROW_POINTS.foodMeals : partialPoints(ROW_POINTS.foodMeals, meals / 3);

  // Never below what the engine already paid, never above the row's worth.
  return Math.min(Number(row.points) || credit, Math.max(engineEarned, credit));
}

function creditFor(row, ctx) {
  if (row.done) return Number(row.earned) || 0;
  if (row.kind === 'food') return foodCredit(row, ctx);
  if (HABIT_KINDS.has(row.kind)) {
    return partialPoints(Number(row.points) || 0, Number(row.progress) || 0);
  }
  return 0; // workout, supplements, own, doctor: binary
}

/**
 * @param {{rows: object[], nutritionTarget?: object|null, totals?: object|null,
 *          earned: number, target: number}} resolved  resolveDay's result
 * @param {Array<{slot: string, mood: string, createdAt?: Date}>} moodCheckIns today's
 * @returns {{rows: object[], effort: {earned: number, target: number}}}
 */
export function applyEffort(resolved, moodCheckIns = []) {
  const ctx = { nutritionTarget: resolved.nutritionTarget, totals: resolved.totals };
  let earnedDelta = 0;
  const rows = resolved.rows.map((row) => {
    const credit = creditFor(row, ctx);
    earnedDelta += credit - (Number(row.earned) || 0);
    return { ...row, credit };
  });

  const count = Math.min(MOOD_CHECKINS_PER_DAY, moodCheckIns.length);
  const perCheckIn = MOOD_ROW_POINTS / MOOD_CHECKINS_PER_DAY;
  const moodCredit = count * perCheckIn;
  const latest = [...moodCheckIns].sort(
    (a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
  )[0];
  rows.unshift({
    key: 'mood',
    id: null,
    itemId: null,
    kind: 'mood',
    layerKey: 'mood',
    origin: 'suggested',
    title: 'Mood',
    points: MOOD_ROW_POINTS,
    earned: moodCredit,
    credit: moodCredit,
    late: false,
    done: count >= MOOD_CHECKINS_PER_DAY,
    how: count > 0 ? 'auto' : null,
    progress: count / MOOD_CHECKINS_PER_DAY,
    value: count,
    target: MOOD_CHECKINS_PER_DAY,
    unit: 'check-ins',
    mood: latest?.mood ?? null,
    action: 'log_mood',
    protein: null,
  });

  return {
    rows,
    effort: {
      earned: resolved.earned + earnedDelta + moodCredit,
      target: resolved.target + MOOD_ROW_POINTS,
    },
  };
}
