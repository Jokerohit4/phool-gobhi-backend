#!/usr/bin/env node
// Backfill GymLink rows for accounts that joined a gym before B2 shipped the
// link table.
//
// WHY THIS EXISTS
//
// Before B2, "this user belongs to this gym" was a single column: User.linkedGymId.
// B2 adds the GymLink history table and starts every new join/link/removal
// writing to it, but the column is still set on every pre-existing gym-joined
// account with no GymLink row behind it. The roster, the monthly bill and the
// erasure/export paths all read GymLink now, so those accounts would silently
// disappear from a gym's member list (and from the count it is billed on) until
// they are backfilled.
//
// Each such account joined through a gym QR (/join/:gymId or the app signup with
// a gym id), so the backfilled link is `gym_qr`, dated at the account's
// createdAt — the join instant.
//
// SAFE BY DEFAULT
//
// `--dry-run` reports without writing. The operation is idempotent regardless: a
// user that already has ANY GymLink row is skipped, so a real run and a re-run
// produce the same state. That also means it is safe to run more than once if a
// later wave of pre-B2 accounts appears.
//
//   node scripts/backfillGymLinks.js --dry-run
//   node scripts/backfillGymLinks.js
//
// Exit codes: 0 success, 1 runtime failure.

import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';

dotenv.config();

/**
 * Create a `gym_qr` GymLink (linkedAt = the user's createdAt) for every user
 * with a linkedGymId and no existing GymLink. Idempotent.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{scanned:number, created:number, skipped:number}>}
 */
export async function backfillGymLinks(prisma, { dryRun = false } = {}) {
  const users = await prisma.user.findMany({
    where: { linkedGymId: { not: null } },
    select: { id: true, linkedGymId: true, createdAt: true },
  });

  let scanned = 0;
  let created = 0;
  let skipped = 0;
  for (const user of users) {
    scanned += 1;
    const existing = await prisma.gymLink.findFirst({
      where: { userId: user.id },
      select: { id: true },
    });
    if (existing) {
      skipped += 1;
      continue;
    }
    if (!dryRun) {
      await prisma.gymLink.create({
        data: {
          userId: user.id,
          gymId: user.linkedGymId,
          source: 'gym_qr',
          linkedAt: user.createdAt ?? new Date(),
        },
      });
    }
    created += 1;
  }

  return { scanned, created, skipped };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!process.env.DATABASE_URL) {
    console.error('backfillGymLinks: DATABASE_URL is not set - load the service .env, or export it. Refusing to guess a database.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const { scanned, created, skipped } = await backfillGymLinks(prisma, { dryRun });
    console.log(
      `${dryRun ? '[dry-run] ' : ''}scanned ${scanned} gym-linked user(s); ` +
        `${dryRun ? 'would create' : 'created'} ${created} GymLink row(s); ${skipped} already had one.`
    );
    if (dryRun) console.log('Dry run. Nothing was written. Re-run without --dry-run to apply.');
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked as a command, so importing backfillGymLinks in a test
// does not connect to whatever DATABASE_URL happens to be in the environment.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`backfillGymLinks: ${err?.stack || String(err)}`);
    process.exit(1);
  });
}
