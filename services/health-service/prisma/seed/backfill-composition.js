// Add only composition metadata and missing named variants. Never modify a
// user's recipes, nutrient values, verification, or historical log snapshots.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { compositionForFood } from '../../services/ledger/foodComposition.js';
import { buildSearchText } from '../../services/ledger/foodMatch.js';
import { FOOD_VARIANTS } from './food-variants.seed.js';

const prisma = new PrismaClient();
try {
  let updated = 0, created = 0;
  const foods = await prisma.foodItem.findMany({ where: { createdByUserId: null } });
  for (const food of foods) {
    const composition = compositionForFood(food);
    if (JSON.stringify(food.ingredients) === JSON.stringify(composition.ingredients) &&
        food.dietaryType === composition.dietaryType) continue;
    await prisma.foodItem.update({ where: { id: food.id }, data: composition });
    updated++;
  }
  for (const food of FOOD_VARIANTS) {
    const exists = await prisma.foodItem.findFirst({ where: {
      name: { equals: food.name, mode: 'insensitive' }, createdByUserId: null,
    } });
    if (exists) continue;
    await prisma.foodItem.create({ data: {
      ...food, ...compositionForFood(food), source: 'estimate', verified: false,
      searchText: buildSearchText(food.name, food.aliases),
    } });
    created++;
  }
  console.log(JSON.stringify({ compositionUpdated: updated, variantsCreated: created }));
} finally { await prisma.$disconnect(); }
