#!/usr/bin/env node
// Migrate existing plan items onto the one plan's layer keys (UB5).
//
// WHY THIS EXISTS
//
// The one plan gives every plan item a layerKey: user-created rows go to the
// 'own' layer, doctor rows to 'medicine', and the generator (rebuildPlan)
// owns every 'suggested' row from here on. Plan items created before the
// journey existed have layerKey null, which the Today card and the score
// can't place. Auto-satisfied completions (how='auto') also have to go: the
// one plan scores only what the user taps.
//
// This runs for every user with coach 'basic' consent AND a JourneyProgress
// row — the population actually on the new journey. Everyone else is
// reported and left alone.
//
// WHAT IT DOES (per eligible user)
//
//   a. layerKey='own' on origin:'user' rows where layerKey is null,
//      layerKey='medicine' on origin:'doctor' rows where layerKey is null.
//   b. deactivate origin:'suggested' rows that are still active and have a
//      null layerKey or kind 'nutrition' — the generator re-creates anything
//      it should own, with a layerKey and a sourceRef.
//   c. delete PlanItemCompletion rows with how='auto' (the one plan scores
//      only manual ticks).
//   d. rebuildPlan(prisma, userId, {reason:'migrate'}) to regenerate the
//      suggested rows on-layer. Until UA1's rebuildPlan lands this step
//      reports a per-user error and the rest of that user's migration still
//      stands.
//
// SAFE BY DESIGN
//
//   - Dry run by default: it prints what it would do and writes nothing.
//     Writing needs --apply AND --target-host=<the DATABASE_URL host>, so a
//     wrong DATABASE_URL cannot be written to by accident (same pattern as
//     copyApprovedContent.js).
//   - Idempotent: every write only touches rows still in the pre-migration
//     state, so re-running is a no-op.
//   - Per-user errors are recorded and never abort the run.

import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { rebuildPlan } from '../services/plan/rebuildPlan.js';

dotenv.config();

export function parseArgs(argv) {
  const opts = { apply: false, targetHost: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=');
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--apply') opts.apply = true;
    else if (flag === '--target-host') opts.targetHost = String(value());
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return opts;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    throw new Error('Database URL is not a valid URL');
  }
}

export function checkTarget({ databaseUrl, opts }) {
  if (!databaseUrl) throw new Error('Set DATABASE_URL.');
  const host = hostOf(databaseUrl);
  if (opts.apply && opts.targetHost !== host) {
    throw new Error(`--apply needs --target-host=${host} (the host you are about to write to).`);
  }
  return host;
}

export async function migrateToOnePlan(prisma, { apply = false, rebuild = rebuildPlan } = {}) {
  const report = {
    scanned: 0,
    withoutConsent: 0,
    consentNoJourney: 0,
    users: [],
    errors: [],
  };

  const consents = await prisma.coachConsent.findMany({
    where: { revokedAt: null, scopes: { has: 'basic' } },
    select: { userId: true },
  });
  const consented = new Set(consents.map((c) => c.userId));

  const journeys = await prisma.journeyProgress.findMany({ select: { userId: true } });
  const journeyIds = new Set(journeys.map((j) => j.userId));

  report.withoutConsent = [...journeyIds].filter((id) => !consented.has(id)).length;
  report.consentNoJourney = [...consented].filter((id) => !journeyIds.has(id)).length;

  const candidates = [...consented].filter((id) => journeyIds.has(id)).sort((a, b) => a - b);

  for (const userId of candidates) {
    report.scanned += 1;
    const counts = {
      userId,
      ownAssigned: 0,
      medicineAssigned: 0,
      deactivated: 0,
      autoDeleted: 0,
      rebuilt: false,
    };

    try {
      const ownWhere = { userId, origin: 'user', layerKey: null };
      const medicineWhere = { userId, origin: 'doctor', layerKey: null };
      const deactivateWhere = {
        userId,
        origin: 'suggested',
        active: true,
        OR: [{ layerKey: null }, { kind: 'nutrition' }],
      };
      const autoWhere = { userId, how: 'auto' };

      if (apply) {
        counts.ownAssigned = (await prisma.planItem.updateMany({ where: ownWhere, data: { layerKey: 'own' } })).count;
        counts.medicineAssigned = (
          await prisma.planItem.updateMany({ where: medicineWhere, data: { layerKey: 'medicine' } })
        ).count;
        counts.deactivated = (
          await prisma.planItem.updateMany({ where: deactivateWhere, data: { active: false } })
        ).count;
        counts.autoDeleted = (await prisma.planItemCompletion.deleteMany({ where: autoWhere })).count;
      } else {
        counts.ownAssigned = await prisma.planItem.count({ where: ownWhere });
        counts.medicineAssigned = await prisma.planItem.count({ where: medicineWhere });
        counts.deactivated = await prisma.planItem.count({ where: deactivateWhere });
        counts.autoDeleted = await prisma.planItemCompletion.count({ where: autoWhere });
      }

      if (apply) {
        try {
          await rebuild(prisma, userId, { reason: 'migrate' });
          counts.rebuilt = true;
        } catch (err) {
          report.errors.push({ userId, error: `rebuildPlan: ${err?.message || String(err)}` });
        }
      }

      report.users.push(counts);
    } catch (err) {
      report.errors.push({ userId, error: err?.message || String(err) });
    }
  }

  return report;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  const host = checkTarget({ databaseUrl, opts });
  console.log(`Migrate plan items to the one plan on ${host}`);
  console.log(
    opts.apply
      ? 'APPLYING: writes will be made.'
      : 'Dry run: nothing will be written. Add --apply --target-host=<host> to write.',
  );

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const r = await migrateToOnePlan(prisma, { apply: opts.apply });
    const verb = opts.apply ? '' : 'would be ';
    const totals = r.users.reduce(
      (t, u) => ({
        ownAssigned: t.ownAssigned + u.ownAssigned,
        medicineAssigned: t.medicineAssigned + u.medicineAssigned,
        deactivated: t.deactivated + u.deactivated,
        autoDeleted: t.autoDeleted + u.autoDeleted,
        rebuilt: t.rebuilt + (u.rebuilt ? 1 : 0),
      }),
      { ownAssigned: 0, medicineAssigned: 0, deactivated: 0, autoDeleted: 0, rebuilt: 0 },
    );
    console.log(
      `scanned ${r.scanned} user(s) with coach basic consent + journey; ` +
        `${verb}own ${totals.ownAssigned}, medicine ${totals.medicineAssigned}, ` +
        `deactivated ${totals.deactivated}, auto completions ${totals.autoDeleted}, ` +
        `${verb}rebuilt ${totals.rebuilt}; consented without journey ${r.consentNoJourney}; ` +
        `journey without consent (left alone) ${r.withoutConsent}; errors ${r.errors.length}.`,
    );
    for (const u of r.users) {
      console.log(
        `  user ${u.userId}: own ${u.ownAssigned}, medicine ${u.medicineAssigned}, ` +
          `deactivated ${u.deactivated}, auto ${u.autoDeleted}${u.rebuilt ? ', rebuilt' : ''}`,
      );
    }
    for (const e of r.errors) console.log(`  failed  user ${e.userId}: ${e.error}`);
    if (r.errors.length) process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`migrateToOnePlan: ${err?.message || String(err)}`);
    process.exit(1);
  });
}
