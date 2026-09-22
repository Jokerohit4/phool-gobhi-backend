// Regression test: the assistant-memory write path.  Verifies that
// extractMemoriesService actually persists facts to the database and that
// listMemoriesService reads them back.
//
// The original bug: AssistantMemory was permanently empty because the write
// path silently did nothing.  These tests guarantee it cannot happen again.
//
// Run with:
//   node --experimental-test-module-mocks --test test/assistantMemoryWrite.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

let extractMemoriesService, listMemoriesService;

// --- in-memory Prisma mock --------------------------------------------------

const memoryStore = new Map();
let nextId = 1;
let providerCallCount = 0;
let mockGenerate = async () => ({ content: '{"memories":[]}' });

function resetStore() {
  memoryStore.clear();
  nextId = 1;
  providerCallCount = 0;
}

function ck(userId, key, value) {
  return `${userId}\0${key}\0${value}`;
}

// --- setup: wire mocks, then import the module once -------------------------

test('setup: mock prisma + providers, import memoryService', async (t) => {
  resetStore();

  class MockPrismaClient {
    constructor() {
      this.assistantMemory = {
        async upsert({ where, update, create }) {
          const { userId, key, value } = where.userId_key_value;
          const id = ck(userId, key, value);
          const existing = memoryStore.get(id);
          if (existing) {
            existing.source = update.source;
            existing.updatedAt = new Date();
            return { ...existing };
          }
          const row = {
            id: nextId++,
            userId: create.userId,
            key: create.key,
            value: create.value,
            source: create.source,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          memoryStore.set(id, row);
          return { ...row };
        },

        async findMany({ where, orderBy, take }) {
          let rows = [...memoryStore.values()].filter((r) => r.userId === where.userId);
          if (where.key) rows = rows.filter((r) => r.key === where.key);
          if (where.source) rows = rows.filter((r) => r.source === where.source);
          if (orderBy?.updatedAt === 'asc') rows.sort((a, b) => a.updatedAt - b.updatedAt);
          if (take) rows = rows.slice(0, take);
          return rows;
        },

        async findUnique({ where }) {
          if (where.userId_key_value) {
            const { userId, key, value } = where.userId_key_value;
            return memoryStore.get(ck(userId, key, value)) || null;
          }
          if (where.id !== undefined) {
            return [...memoryStore.values()].find((r) => r.id === where.id) || null;
          }
          return null;
        },

        async deleteMany({ where }) {
          let count = 0;
          if (where.id?.in) {
            for (const id of where.id.in) {
              for (const [k, v] of memoryStore) {
                if (v.id === id) {
                  memoryStore.delete(k);
                  count++;
                }
              }
            }
          } else if (where.userId && where.key) {
            for (const [k, v] of [...memoryStore]) {
              if (v.userId === where.userId && v.key === where.key) {
                if (where.NOT?.value && v.value !== where.NOT.value) {
                  memoryStore.delete(k);
                  count++;
                } else if (!where.NOT) {
                  memoryStore.delete(k);
                  count++;
                }
              }
            }
          }
          return { count };
        },

        async delete({ where }) {
          for (const [k, v] of memoryStore) {
            if (v.id === where.id) {
              memoryStore.delete(k);
              return v;
            }
          }
          return null;
        },

        async count({ where }) {
          let rows = [...memoryStore.values()].filter((r) => r.userId === where.userId);
          if (where.key) rows = rows.filter((r) => r.key === where.key);
          if (where.NOT?.value) rows = rows.filter((r) => r.value !== where.NOT.value);
          return rows.length;
        },
      };

      this.$transaction = async (fns) => {
        const results = [];
        for (const fn of fns) results.push(await fn);
        return results;
      };
    }
  }

  t.mock.module('@prisma/client', {
    exports: { PrismaClient: MockPrismaClient, Prisma: {} },
  });

  t.mock.module('../services/assistant/providers/index.js', {
    exports: {
      getProvider: () => ({
        generate: async (...args) => {
          providerCallCount++;
          return mockGenerate(...args);
        },
      }),
    },
  });

  ({ extractMemoriesService, listMemoriesService } = await import(
    '../services/assistant/memoryService.js'
  ));
});

// --- write-path tests -------------------------------------------------------

test('write path: memorable message triggers upsert', async () => {
  resetStore();
  mockGenerate = async () => ({
    content: JSON.stringify({ memories: [{ key: 'allergy', value: 'peanuts' }] }),
  });

  const result = await extractMemoriesService('user-1', 'I am allergic to peanuts');

  assert.equal(providerCallCount, 1, 'provider was called');
  assert.equal(result.length, 1);
  assert.equal(result[0].key, 'allergy');
  assert.equal(result[0].value, 'peanuts');
  assert.ok(memoryStore.size > 0, 'store is non-empty — upsert was called');

  const stored = memoryStore.get(ck('user-1', 'allergy', 'peanuts'));
  assert.ok(stored, 'memory persisted in store');
  assert.equal(stored.source, 'extracted');
});

test('persistence: written memory returned by listMemoriesService', async () => {
  resetStore();
  mockGenerate = async () => ({
    content: JSON.stringify({ memories: [{ key: 'goal', value: 'wants to add 5kg of muscle' }] }),
  });

  await extractMemoriesService('user-2', 'My goal is to add 5kg of muscle');

  const memories = await listMemoriesService('user-2');
  assert.equal(memories.length, 1);
  assert.equal(memories[0].key, 'goal');
  assert.equal(memories[0].value, 'wants to add 5kg of muscle');
  assert.equal(memories[0].source, 'extracted');
});

test('all five fact types trigger writes', async () => {
  resetStore();
  const facts = [
    { key: 'allergy', value: 'shellfish', msg: 'I am allergic to shellfish' },
    { key: 'goal', value: 'wants to run a marathon', msg: 'My goal is to run a marathon' },
    { key: 'equipment', value: 'home gym with dumbbells only', msg: 'I have a home gym with dumbbells only' },
    { key: 'preference', value: 'prefers morning workouts', msg: 'I prefer morning workouts' },
    { key: 'injury_mentioned', value: 'had knee surgery in 2023', msg: 'I had knee surgery in 2023' },
  ];

  for (const f of facts) {
    mockGenerate = async () => ({
      content: JSON.stringify({ memories: [{ key: f.key, value: f.value }] }),
    });
    await extractMemoriesService('user-3', f.msg);
  }

  const memories = await listMemoriesService('user-3');
  const keys = memories.map((m) => m.key);
  assert.ok(keys.includes('allergy'), 'allergy written');
  assert.ok(keys.includes('goal'), 'goal written');
  assert.ok(keys.includes('equipment'), 'equipment written');
  assert.ok(keys.includes('preference'), 'preference written');
  assert.ok(keys.includes('injury_mentioned'), 'injury_mentioned written');
  assert.equal(memories.length, 5);
});

test('no write for non-memorable messages', async () => {
  resetStore();
  providerCallCount = 0;
  mockGenerate = async () => {
    throw new Error('provider must not be called for non-memorable text');
  };

  const messages = [
    'ok thanks',
    'cool',
    'yes',
    'what should I do tomorrow?',
    'how many sets should I be doing?',
  ];

  for (const msg of messages) {
    const result = await extractMemoriesService('user-4', msg);
    assert.deepEqual(result, [], `no extraction for: "${msg}"`);
  }

  assert.equal(memoryStore.size, 0, 'store remains empty');
  assert.equal(providerCallCount, 0, 'provider was not called');
});

test('no write when provider returns no extractable memories', async () => {
  resetStore();
  providerCallCount = 0;
  mockGenerate = async () => ({ content: '{"memories":[]}' });

  const result = await extractMemoriesService('user-5', 'I am allergic to peanuts');

  assert.equal(result.length, 0);
  assert.equal(providerCallCount, 1, 'provider was called');
  assert.equal(memoryStore.size, 0, 'no write occurred');
});

test('goal replaces on write (cardinality one)', async () => {
  resetStore();

  mockGenerate = async () => ({
    content: JSON.stringify({ memories: [{ key: 'goal', value: 'first goal' }] }),
  });
  await extractMemoriesService('user-6', 'My goal is the first goal');

  mockGenerate = async () => ({
    content: JSON.stringify({ memories: [{ key: 'goal', value: 'second goal' }] }),
  });
  await extractMemoriesService('user-6', 'My goal is now the second goal');

  const memories = await listMemoriesService('user-6');
  assert.equal(memories.length, 1);
  assert.equal(memories[0].key, 'goal');
  assert.equal(memories[0].value, 'second goal');
});

test('allergies accumulate (cardinality many)', async () => {
  resetStore();

  mockGenerate = async () => ({
    content: JSON.stringify({ memories: [{ key: 'allergy', value: 'peanuts' }] }),
  });
  await extractMemoriesService('user-7', 'I am allergic to peanuts');

  mockGenerate = async () => ({
    content: JSON.stringify({ memories: [{ key: 'allergy', value: 'shellfish' }] }),
  });
  await extractMemoriesService('user-7', 'I am also allergic to shellfish');

  const memories = await listMemoriesService('user-7');
  assert.equal(memories.length, 2);
  const values = memories.map((m) => m.value);
  assert.ok(values.includes('peanuts'), 'first allergy kept');
  assert.ok(values.includes('shellfish'), 'second allergy kept');
});

test('read path returns memories ordered by tier then key', async () => {
  resetStore();

  const facts = [
    { key: 'preference', value: 'likes early sessions', msg: 'I prefer early sessions' },
    { key: 'allergy', value: 'dairy', msg: 'I am allergic to dairy' },
    { key: 'goal', value: 'lose 5kg', msg: 'My goal is to lose 5kg' },
    { key: 'equipment', value: 'resistance bands', msg: 'I have resistance bands' },
    { key: 'injury_mentioned', value: 'old shoulder injury', msg: 'I have an old shoulder injury' },
  ];

  for (const f of facts) {
    mockGenerate = async () => ({
      content: JSON.stringify({ memories: [{ key: f.key, value: f.value }] }),
    });
    await extractMemoriesService('user-8', f.msg);
  }

  const memories = await listMemoriesService('user-8');
  const keys = memories.map((m) => m.key);

  // Tier 1: allergy, injury_mentioned (alphabetical)
  // Tier 2: goal
  // Tier 3: equipment, preference (alphabetical)
  assert.deepEqual(keys, [
    'allergy',
    'injury_mentioned',
    'goal',
    'equipment',
    'preference',
  ]);
});
