// The social master switch (B14): read from the admin-editable app-config
// row that updateAppConfigAdmin writes, at config.social.enabled.
// Fail closed — any missing row, missing key, non-true value or read error
// is `enabled: false`, because this switch hides buddy/leaderboards/league.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let row = null;
let fail = false;
mock.module('@prisma/client', {
  exports: {
    PrismaClient: class {
      constructor() {
        this.appVersionSetting = {
          findUnique: async () => { if (fail) throw new Error('db down'); return row; },
        };
      }
    },
    Prisma: {},
  },
});
const { get } = await import('../services/socialConfigService.js');

test('on only when config.social.enabled is exactly true', async () => {
  row = { id: 1, config: { social: { enabled: true } } };
  assert.deepEqual(await get(), { enabled: true });
  row = { id: 1, config: { social: { enabled: 'true' } } };
  assert.deepEqual(await get(), { enabled: false });
});

test('fails closed: no row, no key, or a read error', async () => {
  row = null;
  assert.deepEqual(await get(), { enabled: false });
  row = { id: 1, config: { features: {} } };
  assert.deepEqual(await get(), { enabled: false });
  fail = true;
  assert.deepEqual(await get(), { enabled: false });
  fail = false;
});
