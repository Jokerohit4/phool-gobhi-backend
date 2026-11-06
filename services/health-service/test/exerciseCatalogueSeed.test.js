import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const base = JSON.parse(readFileSync(new URL('../prisma/sources/catalogue-base.json', import.meta.url), 'utf8'));
const names = new Set(base.map((e) => e.name.toLowerCase()));
const inserted = [];
mock.module('@prisma/client', { namedExports: { PrismaClient: class {
  exercise = {
    findFirst: async ({ where }) => {
      assert.equal(where.createdByUserId, null);
      return names.has(where.name.equals.toLowerCase()) ? { id: 123 } : null;
    },
    create: async ({ data }) => { inserted.push(data); names.add(data.name.toLowerCase()); },
  };
  $disconnect = async () => {};
} } });

test('catalogue seed adds new exercises and a second run preserves all existing rows', async () => {
  const log = mock.method(console, 'log', () => {});
  try {
    await import('../prisma/seed.js?first');
    assert.equal(inserted.length, 795);
    assert.ok(inserted.every((e) => !Object.hasOwn(e, 'aliases')));
    await import('../prisma/seed.js?second');
    assert.equal(inserted.length, 795, 'no new rows on rerun');
  } finally { log.mock.restore(); }
});
