import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

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
  const sessions = await prisma.workoutSession.findMany({
    where: { userId, startedAt: { gte: since }, endedAt: { not: null } },
    include: { exercises: { include: { exercise: true, sets: { where: { completed: true } } } } },
  });

  let totalVolumeKg = 0;
  let totalDurationSeconds = 0;
  const volumeByWeek = {};
  const volumeByMuscleGroup = {};

  for (const session of sessions) {
    const weekStart = new Date(session.startedAt);
    weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
    const weekKey = weekStart.toISOString().slice(0, 10);
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

  const personalRecords = await getPersonalRecordsService(userId);

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
  const sets = await prisma.workoutSet.findMany({
    where: {
      completed: true,
      weightKg: { not: null },
      reps: { not: null },
      sessionExercise: { session: { userId } },
    },
    include: { sessionExercise: { include: { exercise: true } } },
  });
  const bestByExercise = new Map();
  for (const s of sets) {
    const name = s.sessionExercise.exercise.name;
    const weight = Number(s.weightKg);
    const existing = bestByExercise.get(name);
    if (!existing || weight * s.reps > existing.weightKg * existing.reps) {
      bestByExercise.set(name, { exerciseName: name, weightKg: weight, reps: s.reps });
    }
  }
  return [...bestByExercise.values()]
    .sort((a, b) => b.weightKg * b.reps - a.weightKg * a.reps)
    .slice(0, limit);
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

export async function getMuscleReadinessService(userId) {
  const [recentSessionExercises, profile] = await Promise.all([
    prisma.sessionExercise.findMany({
      where: { session: { userId, endedAt: { not: null } } },
      include: { exercise: { select: { muscleGroup: true } }, session: { select: { startedAt: true } } },
    }),
    prisma.personalisationProfile.findUnique({ where: { userId } }),
  ]);

  const mode = profile?.programmingMode ?? 'neutral';
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
  for (const se of recentSessionExercises) {
    const group = se.exercise.muscleGroup;
    const trainedAt = se.session.startedAt;
    if (!lastTrainedAt[group] || trainedAt > lastTrainedAt[group]) {
      lastTrainedAt[group] = trainedAt;
    }
  }

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

  const suggestedTemplate = await pickSuggestedTemplate(userId, readiness, mode);
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
async function pickSuggestedTemplate(userId, readiness, mode = 'neutral') {
  const statusByGroup = Object.fromEntries(readiness.map((r) => [r.muscleGroup, r.status]));
  const weights = MODE_GROUP_WEIGHTS[mode] ?? {};
  const templates = await prisma.workoutTemplate.findMany({
    where: { userId },
    include: { exercises: { include: { exercise: { select: { muscleGroup: true } } } } },
  });
  if (templates.length === 0) return null;

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
