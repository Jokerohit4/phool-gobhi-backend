// buildFullExportService destructures a long Promise.all by position. A query
// added or moved without its variable silently hands one table's rows to the
// wrong output field (medical documents once received food requests). This
// test reads the source and pins the slots, so such a mismatch fails loudly.
// Run with: node --test test/exportQueryOrder.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../services/exportService.js', import.meta.url), 'utf8');
const start = src.indexOf('export async function buildFullExportService');
const body = src.slice(start);
const names = body
  .match(/const \[([^\]]+)\] =\s*await Promise\.all\(\[/)[1]
  .split(',')
  .map((s) => s.trim());
const all = body.slice(body.indexOf('await Promise.all(['));
const block = all.slice(0, all.indexOf('\n    ]);'));
// One entry per top-level call: `prisma.model.method(` or a helper call.
const entries = [...block.matchAll(/^ {6}(prisma\.(\w+)\.\w+|\w+)\(/gm)].map((m) => m[2] || m[1]);

test('one query per destructured name', () => {
  assert.equal(entries.length, names.length);
});

test('slots that were once shifted stay aligned', () => {
  const expected = {
    photoLogs: 'foodPhotoRequestLog',
    medicalDocuments: 'medicalDocument',
    biometricConsent: 'biometricConsent',
    healthProfile: 'healthProfile',
    medicationReminders: 'medicationReminder',
    healthProfileConsent: 'healthProfileConsent',
    foodRequests: 'foodRequest',
    waterLogs: 'waterLog',
  };
  for (const [name, model] of Object.entries(expected)) {
    assert.equal(entries[names.indexOf(name)], model, `${name} is fed by ${entries[names.indexOf(name)]}`);
  }
});
