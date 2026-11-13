// makeTemplateLoader: buildToday shares one between the session preview and the
// day resolver, so a workout template is read once per request, not once per
// consumer / workout row.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTemplateLoader } from '../services/plan/templateLoader.js';

function fakePrisma() {
  const calls = [];
  return {
    calls,
    workoutTemplate: {
      findUnique: async (query) => {
        calls.push(query);
        return { id: query.where.id, name: `T${query.where.id}`, exercises: [{}, {}, {}] };
      },
    },
  };
}

test('the same template id is fetched once, however many times it is asked for', async () => {
  const prisma = fakePrisma();
  const load = makeTemplateLoader(prisma);
  const [a, b, c] = await Promise.all([load(7), load(7), load(7)]);
  assert.equal(prisma.calls.length, 1);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.deepEqual(prisma.calls[0], { where: { id: 7 }, include: { exercises: true } });
});

test('different ids are fetched separately', async () => {
  const prisma = fakePrisma();
  const load = makeTemplateLoader(prisma);
  await load(1); await load(2); await load(1);
  assert.deepEqual(prisma.calls.map((q) => q.where.id), [1, 2]);
});

test('no id -> null without touching the database', async () => {
  const prisma = fakePrisma();
  const load = makeTemplateLoader(prisma);
  assert.equal(await load(null), null);
  assert.equal(await load(undefined), null);
  assert.equal(await load(0), null);
  assert.equal(prisma.calls.length, 0);
});

test('each request gets its own loader (no cross-request caching)', async () => {
  const prisma = fakePrisma();
  await makeTemplateLoader(prisma)(5);
  await makeTemplateLoader(prisma)(5);
  assert.equal(prisma.calls.length, 2);
});
