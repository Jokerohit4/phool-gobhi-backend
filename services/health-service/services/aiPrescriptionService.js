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
      await ledgerPlanService.addUserEnteredItem(prisma, {
        userId,
        title: item.title,
        kind: item.kind || 'custom',
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
