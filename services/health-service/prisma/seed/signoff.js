// Sign off ONE food as verified.
//
//   npm run seed:foods -- --signoff "Rice, cooked (white)"
//   npm run seed:foods -- --signoff --id 42 --source ifct
//   npm run seed:foods -- --signoff "Idli" --reviewer "Dr Rao" --note "IFCT 2021, raw+cooked"
//
// Deliberately one food at a time, and never a wildcard. A `--signoff-all` (or a
// bare "y" to a prompt) would be one keystroke away from marking 55 estimates as
// professionally checked, and the flag would then be a lie that the rest of the
// system reports to users as fact. Sign-off is a person saying they read the row
// and accept the numbers; that cannot be batched.
//
// The nutritionist's name is recorded, so "verified" points at a human rather
// than at this script.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// `source` records where the numbers came from. Free text rather than an enum,
// because the honest answer today is mostly "estimated from standard tables" and
// forcing that into a fixed vocabulary would just produce 'estimate' for all 55
// and hide the ones a real reference was used for.
function parseArgs(argv) {
  const out = { name: null, id: null, source: null, reviewer: null, note: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--signoff') continue;
    if (arg === '--id') out.id = Number(argv[++i]);
    else if (arg === '--source') out.source = argv[++i];
    else if (arg === '--reviewer') out.reviewer = argv[++i];
    else if (arg === '--note') out.note = argv[++i];
    else if (!arg.startsWith('-')) out.name = arg;
  }
  return out;
}

async function main() {
  const { name, id, source, reviewer, note } = parseArgs(process.argv.slice(2));

  if (!name && !id) {
    console.error('give one food: --signoff "Rice, cooked (white)" or --signoff --id 42');
    process.exitCode = 1;
    return;
  }

  const food = await prisma.foodItem.findFirst({
    where: id ? { id } : { name: { equals: name, mode: 'insensitive' } },
  });
  if (!food) {
    console.error(`no food found for ${id ? `id ${id}` : `"${name}"`} - run --status to list`);
    process.exitCode = 1;
    return;
  }

  if (food.verified) {
    // Not idempotent-silent. Re-signing is allowed but has to be deliberate,
    // because overwriting a checked row's numbers is the one thing that makes a
    // verified flag untrue.
    console.log(`${food.name} is already verified. This will overwrite its numbers.`);
  }

  // A user's own food is not the catalogue's to sign off. The flag means "the
  // platform stands behind these numbers", and the platform did not write them.
  if (food.createdByUserId != null) {
    console.error(
      'that food belongs to a user, not the catalogue - refusing to mark it verified',
    );
    process.exitCode = 1;
    return;
  }

  console.log('about to mark as verified:');
  console.log(`  name:    ${food.name}`);
  console.log(`  basis:   ${food.basis}`);
  console.log(`  kcal:    ${food.kcal}`);
  console.log(`  protein: ${food.proteinG}  carbs: ${food.carbsG}  fat: ${food.fatG}`);
  console.log(`  fibre:   ${food.fibreG}  iron: ${food.ironMg}`);
  console.log(`  source:  ${source || food.source}${reviewer ? `  reviewer: ${reviewer}` : ''}`);

  const updated = await prisma.foodItem.update({
    where: { id: food.id },
    data: {
      verified: true,
      source: source || food.source,
      verifiedBy: reviewer || null,
      verifiedAt: new Date(),
      reviewNote: note || null,
    },
  });

  console.log(`\nverified: ${updated.name}`);
  if (!reviewer) {
    // Allowed, but said out loud: an unattributed sign-off is weaker evidence
    // than a named one, and this is the last place anyone will notice.
    console.log(
      'signed off without --reviewer, so this row records no name against the check.\n' +
        'The admin panel should require it rather than warn.',
    );
  }
}

main()
  .catch((err) => {
    console.error('sign-off failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
