import { test } from 'node:test';
import assert from 'node:assert/strict';

test('full export includes the guidance condition fields and erasure deletes their owning row', async t => {
  const profile = {
    userId: 7,
    hasCondition: true,
    conditionType: 'diabetes',
    conditionSource: 'self_declared',
    conditionDeclaredAt: new Date('2026-11-26T00:00:00.000Z'),
    region: 'REST_INDIA',
  };
  const profiles = new Map([[7, profile], [8, { userId: 8 }]]);
  const db = new Proxy({
    guidanceProfile: {
      findUnique: async ({ where, select }) => {
        const row = profiles.get(where.userId) ?? null;
        return row && select ? Object.fromEntries(Object.keys(select).map(key => [key, row[key]])) : row;
      },
      deleteMany: async ({ where }) => { profiles.delete(where.userId); },
    },
    $executeRaw: async () => {},
    $transaction: async queries => Promise.all(queries),
  }, { get: (target, name) => target[name] ?? {
    findMany: async () => [], findUnique: async () => null, findFirst: async () => null, deleteMany: async () => {},
  } });
  t.mock.module('../db/prisma.js', { exports: { default: db } });
  t.mock.module('../services/ledger/medicalDocumentStorage.js', { exports: { deleteUserObjects: async () => {} } });
  t.mock.module('../services/ledger/foodPhotoStorage.js', { exports: { deleteUserPhotos: async () => {} } });
  const { buildFullExportService } = await import('../services/exportService.js');
  const { deleteAllDataService } = await import('../services/consentService.js');

  assert.deepEqual((await buildFullExportService(7)).guidance.profile, profile);
  await deleteAllDataService(7);
  assert.equal((await buildFullExportService(7)).guidance.profile, null);
  assert.equal(profiles.has(8), true);
});
