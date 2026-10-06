import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// The on-device matcher's text half. What the unit tests pin:
//   - the shape the app downloads (empty before any refresh, then rows joined
//     with their food), which the app has to be able to trust at cold start;
//   - the refresh boundary: only curated rows are embedded (custom user food
//     never leaves a copy), each vector goes to the row/model key it belongs to,
//     and a partial provider reply refuses to half-update the cache.

import { getForMatcher, refreshAll } from '../services/ledger/foodEmbeddingService.js';

let envSnapshot;

beforeEach(() => {
  envSnapshot = {
    key: process.env.FOOD_PHOTO_PROVIDER_API_KEY,
    base: process.env.FOOD_PHOTO_PROVIDER_BASE_URL,
    model: process.env.FOOD_EMBEDDING_MODEL,
  };
  process.env.FOOD_PHOTO_PROVIDER_API_KEY = 'test-key';
  process.env.FOOD_PHOTO_PROVIDER_BASE_URL = 'https://emb.example/v1beta';
  process.env.FOOD_EMBEDDING_MODEL = 'text-embedding-004';
});

after(async () => {
  process.env.FOOD_PHOTO_PROVIDER_API_KEY = envSnapshot?.key;
  process.env.FOOD_PHOTO_PROVIDER_BASE_URL = envSnapshot?.base;
  process.env.FOOD_EMBEDDING_MODEL = envSnapshot?.model;
});

const ROWS = (overrides = {}) => [
  { id: 1, name: 'Rice, cooked (white)', aliases: ['chawal', 'bhaat'] },
  { id: 2, name: 'Dal, cooked', aliases: ['daal'] },
  { id: 3, name: 'Amla pickle, homemade', aliases: [] },
  ...(overrides.items || []),
];

function mockPrisma(overrides = {}) {
  let embeddings = overrides.embeddings || [];
  const upserted = [];
  return {
    upserted,
    embeddings,
    foodItem: { findMany: async () => overrides.items || ROWS() },
    foodEmbedding: {
      findMany: async () => embeddings,
      upsert: async (args) => {
        upserted.push(args);
        const { foodItemId, model, embedding } = args.create;
        embeddings = [
          ...embeddings.filter(
            (e) => !(e.foodItemId === foodItemId && e.model === (args.update.model || model)),
          ),
          { foodItemId, model: args.update.model || model, embedding },
        ];
        return { foodItemId, model };
      },
    },
    ...overrides.rest,
  };
}

test('before any refresh the matcher answer is an empty shape, not a failure', async () => {
  const out = await getForMatcher(mockPrisma());
  assert.deepEqual(out, { model: null, count: 0, foods: [] });
});

test('a refresh embeds every curated food and stores row + model + vector', async () => {
  const prisma = mockPrisma({
    foodItem: {
      findMany: async (args) => {
        assert.equal(args.where.createdByUserId, null, 'only curated rows are embedded');
        return ROWS();
      },
    },
  });

  const out = await refreshAll(prisma, {
    fetchBatch: async (texts) => texts.map((t) => [t.length, t.length / 2]),
  });

  assert.equal(out.computed, 3);
  assert.equal(prisma.upserted.length, 3);
  const rice = prisma.upserted.find((u) => u.create.foodItemId === 1);
  assert.equal(rice.create.model, 'text-embedding-004');
  assert.equal(rice.update.embedding[0], 'rice, cooked (white) chawal bhaat'.length);
  const amla = prisma.upserted.find((u) => u.create.foodItemId === 3);
  assert.equal(amla.create.embedding[0], 'amla pickle, homemade'.length);
});

test('the matcher read joins crops a vector whose food went away', async () => {
  const prisma = mockPrisma({
    embeddings: [
      { foodItemId: 1, model: 'text-embedding-004', embedding: [1, 2] },
      { foodItemId: 999, model: 'text-embedding-004', embedding: [9, 9] },
    ],
    items: [{ id: 1, name: 'Rice, cooked (white)', aliases: ['chawal'] }],
  });
  const out = await getForMatcher(prisma);
  assert.equal(out.count, 2);
  assert.equal(out.foods.length, 1, 'an orphaned vector is dropped');
  assert.equal(out.foods[0].embedding[0], 1);
});

test('a partial provider reply refuses to half-update the cache', async () => {
  const prisma = mockPrisma();
  await assert.rejects(
    () => refreshAll(prisma, { fetchBatch: async () => [[1], [2]] }),
    (err) => err.status === 502 && err.code === 'PROVIDER_BAD_SHAPE',
  );
  assert.equal(prisma.upserted.length, 0);
});

test('an empty catalogue refreshes to zero without calling the provider', async () => {
  let called = false;
  const prisma = mockPrisma({ items: [] });
  const out = await refreshAll(prisma, {
    fetchBatch: async () => {
      called = true;
      return [];
    },
  });
  assert.equal(out.computed, 0);
  assert.equal(called, false);
});

test('an unconfigured provider is a 503 before anything is read', async () => {
  const old = process.env.FOOD_PHOTO_PROVIDER_API_KEY;
  process.env.FOOD_PHOTO_PROVIDER_API_KEY = '';
  try {
    await assert.rejects(
      () => refreshAll(mockPrisma(), { fetchBatch: async () => [] }),
      (err) => err.status === 503 && err.code === 'PROVIDER_NOT_CONFIGURED',
    );
  } finally {
    process.env.FOOD_PHOTO_PROVIDER_API_KEY = old;
  }
});