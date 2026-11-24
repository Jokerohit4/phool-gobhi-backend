// The report-upload-to-guidance flow is gated server-side by `reportSubscription`
// (defense in depth; fail-closed, default off). It replaced `healthVault` on these
// two routes when that toggle was retired. Same refusal convention as every other
// disabled feature in this service: 403 { error: 'FEATURE_DISABLED' }.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';

let server, base;
const flags = { reportSubscription: false };
const checked = [];
const db = {
  healthReport: {
    findFirst: async () => null, // ownReport -> 404, i.e. the handler was reached
    update: async () => ({}),
  },
};

before(async (t) => {
  t.mock.module('../db/prisma.js', { exports: { default: db } });
  t.mock.module('../middleware/requireFeatureFlag.js', {
    exports: {
      requireFeatureFlag: (name) => async (_req, res, next) => {
        checked.push(name);
        if (!flags[name]) return res.status(403).json({ error: 'FEATURE_DISABLED' });
        next();
      },
    },
  });
  t.mock.module('../services/reportService.js', {
    exports: { createReportService: async () => ({}), processReportService: async () => {}, parseReportDate: (v) => v || null, findExistingReport: async () => null },
  });
  t.mock.module('../services/ledger/medicalDocumentStorage.js', {
    exports: {
      MAX_UPLOAD_BYTES: 10485760,
      isAllowedMimeType: () => true,
      isAllowedReportMimeType: () => true,
      saveDocument: async () => '',
      signedDocumentUrl: async () => 'u',
      deleteObjects: async () => ({ failed: [] }),
    },
  });
  t.mock.module('../services/ledger/blendedScoreCache.js', { exports: { invalidateBlendedScore: async () => {} } });
  t.mock.module('../utils/googleIdToken.js', { exports: { googleIdTokenHeader: async () => ({}) } });
  t.mock.module('axios', { exports: { default: { get: async () => ({ data: { data: {} } }) } } });
  const router = (await import('../routes/guidance.js')).default;
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

const post = async (path) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'x-user-id': '7', 'x-user-role': 'customer', 'Content-Type': 'application/json' },
    body: '{}',
  });
  return { status: res.status, body: await res.json() };
};

test('reportSubscription off: upload and retry are refused with 403 FEATURE_DISABLED', async () => {
  flags.reportSubscription = false;
  for (const path of ['/guidance/reports', '/guidance/reports/1/retry']) {
    const res = await post(path);
    assert.equal(res.status, 403, path);
    assert.deepEqual(res.body, { error: 'FEATURE_DISABLED' }, path);
  }
});

test('reportSubscription on: upload and retry get past the gate', async () => {
  flags.reportSubscription = true;
  const upload = await post('/guidance/reports');
  assert.notEqual(upload.status, 403, 'upload must reach its handler (400: no consent/file)');
  assert.equal(upload.status, 400);
  const retry = await post('/guidance/reports/1/retry');
  assert.equal(retry.status, 404, 'retry must reach ownReport');
});

test('the gate names reportSubscription and nothing else; healthVault is no longer consulted', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'routes', 'guidance.js'), 'utf8');
  const gated = [...src.matchAll(/requireFeatureFlag\('(\w+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(gated, ['reportSubscription', 'reportSubscription']);
  assert.doesNotMatch(src, /healthVault/);
  assert.ok(checked.every((n) => n === 'reportSubscription'));
});
