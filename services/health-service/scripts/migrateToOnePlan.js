import prisma from '@/prisma/client';

async function migrateToOnePlan() {
  const users = await prisma.user.findMany({
    include: { planItems: true },
  });

  let totalUsers = 0;
  let usersWithCoachConsent = 0;
  let planItemsUpdated = 0;
  let suggestedDeactivated = 0;
  let completionsDeleted = 0;

  for (const user of users) {
    totalUsers += 1;

    const hasCoachConsent = user.planItems.some(
      (item) => item.kind === 'coach' && item.consent === true
    );

    if (hasCoachConsent) {
      usersWithCoachConsent += 1;
    }

    for (const item of user.planItems) {
      // Set layerKey='own' on user/doctor PlanItem rows
      if (item.layerKey === undefined && (item.role === 'user' || item.role === 'doctor')) {
        await prisma.planItem.update({
          where: { id: item.id },
          data: { layerKey: 'own' },
        });
        planItemsUpdated += 1;
      }

      // Deactivate suggested rows with null layerKey or kind:nutrition
      if (item.kind === 'suggested' || (item.layerKey === null && item.kind !== 'nutrition')) {
        await prisma.planItem.update({
          where: { id: item.id },
          data: { active: false },
        });
        suggestedDeactivated += 1;
      }

      // Delete PlanItemCompletion rows with how:'auto'
      if (item.completions) {
        for (const comp of item.completions) {
          if (comp.how === 'auto') {
            await prisma.planItemCompletion.delete({
              where: { id: comp.id },
            });
            completionsDeleted += 1;
          }
        }
      }
    }
  }

  console.log('=== One Plan Migration Summary ===');
  console.log(`Total users: ${totalUsers}`);
  console.log(`Users with coach consent: ${usersWithCoachConsent}`);
  console.log(`PlanItems updated (layerKey='own'): ${planItemsUpdated}`);
  console.log(`Suggested rows deactivated: ${suggestedDeactivated}`);
  console.log(`PlanItemCompletion rows deleted (how:'auto'): ${completionsDeleted}`);
  console.log('=== End ===');
  console.log('Dry run complete. No changes applied with --apply flag.');
}

// Run the migration
migrateToOnePlan()
  .catch((e) => {
    console.error('Migration failed:', e);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });