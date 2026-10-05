import { PrismaClient } from '@prisma/client';
import * as ledgerPlanService from './ledger/ledgerPlanService.js';

const prisma = new PrismaClient();

/**
 * Processes a structured prescription from the AI Assistant.
 * 
 * The AI is prompted to return a JSON structure:
 * {
 *   "planItems": [
 *     { "title": "Drink 3L water", "kind": "nutrition", "schedule": "daily" },
 *     { "title": "15min Morning Yoga", "kind": "workout", "schedule": "mon,wed,fri" }
 *   ],
 *   "suggestedTemplates": [
 *     { "name": "AI Recovery Flow", "exercises": [...] }
 *   ]
 * }
 */
export async function injectAiPrescription(userId, prescription) {
  const { planItems = [], suggestedTemplates = [] } = prescription;
  const results = {
    planItemsCreated: 0,
    templatesCreated: 0,
    errors: [],
  };

  // 1. Inject Plan Items
  for (const item of planItems) {
    try {
      const kind = normaliseAiKind(item.kind);
      await ledgerPlanService.addUserEnteredItem(prisma, {
        userId,
        title: item.title,
        kind,
        schedule: item.schedule || 'daily',
        // We set origin: 'user' via addUserEnteredItem because these are 
        // AI-suggested and then USER-accepted.
      });
      results.planItemsCreated++;
    } catch (err) {
      results.errors.push(`PlanItem [${item.title}]: ${err.message}`);
    }
  }

  // 2. Inject Workout Templates (Smart Templates)
  for (const template of suggestedTemplates) {
    try {
      await prisma.workoutTemplate.create({
        data: {
          userId,
          name: template.name,
          category: template.category || 'AI Suggested',
          exercises: {
            create: template.exercises.map(ex => ({
              exerciseId: ex.exerciseId,
              targetSets: ex.targetSets,
              targetReps: ex.targetReps,
              targetWeight: ex.targetWeight,
              restSeconds: ex.restSeconds,
            })),
          },
        },
      });
      results.templatesCreated++;
    } catch (err) {
      results.errors.push(`Template [${template.name}]: ${err.message}`);
    }
  }

  return results;
}

/**
 * The kind an AI-suggested item is actually written as.
 *
 * Two things are being handled here, and the second is the one that matters.
 *
 * The first is the missing kind. This used to default to 'custom', which is not
 * a member of the health.PlanItemKind enum at all — so an AI plan item with no
 * kind passed the service's allow-list and then died inside Prisma with a
 * validation error, surfacing to the user as a 500 on a feature they had just
 * tapped "accept" on. 'habit' is the fallback because it is the same default
 * the client's own "Add to your plan" dialog starts on.
 *
 * The second is a doctor kind, and it is refused rather than normalised.
 *
 * Now that ledgerPlanService's allow-list is the database enum, a
 * `doctor_medication` or `doctor_appointment` coming back from the model is a
 * kind this function COULD write. It must not, and the reason is the boundary
 * the whole ledger rests on: origin: 'doctor' is writable only from the user's
 * own typed text (see ledgerPlanService.js). An assistant-authored "take this
 * every morning" is us writing the doctor's line, whether or not
 * `fromPrescription` happens to be false — the row would still score +10 a day
 * for a medicine we invented, which is both the CDSCO problem the boundary
 * exists to prevent and a scoring bug on top of it.
 *
 * So a doctor kind from the model is an error the user sees, not a row that gets
 * quietly downgraded to 'habit'. Silently downgrading would hide the only thing
 * worth telling them: the assistant tried to write a prescription and was
 * stopped. The honest fix is to add it by hand, which is the one path allowed
 * to do it.
 *
 * Exported so the guard is testable without a database — see
 * test/aiPrescriptionKinds.test.js.
 */
export function normaliseAiKind(raw) {
  // Lowercased and trimmed before anything else. The enum is lowercase, so
  // "Doctor_Medication" would be refused by the allow-list anyway — but it would
  // be refused as a nonsense kind, which tells the user nothing about the real
  // problem. Normalising first means every spelling of a doctor kind gets the one
  // message that explains what happened.
  const kind = String(raw || '').trim().toLowerCase() || 'habit';
  if (kind.startsWith('doctor_')) {
    throw new Error(
      'the assistant cannot add a doctor item — add it yourself and it will be marked as from your doctor',
    );
  }
  if (kind === 'custom') return 'habit';
  return kind;
}
