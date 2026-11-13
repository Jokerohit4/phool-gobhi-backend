import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseFoodEstimate, ensurePhotoFood } from '../services/ledger/foodPhotoCatalogue.js';
import { normaliseItem, buildPrompt } from '../services/ledger/providers/visionShared.js';

const nutrition = {
  kcal: 180, proteinG: 6, carbsG: 25, fatG: 6, fibreG: 3,
  ironMg: 2, magnesiumMg: 30, calciumMg: null, zincMg: 0,
  aliases: ['  regional name  '], basis: 'cooked',
  servings: [{ label: ' piece ', grams: 90 }],
};

test('both prompt paths request identification and complete per-100g estimates', () => {
  for (const prompt of [buildPrompt(''), buildPrompt('Dal, cooked')]) {
    assert.match(prompt, /Identify the individual foods/);
    assert.match(prompt, /100 grams/);
    assert.match(prompt, /servings/);
    assert.match(prompt, /zincMg/);
  }
});

test('provider normalisation keeps validated nutrition, null micros and real zero values', () => {
  const item = normaliseItem({ name: 'new dish', grams: 180, nutrition });
  assert.equal(item.nutrition.calciumMg, null);
  assert.equal(item.nutrition.zincMg, 0);
  assert.deepEqual(item.nutrition.servings, [{ label: 'piece', grams: 90 }]);
  assert.deepEqual(item.nutrition.aliases, ['regional name']);
});

test('invalid or missing required values never become catalogue nutrition', () => {
  for (const patch of [
    { kcal: null }, { kcal: '' }, { proteinG: -1 }, { fatG: Infinity },
    { carbsG: 200 }, { fibreG: 99 }, { servings: [] }, { kcal: 1001 },
  ]) assert.equal(normaliseFoodEstimate({ ...nutrition, ...patch }), null);
  assert.equal(normaliseFoodEstimate(null), null);
});

test('transaction rechecks the shared food after taking a normalized name lock', async () => {
  const calls = [];
  const existing = { id: 9, name: 'New Dish', kcal: 120 };
  const prisma = {
    async $transaction(work) { calls.push('transaction'); return work(this); },
    async $executeRaw(sql, lock) { calls.push(lock); },
    foodItem: {
      async findFirst({ where }) {
        calls.push('read');
        assert.equal(where.createdByUserId, null);
        assert.equal(where.name.mode, 'insensitive');
        return existing;
      },
      async create() { assert.fail('must reuse a food another request created'); },
    },
  };
  assert.equal(await ensurePhotoFood(prisma, { name: '  NEW   DISH ' }), existing);
  assert.deepEqual(calls, ['transaction', 'photo-food:new dish', 'read']);
});

test('new non-veg food gets searchable metadata, portions and unverified provenance', async () => {
  let data;
  const prisma = {
    async $transaction(work) { return work(this); },
    async $executeRaw() {},
    foodItem: {
      async findFirst() { return null; },
      async create(args) { data = args.data; return { id: 3, ...data }; },
    },
  };
  const food = await ensurePhotoFood(prisma, { name: 'New dish', nutrition, nonVeg: true }, { model: 'vision' });
  assert.equal(food.id, 3);
  assert.equal(data.nonVeg, true);
  assert.equal(data.veg, false);
  assert.equal(data.verified, false);
  assert.equal(data.source, 'estimate');
  assert.equal(data.verifiedBy, null);
  assert.match(data.reviewNote, /vision/);
  assert.match(data.searchText, /regional name/);
});
