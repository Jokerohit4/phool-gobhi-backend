import prisma from '../db/prisma.js';
import { equipmentFit } from './homeSetup.js';
import { releaseExpiredRecoveryMode } from './cycleTrackingService.js';
import {
  startOfIsoWeek, dayString, dayToDate, COUNTED_WORKOUT_WHERE,
} from '../utils/sessionDay.js';

const RANGE_DAYS = { '4w': 28, '3m': 90, '1y': 365 };

function startOfRange(range) {
  const days = RANGE_DAYS[range] || RANGE_DAYS['4w'];
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// Aggregate: total workouts/volume in range, volume trend by week,
// muscle-group split, current PRs — powers the Training Progress screen.
// Named "Training Progress" deliberately, not "Progress" — this app already
// has a ProgressHubScreen (badges/coins/challenges) and the two must never
// be confused, per the implementation plan's file-layout note.
export async function getProgressSummaryService(userId, range) {
  const since = startOfRange(range);
  // Only counted workouts count, so an empty quick-log or a rest day doesn't
  // inflate the "workouts" total on the Training Progress screen (matches the
  // home ring, the stats KPI and the streak).
  // The PR read does not depend on the sessions read: run them together. The
  // exercise include is narrowed to the one field the loop reads (muscleGroup).
  const [sessions, personalRecords] = await Promise.all([
    prisma.workoutSession.findMany({
      where: { userId, startedAt: { gte: since }, ...COUNTED_WORKOUT_WHERE },
      include: { exercises: { include: { exercise: { select: { muscleGroup: true } }, sets: { where: { completed: true } } } } },
    }),
    getPersonalRecordsService(userId),
  ]);

  let totalVolumeKg = 0;
  let totalDurationSeconds = 0;
  const volumeByWeek = {};
  const volumeByMuscleGroup = {};

  for (const session of sessions) {
    // Monday-start IST week, keyed on the day the user experienced — the same
    // boundary as the goal, the streak and the stats bars.
    const day = session.localDate ? dayToDate(session.localDate) : session.startedAt;
    const weekKey = dayString(startOfIsoWeek(day));
    volumeByWeek[weekKey] = volumeByWeek[weekKey] || 0;

    if (session.endedAt) {
      totalDurationSeconds += (session.endedAt - session.startedAt) / 1000;
    }
    for (const se of session.exercises) {
      const muscleGroup = se.exercise.muscleGroup;
      volumeByMuscleGroup[muscleGroup] = volumeByMuscleGroup[muscleGroup] || 0;
      for (const set of se.sets) {
        if (set.weightKg && set.reps) {
          const volume = Number(set.weightKg) * set.reps;
          totalVolumeKg += volume;
          volumeByWeek[weekKey] += volume;
          volumeByMuscleGroup[muscleGroup] += volume;
        }
      }
    }
  }

  const totalGroupVolume = Object.values(volumeByMuscleGroup).reduce((a, b) => a + b, 0) || 1;
  const muscleGroupSplit = Object.entries(volumeByMuscleGroup).map(([muscleGroup, volume]) => ({
    muscleGroup,
    percent: Math.round((volume / totalGroupVolume) * 100),
  }));

  return {
    range: range || '4w',
    totalWorkouts: sessions.length,
    totalVolumeKg: Math.round(totalVolumeKg),
    avgDurationSeconds: sessions.length ? Math.round(totalDurationSeconds / sessions.length) : 0,
    volumeTrend: Object.entries(volumeByWeek)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([weekStart, volumeKg]) => ({ weekStart, volumeKg: Math.round(volumeKg) })),
    muscleGroupSplit,
    personalRecords,
  };
}

// Top result per exercise, ranked by estimated volume (weight * reps) —
// same personal-records concept as exerciseLibraryService's per-exercise
// detail stats, just surfaced as a flat list across every exercise trained.
async function getPersonalRecordsService(userId, limit = 5) {
  // Done in SQL so only the top `limit` rows leave the database, not every set
  // the user ever logged. Reproduces the old JS exactly:
  //  - eligible sets: completed, weight and reps both non-null, user's own;
  //  - "best" per exercise NAME (not id: two exercises sharing a name merge) is
  //    the max weight*reps, computed in float8 like JS's Number*Number so ties
  //    and near-ties compare identically; the old loop only replaced on a strict
  //    >, so the first set seen wins a tie. findMany had no orderBy, so "first"
  //    is insertion (id) order -> ORDER BY id;
  //  - the final list was a stable sort by score desc over Map insertion order,
  //    i.e. the order each name was first seen -> tie-break on MIN(id) per name.
  const rows = await prisma.$queryRaw`
    WITH s AS (
      SELECT e."name" AS "name", ws."id" AS "id",
             ws."weightKg"::float8 AS "weightKg", ws."reps" AS "reps",
             ws."weightKg"::float8 * ws."reps"::float8 AS "score"
      FROM "health"."WorkoutSet" ws
      JOIN "health"."SessionExercise" se ON se."id" = ws."sessionExerciseId"
      JOIN "health"."WorkoutSession" sess ON sess."id" = se."sessionId"
      JOIN "health"."Exercise" e ON e."id" = se."exerciseId"
      WHERE ws."completed"
        AND ws."weightKg" IS NOT NULL
        AND ws."reps" IS NOT NULL
        AND sess."userId" = ${userId}
    ),
    best AS (
      SELECT DISTINCT ON ("name") "name", "weightKg", "reps", "score"
      FROM s
      ORDER BY "name", "score" DESC, "id" ASC
    ),
    firstSeen AS (
      SELECT "name", MIN("id") AS "firstId" FROM s GROUP BY "name"
    )
    SELECT b."name" AS "exerciseName", b."weightKg" AS "weightKg", b."reps" AS "reps"
    FROM best b
    JOIN firstSeen f ON f."name" = b."name"
    ORDER BY b."score" DESC, f."firstId" ASC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({ exerciseName: r.exerciseName, weightKg: Number(r.weightKg), reps: Number(r.reps) }));
}

// A simple, explicitly non-ML heuristic (see the implementation plan's Open
// Items) — days since a muscle group was last trained, against a fixed
// recovery window per group. "ready" if the window has elapsed or the
// group has never been trained; "recovering" otherwise. This intentionally
// does not personalize by intensity, sleep, or anything else Whoop-style —
// that's a real future upgrade, not a v1 promise.
const RECOVERY_WINDOW_DAYS = {
  chest: 2, back: 2, shoulders: 2, arms: 1, legs: 3, core: 1, cardio: 1, fullBody: 2,
};

// Injury-zone chips (FR-26) map to the muscle groups they should steer
// volume away from. Deliberately conservative and non-diagnostic: a knee
// chip suppresses leg emphasis, it does not diagnose anything or claim the
// alternative is "safe".
const INJURY_ZONE_GROUPS = {
  knee: ['legs'],
  shoulder: ['shoulders', 'chest'],
  lower_back: ['back', 'legs'],
  wrist: ['arms', 'chest'],
  neck: ['shoulders'],
};

// FR-25's female_default: the doc's stated bias is lower-body/hip-mobility
// emphasis. Expressed as a scoring weight rather than a hard filter, so it
// nudges which saved routine surfaces first without ever hiding one.
const MODE_GROUP_WEIGHTS = {
  neutral: {},
  female_default: { legs: 1.35, core: 1.2 },
  // low_impact_recovery biases toward mobility/cardio/core and away from
  // heavy compound emphasis (FR-27) — paired with suppressPrPush below.
  low_impact_recovery: { cardio: 1.4, core: 1.3, legs: 0.7, chest: 0.8, back: 0.8 },
};

// Recovery mode stretches every window, so the engine stops declaring
// groups ready as eagerly. 1.5x is a judgement call, not a clinical figure.
const RECOVERY_MODE_WINDOW_MULTIPLIER = 1.5;

// Per muscle group, the most recent startedAt of a counted session that trained
// it. "Counted" mirrors COUNTED_WORKOUT_WHERE (finished, non-rest, >=1 completed
// set), so a rest day or an abandoned log doesn't mark a muscle as trained.
// Deliberately NOT time-bounded: daysSinceTrained is reported for any age.
// Prisma's NOT { type: 'rest' } compiles to a plain SQL <>, so a null type
// (never-confirmed draft) is excluded too - the same three-valued logic here.
// One row per group instead of the whole history.
function loadLastTrainedByGroup(userId) {
  return prisma.$queryRaw`
    SELECT e."muscleGroup"::text AS "muscleGroup", MAX(s."startedAt") AS "lastTrainedAt"
    FROM "health"."SessionExercise" se
    JOIN "health"."WorkoutSession" s ON s."id" = se."sessionId"
    JOIN "health"."Exercise" e ON e."id" = se."exerciseId"
    WHERE s."userId" = ${userId}
      AND s."endedAt" IS NOT NULL
      AND s."type" <> 'rest'::"health"."WorkoutType"
      AND EXISTS (
        SELECT 1 FROM "health"."SessionExercise" se2
        JOIN "health"."WorkoutSet" ws ON ws."sessionExerciseId" = se2."id"
        WHERE se2."sessionId" = s."id" AND ws."completed"
      )
    GROUP BY e."muscleGroup"
  `;
}

export async function getMuscleReadinessService(userId) {
  const [lastTrainedRows, profile, templates] = await Promise.all([
    loadLastTrainedByGroup(userId),
    prisma.personalisationProfile.findUnique({ where: { userId } }),
    // Independent of readiness (only the scoring below needs it): start it now.
    loadSuggestionTemplates(userId),
  ]);

  // The mode is the stored value, lazily expired: a low_impact_recovery this
  // service's cycle sync set during the last period lapses back to neutral the
  // moment its window closes, so readiness never trusts a stale override.
  const mode = await releaseExpiredRecoveryMode(userId, profile?.programmingMode ?? 'neutral');
  const injuryZones = profile?.injuryZones ?? [];
  const windowMultiplier = mode === 'low_impact_recovery' ? RECOVERY_MODE_WINDOW_MULTIPLIER : 1;

  // Groups the user's injury chips say to steer away from — reported as
  // 'limited' rather than 'recovering', since nothing is healing here; the
  // user has simply asked us to route around it.
  const limitedGroups = new Set();
  for (const zone of injuryZones) {
    for (const group of INJURY_ZONE_GROUPS[zone] ?? []) limitedGroups.add(group);
  }

  const lastTrainedAt = {};
  for (const row of lastTrainedRows) lastTrainedAt[row.muscleGroup] = row.lastTrainedAt;

  const now = Date.now();
  const readiness = Object.keys(RECOVERY_WINDOW_DAYS).map((muscleGroup) => {
    const last = lastTrainedAt[muscleGroup];
    const daysSince = last ? (now - new Date(last).getTime()) / (24 * 60 * 60 * 1000) : Infinity;
    const windowDays = RECOVERY_WINDOW_DAYS[muscleGroup] * windowMultiplier;
    const status = limitedGroups.has(muscleGroup)
      ? 'limited'
      : daysSince >= windowDays ? 'ready' : 'recovering';
    return { muscleGroup, daysSinceTrained: last ? Math.round(daysSince) : null, status };
  });

  const suggestedTemplate = pickSuggestedTemplate(templates, readiness, mode, profile);
  return {
    readiness,
    suggestedTemplate,
    // Echoed back so the client can render the "showing personalised
    // suggestions / show neutral instead" affordance (FR-25) without a
    // second round trip.
    programmingMode: mode,
    // FR-27: in recovery mode the client must not push PRs or progression
    // prompts. Sent as a plain instruction rather than making the client
    // infer it from the mode name.
    suppressPrPush: mode === 'low_impact_recovery',
  };
}

// Scores each saved routine by how many of its exercises' muscle groups are
// currently "ready," and returns the highest-scoring one — a deliberately
// simple recency heuristic (see the schema/service comment above), not a
// personalized recommendation model. The mode weights (FR-25/27) nudge the
// ranking; a 'limited' group (an injury chip the user set) scores zero for
// that exercise, so a routine built entirely around a limited group loses to
// one that isn't — but it's still returned rather than hidden if it's all
// the user has.
//
// Home setup (onboarding audit P2): a routine needing equipment the user said
// they don't have is only a candidate when NOTHING they own fits — the same
// "still returned rather than hidden if it's all the user has" rule as limited
// groups above. Unknown setup (never answered) changes nothing.
function loadSuggestionTemplates(userId) {
  return prisma.workoutTemplate.findMany({
    where: { userId },
    include: {
      exercises: { include: { exercise: { select: { muscleGroup: true, equipment: true } } } },
    },
  });
}

function pickSuggestedTemplate(all, readiness, mode = 'neutral', profile = null) {
  const statusByGroup = Object.fromEntries(readiness.map((r) => [r.muscleGroup, r.status]));
  const weights = MODE_GROUP_WEIGHTS[mode] ?? {};
  if (all.length === 0) return null;
  const fitting = all.filter((t) => equipmentFit(t, profile)?.fits !== false);
  const templates = fitting.length ? fitting : all;

  let best = null;
  let bestScore = -1;
  for (const template of templates) {
    const groups = template.exercises.map((te) => te.exercise.muscleGroup);
    const score = groups.reduce((sum, g) => {
      if (statusByGroup[g] === 'limited') return sum;
      if (statusByGroup[g] !== 'ready') return sum;
      return sum + (weights[g] ?? 1);
    }, 0) / (groups.length || 1);
    if (score > bestScore) {
      bestScore = score;
      best = template;
    }
  }
  return best ? { id: best.id, name: best.name, exerciseCount: best.exercises.length } : null;
}
