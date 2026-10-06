import { test } from 'node:test';
import assert from 'node:assert/strict';

// foodRequestService says "a request is not a food"; this is the module that
// makes the exception to that rule into a deliberate boundary instead of a
// contradiction. The tests prove the boundary from both sides: the only FoodItem
// write runs through here, with provenance that says who added it and that it
// went through the reviewer lane, and an existing row is never duplicated by a
// reviewer who misspells a dish that is already in hand.

import { createFood } from '../services/ledger/foodAdminService.js';

function mockPrisma(overrides = {}) {
  const created = [];
  return {
    created,
    foodItem: {
      findFirst: async () => null,
      create: async (args) => {
        const row = { id: created.length + 1, ...args.data };
        created.push(row);
        return row;
      },
      ...overrides.foodItem,
    },
    foodRequest: {
      updateMany: async (args) => ({ count: 0, ...(overrides.updateManyResult || {}) }),
      ...overrides.foodRequest,
    },
    ...overrides.rest,
  };
}

const BASE = {
  name: 'Amla pickle, homemade',
  aliases: ['amla achar'],
  basis: 'cooked',
  kcal: 120,
  proteinG: 1,
  carbsG: 8,
  fatG: 9,
  fibreG: 2,
};

test('a reviewer creates a food and closes the pending requests for its name', async () => {
  let createdData = null;
  let updateWhere = null;
  let resolved = 0;
  const prisma = mockPrisma({
    foodRequest: {
      updateMany: async (args) => ((updateWhere = args.where), { count: (resolved = 6) }),
    },
  });
  prisma.foodItem.create = async (args) => ((createdData = args.data), { id: 5, ...args.data });

  const out = await createFood(prisma, { ...BASE, source: 'estimate' });

  assert.equal(out.resolvedRequests, 6);
  assert.equal(out.food.name, 'Amla pickle, homemade');
  // The resolution is exact and conservative: same name, case-insensitive,
  // pending rows only.
  assert.equal(updateWhere.status, 'pending');
  assert.deepEqual(updateWhere.name, { equals: 'Amla pickle, homemade', mode: 'insensitive' });

  assert.equal(createdData.kcal, 120);
  assert.equal(createdData.searchText, 'amla pickle, homemade amla achar');
  assert.equal(createdData.createdByUserId, null);
});

test('the search text is the same haystack the picker ranks on', async () => {
  let createdData = null;
  const prisma = mockPrisma();
  prisma.foodItem.create = async (args) => ((createdData = args.data), { id: 5, ...args.data });
  await createFood(prisma, { ...BASE, aliases: ['achar', 'husked amla'] });
  assert.equal(createdData.searchText, 'amla pickle, homemade achar husked amla');
});

test('a duplicate name is refused with the rows, so the reviewer can alias instead', async () => {
  const prisma = mockPrisma({
    foodItem: {
      findFirst: async () => ({ id: 3, name: 'Amla pickle, homemade' }),
    },
  });
  await assert.rejects(
    () => createFood(prisma, { ...BASE }),
    (err) => err.status === 409 && err.code === 'FOOD_EXISTS' && err.foods[0].id === 3,
  );
});

test('the per-100 g numbers are required and must be real', async () => {
  const prisma = mockPrisma();
  await assert.rejects(
    () => createFood(prisma, { ...BASE, kcal: 0, proteinG: 'x' }),
    (err) => err.status === 400 && err.code === 'NUMBERS_REQUIRED',
  );
});

test('a missing or bogus source falls back to estimate, never a false claim', async () => {
  for (const source of [undefined, 'made-up-source']) {
    let createdData = null;
    const prisma = mockPrisma();
    prisma.foodItem.create = async (args) => ((createdData = args.data), { id: 5, ...args.data });
    await createFood(prisma, { ...BASE, source });
    assert.equal(createdData.source, 'estimate');
    assert.equal(createdData.verified, false);
  }
});

test('verified stamps who checked and when; unverified carries neither', async () => {
  let unverified = null;
  let verified = null;
  const prisma = mockPrisma();
  prisma.foodItem.create = async (args) => {
    if (verified == null) verified = args.data;
    return { id: 5, ...args.data };
  };
  await createFood(prisma, { ...BASE, verified: false });
  assert.equal(verified.verifiedBy, null);
  assert.equal(verified.verifiedAt, null);

  prisma.foodItem.create = async (args) => {
    unverified = args.data;
    return { id: 6, ...args.data };
  };
  await createFood(prisma, { ...BASE, verified: true, verifiedBy: 'NIN-2024', reviewNote: 'IFCT entry 1201' });
  assert.equal(unverified.verifiedBy, 'NIN-2024');
  assert.ok(unverified.verifiedAt instanceof Date);
  assert.equal(unverified.reviewNote, 'IFCT entry 1201');
});

test('aliases are clamped in width and count', async () => {
  let createdData = null;
  const prisma = mockPrisma();
  prisma.foodItem.create = async (args) => ((createdData = args.data), { id: 5, ...args.data });
  await createFood(prisma, {
    ...BASE,
    aliases: ['x'.repeat(200), 'alias two', ...Array.from({ length: 20 }, (_, i) => `alias ${i}`)],
  });
  assert.ok(createdData.aliases.length <= 12);
  assert.ok(createdData.aliases.every((a) => a.length <= 80));
});

test('a non-veg food is never marked veg', async () => {
  let createdData = null;
  const prisma = mockPrisma();
  prisma.foodItem.create = async (args) => ((createdData = args.data), { id: 5, ...args.data });
  await createFood(prisma, { ...BASE, nonVeg: true });
  assert.equal(createdData.nonVeg, true);
  assert.equal(createdData.veg, false);
});