// Status report for the food catalogue. Read-only: it changes nothing.
//
//   npm run seed:foods -- --status
//   npm run seed:foods -- --status "rice"
//
// The point of this is to be runnable before anything is signed off. The
// catalogue ships as 55 estimates with no nutritionist review behind it, and the
// question "which of these has actually been checked?" needs a cheaper answer
// than opening the admin panel.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function parseArgs(argv) {
  const out = { status: false, query: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--status') out.status = true;
    else if (!argv[i].startsWith('-')) out.query = argv[i];
  }
  return out;
}

async function main() {
  const { query } = parseArgs(process.argv.slice(2));
  const where = query
    ? { name: { contains: query, mode: 'insensitive' } }
    : {};

  const [total, verified, bySource] = await Promise.all([
    prisma.foodItem.count({ where }),
    prisma.foodItem.count({ where: { ...where, verified: true } }),
    prisma.foodItem.groupBy({ by: ['source'], where, _count: { _all: true } }),
  ]);

  console.log(`${total} food(s) matching ${query ? `"${query}"` : 'the whole catalogue'}`);
  console.log(`  verified:   ${verified}`);
  console.log(`  unverified: ${total - verified}`);
  console.log('  by source:');
  for (const row of bySource) {
    console.log(`    ${row.source}: ${row._count._all}`);
  }

  if (verified === 0) {
    // Printed rather than thrown, because this is the expected state today.
    console.log(
      '\nNothing has been signed off. These numbers are estimates for a food log\n' +
        'to be usable at all, not a source anyone has checked. Do not treat them\n' +
        'as clinical: --signoff is a per-food, per-person action.',
    );
  } else if (verified < total) {
    console.log(
      `\n${verified} of ${total} verified. A partially verified catalogue means\n` +
        'search results are a mix of checked and estimated values - the client\n' +
        'shows the source per row for exactly this reason.',
    );
  }
}

main()
  .catch((err) => {
    console.error('food status failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
