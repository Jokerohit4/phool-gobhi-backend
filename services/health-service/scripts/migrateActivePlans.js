#!/usr/bin/env node
// Migrate active UserActivePlan rows into Prescription.workoutSlots and WeeklyGoal.sessionsPerWeek.
// B12: coach journey plan migration.
//
// WHY THIS EXISTS
//
// Before the coach journey, active workout programs lived in UserActivePlan (a user's
// assigned multi-week WorkoutPlan with per-day WorkoutPlanDay rows). The journey's
// plan engine uses Prescription.workoutSlots instead - one slot per weekly session,
// spread across the week with a template, title and level.
//
// This script reads each active UserActivePlan, builds the weekly slot pattern from
// its days, and writes it to Prescription.workoutSlots. WeeklyGoal.sessionsPerWeek
// is also set to the slot count so the Home ring and Plan tab agree.
//
// SAFE BY DESIGN
//
// --dry-run reports without writing. The operation is idempotent: users who already
// have Prescription.workoutSlots are skipped entirely. Re-running produces the same
// state. UserActivePlan rows are NEVER deleted.

import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';

dotenv.config();

const SLOT_WEEKDAY_PATTERN = [0, 2, 3, 5, 1, 4, 6]; // Monday=0 .. Sunday=6

/**
 * Build workout slots from a WorkoutPlan's days for week 1.
 * Returns an array of slot objects matching Prescription.workoutSlots shape.
 *
 * @param {Array<{dayIndex: number, templateId: number|null, template: {id: number, name: string, level: string|null}}>} planDays
 * @returns {Array<{weekday: number, templateId: number|null, title: string, level: string}>}
 */
export function buildSlotsFromPlanDays(planDays) {
  // Filter to week 1 (weekIndex === 1) and days that have a template
  const week1Days = planDays
    .filter((d) => d.weekIndex === 1 && d.templateId != null)
    .sort((a, b) => a.dayIndex - b.dayIndex);

  const slots = [];
  for (let i = 0; i < week1Days.length; i++) {
    const day = week1Days[i];
    const template = day.template;
    slots.push({
      weekday: SLOT_WEEKDAY_PATTERN[i % SLOT_WEEKDAY_PATTERN.length],
      templateId: template.id,
      title: template.name,
      level: template.level ?? 'beginner',
    });
  }
  return slots;
}

/**
 * Migrate all active UserActivePlan rows to Prescription.workoutSlots.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{scanned: number, migrated: number, skipped: number, errors: Array<{userId: number, error: string}>}>}
 */
export async function migrateActivePlans(prisma, { dryRun = false } = {}) {
  // Fetch all active UserActivePlan rows with their plan and week 1 days
  const activePlans = await prisma.userActivePlan.findMany({
    where: { completedAt: null },
    include: {
      plan: {
        include: {
          days: {
            where: { weekIndex: 1 },
            include: { template: true },
          },
        },
      },
    },
  });

  let scanned = 0;
  let migrated = 0;
  let skipped = 0;
  const errors = [];

  for (const uap of activePlans) {
    scanned += 1;
    const userId = uap.userId;

    try {
      // Check if user already has workoutSlots
      const existingPrescription = await prisma.prescription.findUnique({
        where: { userId },
        select: { workoutSlots: true },
      });

      if (existingPrescription?.workoutSlots?.length > 0) {
        skipped += 1;
        continue;
      }

      // Build slots from the plan's week 1 days
      const planDays = uap.plan?.days ?? [];
      const slots = buildSlotsFromPlanDays(planDays);

      if (slots.length === 0) {
        // No template days in week 1 - skip with a note
        errors.push({ userId, error: 'Plan has no template days in week 1' });
        skipped += 1;
        continue;
      }

      if (!dryRun) {
        // Update Prescription.workoutSlots (upsert to handle users without a prescription yet)
        await prisma.prescription.upsert({
          where: { userId },
          create: {
            userId,
            workoutSlots: slots,
            // Preserve other fields with defaults if creating new
            stepsPerDay: 8000,
            sleepMinutes: 420,
            kcal: null,
            rulesVersion: 'v1',
          },
          update: {
            workoutSlots: slots,
          },
        });

        // Set WeeklyGoal.sessionsPerWeek to slot count
        await prisma.weeklyGoal.upsert({
          where: { userId },
          create: {
            userId,
            sessionsPerWeek: slots.length,
            setByUser: true,
          },
          update: {
            sessionsPerWeek: slots.length,
            setByUser: true,
          },
        });
      }

      migrated += 1;
    } catch (err) {
      errors.push({ userId, error: String(err) });
    }
  }

  return { scanned, migrated, skipped, errors };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (!process.env.DATABASE_URL) {
    console.error('migrateActivePlans: DATABASE_URL is not set - load the service .env, or export it. Refusing to guess a database.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const { scanned, migrated, skipped, errors } = await migrateActivePlans(prisma, { dryRun });

    console.log(
      `${dryRun ? '[dry-run] ' : ''}scanned ${scanned} active plan(s); ` +
      `${dryRun ? 'would migrate' : 'migrated'} ${migrated}; skipped ${skipped}.`
    );

    if (errors.length > 0) {
      console.log('\nDetails:');
      for (const e of errors) {
        console.log(`  userId=${e.userId}: ${e.error}`);
      }
    }

    if (dryRun) {
      console.log('\nDry run. Nothing was written. Re-run without --dry-run to apply.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked as a command, so importing migrateActivePlans in a test
// does not connect to whatever DATABASE_URL happens to be in the environment.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`migrateActivePlans: ${err?.stack || String(err)}`);
    process.exit(1);
  });
}