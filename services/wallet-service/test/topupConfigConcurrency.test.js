// Optimistic concurrency (expectedUpdatedAt) on PUT /topup-config. Stateful
// prisma mock with a real compare-and-set updateMany. Run with:
//   node --experimental-test-module-mocks --test test/topupConfigConcurrency.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const T0 = new Date('2026-10-01T10:00:00.000Z');
let row = null;
let counts = { upsert: 0, updateMany: 0, reads: 0 };

let service;
test('setup', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.walletTopupConfig = {
            findUnique: async () => { counts.reads++; return row ? { ...row } : null; },
            upsert: async ({ create, update }) => {
              counts.upsert++;
              row = row ? { ...row, ...update, updatedAt: new Date() } : { ...create, updatedAt: new Date() };
              return { ...row };
            },
            updateMany: async ({ where, data }) => {
              counts.updateMany++;
              if (!row || row.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 };
              row = { ...row, ...data };
              return { count: 1 };
            },
          };
        }
      },
      Prisma: {},
    },
  });
  service = await import('../services/walletService.js');
});

function reset() {
  row = { id: 1, presets: [200, 500], allowCustomAmount: false, minCustomAmount: null, maxCustomAmount: null, updatedAt: T0 };
  counts = { upsert: 0, updateMany: 0, reads: 0 };
}
const body = (over = {}) => ({ presets: [200, 500, 1000], allowCustomAmount: false, minCustomAmount: null, maxCustomAmount: null, ...over });

test('matching expectedUpdatedAt: writes and returns the new updatedAt', async () => {
  reset();
  const out = await service.updateWalletTopupConfig(body({ expectedUpdatedAt: T0.toISOString() }), 9);
  assert.deepEqual(out.presets, [200, 500, 1000]);
  assert.ok(out.updatedAt.getTime() > T0.getTime());
  assert.deepEqual(row.presets, [200, 500, 1000]);
});

test('stale expectedUpdatedAt: 409 CONFIG_CONFLICT and nothing written', async () => {
  reset();
  await assert.rejects(
    service.updateWalletTopupConfig(body({ expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }), 9),
    (e) => e.status === 409
      && e.errorCode === 'CONFIG_CONFLICT'
      && e.error === 'This setting was changed by someone else. Reload and try again.'
      && e.currentUpdatedAt === T0.toISOString(),
  );
  assert.deepEqual(row.presets, [200, 500]);
  assert.equal(counts.upsert, 0);
});

test('absent expectedUpdatedAt: unchanged behaviour (plain upsert)', async () => {
  reset();
  await service.updateWalletTopupConfig(body(), 9);
  assert.equal(counts.upsert, 1);
  assert.equal(counts.updateMany, 0);
  assert.deepEqual(row.presets, [200, 500, 1000]);
});

test('validation still runs before the compare-and-set (400, no write attempt)', async () => {
  reset();
  await assert.rejects(
    service.updateWalletTopupConfig(body({ presets: [], expectedUpdatedAt: T0.toISOString() }), 9),
    (e) => e.status === 400,
  );
  assert.equal(counts.updateMany, 0);
});

test('concurrent double save from one page load: second conflicts', async () => {
  reset();
  const results = await Promise.allSettled([
    service.updateWalletTopupConfig(body({ presets: [300], expectedUpdatedAt: T0.toISOString() }), 1),
    service.updateWalletTopupConfig(body({ presets: [400], expectedUpdatedAt: T0.toISOString() }), 2),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  const ok = results.find((r) => r.status === 'fulfilled');
  assert.deepEqual(row.presets, ok.value.presets);
});

test('fresh read bypasses the 30s cache (admin ETag must not be stale)', async () => {
  reset();
  await service.getWalletTopupConfigCached(); // primes the cache
  const before = counts.reads;
  row = { ...row, presets: [999], updatedAt: new Date(T0.getTime() + 1000) };
  const cached = await service.getWalletTopupConfigCached();
  assert.equal(counts.reads, before, 'customer read is served from cache');
  const fresh = await service.getWalletTopupConfigCached({ fresh: true });
  assert.deepEqual(fresh.presets, [999]);
  assert.notDeepEqual(cached.presets, fresh.presets);
});
