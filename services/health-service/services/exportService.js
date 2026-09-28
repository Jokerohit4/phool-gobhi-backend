import { PrismaClient } from '@prisma/client';
import { hasMedicalRecordsConsentService } from './ledger/ledgerConsentService.js';
const prisma = new PrismaClient();

// FR-16. One builder feeds both the JSON and CSV shapes — the BRD's "Robin
// Hood rule" (Tech §8.3) is that an export and the on-screen numbers for the
// same range must never disagree, which only holds if there's a single
// implementation of "what happened in this range".
export async function buildRangeSeriesService(userId, { from, to } = {}) {
  const dateFilter = from || to
    ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) }
    : undefined;

  const [sessions, biometrics] = await Promise.all([
    prisma.workoutSession.findMany({
      where: {
        userId,
        endedAt: { not: null },
        ...(dateFilter ? { localDate: dateFilter } : {}),
      },
      include: {
        exercises: {
          include: { exercise: { select: { name: true, muscleGroup: true } }, sets: true },
          orderBy: { order: 'asc' },
        },
      },
      orderBy: { startedAt: 'asc' },
    }),
    prisma.biometricEntry.findMany({
      where: { userId, ...(dateFilter ? { localDate: dateFilter } : {}) },
      orderBy: [{ localDate: 'asc' }, { metric: 'asc' }],
    }),
  ]);

  return {
    sessions: sessions.map((s) => {
      let volumeKg = 0;
      let completedSets = 0;
      for (const se of s.exercises) {
        for (const set of se.sets) {
          if (!set.completed) continue;
          completedSets += 1;
          if (set.weightKg && set.reps) volumeKg += Number(set.weightKg) * set.reps;
        }
      }
      return {
        sessionId: s.id,
        localDate: s.localDate,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationMinutes: s.endedAt
          ? Math.round((s.endedAt.getTime() - s.startedAt.getTime()) / 60000)
          : null,
        type: s.type,
        rpe: s.rpe,
        gymId: s.gymId,
        bookingId: s.bookingId,
        exerciseCount: s.exercises.length,
        completedSets,
        volumeKg: Math.round(volumeKg),
      };
    }),
    // Long-format (one row per metric per day) rather than a wide
    // weight/bodyFat pair — it stays correct as Health+ Phase 1 adds sleep,
    // resting HR, HRV and steps without the CSV growing a column per metric
    // and old exports changing shape.
    biometrics: biometrics.map((b) => ({
      localDate: b.localDate,
      metric: b.metric,
      value: Number(b.value),
      unit: b.unit,
      source: b.source,
    })),
  };
}

// Minimal, dependency-free CSV writer. Quotes only when a value actually
// needs it and doubles embedded quotes, so an exercise name with a comma
// can't shift every following column.
function toCsv(rows, columns) {
  const escape = (value) => {
    if (value === null || value === undefined) return '';
    const s = String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((col) => escape(row[col])).join(','));
  }
  return lines.join('\n');
}

const SESSION_COLUMNS = [
  'sessionId', 'localDate', 'startedAt', 'endedAt', 'durationMinutes',
  'type', 'rpe', 'gymId', 'bookingId', 'exerciseCount', 'completedSets', 'volumeKg',
];
const BIOMETRIC_COLUMNS = ['localDate', 'metric', 'value', 'unit', 'source'];

// Two logical tables in one file, separated by a blank line and a header —
// a single flat CSV would either duplicate session rows per biometric or
// drop one of the two entirely. Sheets/Excel both handle this fine.
export function seriesToCsv({ sessions, biometrics }) {
  return [
    '# sessions',
    toCsv(sessions, SESSION_COLUMNS),
    '',
    '# biometrics',
    toCsv(biometrics, BIOMETRIC_COLUMNS),
    '',
  ].join('\n');
}

// The full DPDPA access-right slice for this service, called by
// auth-service's platform-wide export. Distinct from buildRangeSeriesService
// above, which is FR-16's user-facing training export: that one is a
// date-ranged view built for reading and charting, this one is "everything
// health-service holds about you", with no range and nothing summarised away.
//
// The list below deliberately mirrors consentService.deleteAllDataService
// one-for-one. If a table is added to the erasure and not to this, we would
// be deleting on request something we never showed on request - so keep the
// two in step.
export async function buildFullExportService(userId) {
  const [consent, personalisation, weeklyGoal, activePlan, templates, customExercises, records, activity, biometrics, feedback, assistantConsent, assistantConversations, assistantMemories, cycleProfile, cyclePhases, healthGoal, nutritionTarget, customFoods, foodLogs, savedMeals, planItems, planCompletions, snapshots, conditions, appointments, photoLogs, medicalDocuments] =
    await Promise.all([
      prisma.healthConsent.findUnique({ where: { userId } }),
      prisma.personalisationProfile.findUnique({ where: { userId } }),
      prisma.weeklyGoal.findUnique({ where: { userId } }),
      prisma.userActivePlan.findUnique({ where: { userId }, include: { plan: { select: { key: true, name: true } } } }),
      prisma.workoutTemplate.findMany({
        where: { userId },
        include: { exercises: { include: { exercise: { select: { name: true } } }, orderBy: { order: 'asc' } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.exercise.findMany({ where: { createdByUserId: userId }, orderBy: { createdAt: 'asc' } }),
      // include: runTrack — a GPS run's route/splits are personal data
      // (run-tracker-spec.html §12) and must travel with the export the
      // same as everything else here, not be a silent gap between what's
      // shown on /export and what a deleted run actually removed.
      prisma.exerciseRecord.findMany({ where: { userId }, include: { runTrack: true }, orderBy: { startedAt: 'asc' } }),
      prisma.dailyActivityMetric.findMany({ where: { userId }, orderBy: { date: 'asc' } }),
      prisma.biometricEntry.findMany({ where: { userId }, orderBy: [{ localDate: 'asc' }, { metric: 'asc' }] }),
      prisma.suggestionFeedback.findMany({ where: { userId }, orderBy: { shownAt: 'asc' } }),
      // The comment above this function is explicit that export and erasure
      // must stay in step — we must not delete on request something we never
      // showed on request. The assistant transcript is the clearest case of
      // that: it is the most sensitive thing here and the thing a person is
      // most likely to actually want a copy of.
      prisma.assistantConsent.findUnique({ where: { userId } }),
      prisma.assistantConversation.findMany({
        where: { userId },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.assistantMemory.findMany({ where: { userId }, orderBy: { updatedAt: 'asc' } }),
      prisma.cycleTrackingProfile.findUnique({ where: { userId } }),
      prisma.cyclePhaseEntry.findMany({ where: { userId }, orderBy: { startDate: 'asc' } }),

      // ---- Health ledger -------------------------------------------------
      // Everything here is per-user health data, so all of it belongs in a
      // data-portability export. The list mirrors deleteAllDataService, for the
      // reason in the comment above this function: we must not delete on
      // request something we never showed on request.
      prisma.healthGoal.findUnique({ where: { userId } }),
      prisma.nutritionTarget.findUnique({ where: { userId } }),
      // The user's own custom foods only. The seeded catalogue is ours, not
      // theirs, and is not their data to take a copy of.
      prisma.foodItem.findMany({ where: { createdByUserId: userId }, orderBy: { name: 'asc' } }),
      prisma.foodLog.findMany({ where: { userId }, orderBy: [{ localDate: 'asc' }, { slot: 'asc' }] }),
      prisma.savedMeal.findMany({
        where: { userId },
        include: { lines: { orderBy: { order: 'asc' } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.planItem.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }] }),
      prisma.planItemCompletion.findMany({ where: { userId }, orderBy: [{ localDate: 'asc' }] }),
      prisma.scoreDaySnapshot.findMany({ where: { userId }, orderBy: { localDate: 'asc' } }),
      prisma.healthCondition.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      prisma.doctorAppointment.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      prisma.foodPhotoRequestLog.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),

      // Medical documents are the one slice NOT unconditionally exported: they
      // sit behind a second, independent consent scope, and including them in a
      // nutrition-consented export would hand out prescriptions to someone who
      // never granted medical-records consent. See the medicalRecords block.
      //
      // Still fetched unconditionally, so the count can be reported. The rows
      // are dropped from the output below when consent is absent - they are
      // never written anywhere, and a fetch is not a disclosure.
      prisma.medicalDocument.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    ]);

  // Reuses the range builder with no range, so the session shape in a
  // platform export and in the user's own FR-16 download can never drift
  // apart - the Robin Hood rule applied across two endpoints instead of two
  // formats.
  const { sessions } = await buildRangeSeriesService(userId);

  // Read once. Two calls would be two chances for the answer to differ, and a
  // consent check that flips mid-function could put document titles in an
  // export that the surrounding branch said it was withholding.
  const hasMedicalConsent = await hasMedicalRecordsConsentService(userId);

  return {
    // ---- Health ledger -------------------------------------------------
    ledger: {
      // The goal, its constraints, and the targets derived from them. Decimals
      // are converted to numbers because Prisma hands them back as strings and
      // an export full of "1820" instead of 1820 is a file the recipient has to
      // clean up before reading.
      goal: healthGoal
        ? {
            goal: healthGoal.goal,
            sex: healthGoal.sex,
            age: healthGoal.age,
            heightCm: healthGoal.heightCm,
            startDate: healthGoal.startDate,
            targetWeightKg: healthGoal.targetWeightKg === null ? null : Number(healthGoal.targetWeightKg),
            targetDate: healthGoal.targetDate,
            activity: healthGoal.activity,
            diet: healthGoal.diet,
            allergies: healthGoal.allergies,
            // Whether the activity level is something we measured or something
            // the user told us. It changes the calorie target, so a person
            // disputing the target needs to see it.
            activityIsMeasured: healthGoal.activityIsMeasured,
            calmMode: healthGoal.calmMode,
          }
        : null,
      targets: nutritionTarget
        ? {
            kcal: Number(nutritionTarget.kcal),
            proteinG: Number(nutritionTarget.proteinG),
            carbsG: Number(nutritionTarget.carbsG),
            fatG: Number(nutritionTarget.fatG),
            fibreG: Number(nutritionTarget.fibreG),
            waterMl: Number(nutritionTarget.waterMl),
            // `source` distinguishes a formula target from one the user typed.
            // Without it, "1820 kcal" looks like a recommendation rather than a
            // number this app computed.
            source: nutritionTarget.source,
            rulesVersion: nutritionTarget.rulesVersion,
            // The input snapshot the target was computed from. Exported because
            // it is the only way to tell whether a target is still right: a
            // number derived from a 70 kg weight and one derived from 78 kg are
            // the same kcal but a different claim, and the user is the only
            // party who can see that the input changed.
            inputs: nutritionTarget.inputs,
            updatedAt: nutritionTarget.updatedAt,
          }
        : null,
      // The numbers as they were eaten, including the snapshot. The snapshot is
      // the record of what this app told them at the time; re-deriving it from
      // the food catalogue today would show different values and quietly
      // misrepresent their own history.
      foodLogs: foodLogs.map((f) => ({
        localDate: f.localDate,
        slot: f.slot,
        name: f.name,
        nonVeg: f.nonVeg,
        grams: f.grams === null ? null : Number(f.grams),
        servings: f.servings === null ? null : Number(f.servings),
        servingLabel: f.servingLabel,
        nutrients: f.nutrients,
        source: f.source,
        photoCorrections: f.photoCorrections,
        loggedAt: f.createdAt,
      })),
      // A count only, never names or labels. The catalogue is platform data;
      // the user needs to know their own foods travelled with them, not a copy
      // of our table.
      customFoods: customFoods.map((f) => ({ name: f.name, basis: f.basis })),
      savedMeals: savedMeals.map((m) => ({
        name: m.name,
        slot: m.slot,
        createdAt: m.createdAt,
        lines: m.lines.map((l) => ({
          name: l.name, nonVeg: l.nonVeg, grams: Number(l.grams), servingLabel: l.servingLabel, nutrients: l.nutrients,
        })),
      })),
      // `origin` and `prescribedBy` are exported deliberately. A plan is built
      // partly out of things a doctor told the user, and a copy of that plan
      // that dropped the doctor's name would be misleading - especially for
      // someone taking it to another doctor.
      planItems: planItems.map((p) => ({
        title: p.title,
        kind: p.kind,
        schedule: p.schedule,
        endsOn: p.endsOn,
        origin: p.origin,
        prescribedBy: p.prescribedBy,
        prescribedNote: p.prescribedNote,
        active: p.active,
        createdAt: p.createdAt,
      })),
      planCompletions: planCompletions.map((c) => ({
        planItemId: c.planItemId,
        localDate: c.localDate,
        how: c.how,
        points: c.points,
        completedAt: c.createdAt,
      })),
      // The frozen daily scores, with the rules version each was computed
      // under. Without rulesVersion a score is unexplainable later, when the
      // scoring rules have changed.
      scoreSnapshots: snapshots.map((s) => ({
        localDate: s.localDate,
        open: s.open,
        high: s.high,
        low: s.low,
        close: s.close,
        breakdown: s.breakdown,
        rulesVersion: s.rulesVersion,
        closedAt: s.closedAt,
      })),
      // `source` rides along so a condition the user typed is never confused
      // with one the app inferred, and so a future reader can tell which
      // statements here are self-reported.
      conditions: conditions.map((c) => ({
        label: c.label, source: c.source, createdAt: c.createdAt,
      })),
      appointments: appointments.map((a) => ({
        doctorName: a.doctorName,
        speciality: a.speciality,
        localDate: a.localDate,
        localTime: a.localTime,
        followUpDate: a.followUpDate,
        notes: a.notes,
        createdAt: a.createdAt,
      })),
      // Per-user photo upload attempts. The row records that a request was made
      // and nothing else - no image is retained, which is the whole reason this
      // table is so thin and is worth showing in an export so the absence is
      // explicable rather than looking like a gap.
      photoRequests: photoLogs.map((p) => ({ requestedAt: p.requestedAt })),
    },
    // Medical documents, behind their own consent.
    //
    // These are the most sensitive rows this service holds, and they are the
    // one place where an export is allowed to be incomplete: the nutrition
    // scope and the medical-records scope are separate consents, and a person
    // who granted only the first has not asked for their prescriptions to be
    // handed to them in a download. The export says what it left out and why,
    // rather than quietly omitting the section - a silent gap here reads as
    // "we hold nothing else" and is the opposite of the truth.
    medicalRecords: {
      consentGranted: hasMedicalConsent,
      // When consent is absent we say how many documents are being withheld, not
      // nothing. A silently-missing section reads as "we hold no medical
      // records", and someone asking for a copy of their data needs to be able
      // to tell the difference between "there are none" and "you did not ask".
      documentsWithheld: hasMedicalConsent ? 0 : medicalDocuments.length,
      documents: hasMedicalConsent
        ? medicalDocuments.map((d) => ({
            title: d.title,
            kind: d.kind,
            docDate: d.docDate,
            mimeType: d.mimeType,
            sizeBytes: d.sizeBytes,
            notes: d.notes,
            uploadedAt: d.createdAt,
            // storagePath is a capability, not data, and signed links expire in
            // minutes - so the export names the document and says where to get
            // it rather than embedding a path that will not resolve later.
            retrieveVia: 'GET /api/health/ledger/medical-documents',
          }))
        : [],
      note: hasMedicalConsent
        ? 'storage paths and download links are never included in an export; fetch each document through the medical-documents endpoint while your consent is in force'
        : 'medical documents are withheld: medical-records consent is not currently granted. Grant it and export again to include them, or request deletion instead.',
    },
    // Cycle tracking. Included for the same reason as everything else here:
    // we must not delete on request what we never showed on request, and this
    // is the data a person is most entitled to a copy of.
    cycleTracking: cycleProfile
      ? {
          consentAt: cycleProfile.consentAt,
          averageCycleLengthDays: cycleProfile.averageCycleLengthDays,
          averagePeriodLengthDays: cycleProfile.averagePeriodLengthDays,
          lastPeriodStartDate: cycleProfile.lastPeriodStartDate,
          // `source` rides along so a prediction is never mistaken in the
          // export for something she reported.
          phases: cyclePhases.map((e) => ({
            startDate: e.startDate,
            endDate: e.endDate,
            phase: e.phase,
            source: e.source,
          })),
        }
      : null,
    assistant: {
      consent: assistantConsent
        ? {
            grantedAt: assistantConsent.grantedAt,
            revokedAt: assistantConsent.revokedAt,
            policyVersion: assistantConsent.policyVersion,
          }
        : null,
      // Full transcripts, both sides. policyVersion/promptVersion ride along
      // so the export shows not just what was said but under which posture —
      // which is the point of recording them per message.
      conversations: assistantConversations.map((c) => ({
        startedAt: c.createdAt,
        title: c.title,
        messages: c.messages.map((m) => ({
          at: m.createdAt,
          role: m.role,
          content: m.content,
          policyVersion: m.policyVersion,
          promptVersion: m.promptVersion,
        })),
      })),
      remembered: assistantMemories.map((m) => ({
        key: m.key,
        value: m.value,
        source: m.source,
        updatedAt: m.updatedAt,
      })),
    },
    consent: consent
      ? { grantedAt: consent.grantedAt, revokedAt: consent.revokedAt, policyVersion: consent.policyVersion, platform: consent.platform }
      : null,
    personalisation: personalisation
      ? {
          heightCm: personalisation.heightCm,
          setupWeightKg: personalisation.setupWeightKg === null ? null : Number(personalisation.setupWeightKg),
          experienceLevel: personalisation.experienceLevel,
          injuryZones: personalisation.injuryZones,
          energyPattern: personalisation.energyPattern,
          preferredRestDay: personalisation.preferredRestDay,
          programmingMode: personalisation.programmingMode,
          // Records THAT consent was given and under which policy version.
          // There is deliberately nothing here about what was disclosed to
          // arrive at the mode, because that was never transmitted.
          consentAt: personalisation.consentAt,
          privacyVersion: personalisation.privacyVersion,
        }
      : null,
    // The user's weekly training target, and whether they chose it or it was
    // derived from their onboarding answer. Exported for the same reason it
    // is erased: it's their preference, not our configuration.
    weeklyGoal: weeklyGoal
      ? { sessionsPerWeek: weeklyGoal.sessionsPerWeek, setByUser: weeklyGoal.setByUser, updatedAt: weeklyGoal.updatedAt }
      : null,
    // Which multi-week plan the user has active, and since when — not the
    // day-by-day derived position (that's a live computation, not a stored
    // fact about them; getActivePlanService is the source for "what day is
    // it", this is only the source for "which plan, since when").
    activePlan: activePlan
      ? { planKey: activePlan.plan.key, planName: activePlan.plan.name, startedOn: activePlan.startedOn, completedAt: activePlan.completedAt }
      : null,
    sessions,
    routines: templates.map((t) => ({
      name: t.name,
      createdAt: t.createdAt,
      exercises: t.exercises.map((te) => ({
        name: te.exercise?.name ?? null, targetSets: te.targetSets, targetReps: te.targetReps, targetDurationSeconds: te.targetDurationSeconds, restSeconds: te.restSeconds,
      })),
    })),
    customExercises: customExercises.map((e) => ({
      name: e.name, muscleGroup: e.muscleGroup, equipment: e.equipment, loggingType: e.loggingType, createdAt: e.createdAt,
    })),
    cardioAndOther: records.map((r) => ({
      type: r.type, source: r.source, startedAt: r.startedAt, endedAt: r.endedAt,
      durationSeconds: r.durationSeconds, caloriesBurned: r.caloriesBurned,
      distanceMeters: r.distanceMeters === null ? null : Number(r.distanceMeters),
      avgHeartRateBpm: r.avgHeartRateBpm,
    })),
    dailyActivity: activity.map((a) => ({
      date: a.date, steps: a.steps, activeCalories: a.activeCalories,
      distanceMeters: a.distanceMeters === null ? null : Number(a.distanceMeters),
      restingHeartRateBpm: a.restingHeartRateBpm, source: a.source, syncedAt: a.syncedAt,
    })),
    biometrics: biometrics.map((b) => ({
      localDate: b.localDate, metric: b.metric, value: Number(b.value), unit: b.unit, source: b.source,
    })),
    // Included because it is per-user behavioural data we hold, even though
    // it exists only to be aggregated away - see retentionService bucket 1.
    // It is the one slice here that expires on a clock rather than with the
    // account, so the export says so rather than leaving that surprising.
    suggestionFeedback: feedback.map((f) => ({ shownAt: f.shownAt, suggestionKey: f.suggestionKey })),
    retentionNote:
      'suggestionFeedback is purpose-limited telemetry and is deleted automatically once it ages past the configured retention window; everything else here is kept for as long as your account exists',
  };
}
