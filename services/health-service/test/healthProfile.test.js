import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  validateProfilePatch,
  validateMedication,
  answeredKeys,
  completion,
  basicsComplete,
  summariseForCoach,
  FIELD_CONSUMERS,
  QUESTION_KEYS,
  BASICS_KEYS,
  MEDICATION_NOTE,
} from '../services/healthProfile.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8');
const schema = read('prisma', 'schema.prisma');

function columnsOf(model) {
  const body = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`))?.[1] || '';
  return [...body.matchAll(/^\s{2}(\w+)\s+\w+/gm)].map((m) => m[1]);
}
const ANSWER_COLUMNS = columnsOf('HealthProfile').filter(
  (c) => !['userId', 'createdAt', 'updatedAt'].includes(c),
);

// --- "prefer not to say" is an answer, and never needs consent --------------

test('prefer-not answers to all five basics need no consent', () => {
  const r = validateProfilePatch({
    allergyStatus: 'prefer_not',
    drinking: 'prefer_not',
    smoking: 'prefer_not',
    weightDeclined: true,
    heightDeclined: true,
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.sensitive, false);
});

test('"never" and "none" are still disclosures and need consent', () => {
  assert.equal(validateProfilePatch({ smoking: 'never' }).sensitive, true);
  assert.equal(validateProfilePatch({ allergyStatus: 'none' }).sensitive, true);
  assert.equal(validateProfilePatch({ greens: 'occasionally' }).sensitive, true);
});

test('non-sensitive questions need no consent', () => {
  const r = validateProfilePatch({ hometown: '  Patna ', occupation: 'desk', whoCooks: 'family', mealsPerDay: 3 });
  assert.equal(r.sensitive, false);
  assert.equal(r.data.hometown, 'Patna');
});

test('prefer-not answers count as answered, so the basics can complete without disclosure', () => {
  const answered = answeredKeys({
    allergyStatus: 'prefer_not',
    drinking: 'prefer_not',
    smoking: 'prefer_not',
    weightDeclined: true,
    heightDeclined: true,
  });
  assert.equal(basicsComplete(answered), true);
});

// --- validation ---------------------------------------------------------------

test("'has' allergies with an empty list is refused; any other status clears the list", () => {
  assert.ok(validateProfilePatch({ allergyStatus: 'has', allergies: [] }).errors.length);
  assert.deepEqual(validateProfilePatch({ allergyStatus: 'none', allergies: ['peanuts'] }).data.allergies, []);
});

test('out-of-set values and out-of-range numbers are refused', () => {
  assert.ok(validateProfilePatch({ drinking: 'sometimes' }).errors.length);
  assert.ok(validateProfilePatch({ weightKg: 5 }).errors.length);
  assert.ok(validateProfilePatch({ heightCm: 400 }).errors.length);
  assert.ok(validateProfilePatch({ mealsPerDay: 0 }).errors.length);
});

test('a real weight or height clears its "declined" flag', () => {
  const r = validateProfilePatch({ weightKg: 72.44, heightCm: 175.4 });
  assert.equal(r.bodyNumbers.weightKg, 72.4);
  assert.equal(r.bodyNumbers.heightCm, 175);
  assert.equal(r.data.weightDeclined, false);
  assert.equal(r.data.heightDeclined, false);
});

test('any answer can be cleared with null — the user can always take it back', () => {
  const r = validateProfilePatch({ greens: null, otherSubstances: null, drinking: null });
  assert.deepEqual(r.errors, []);
  assert.equal(r.data.greens, null);
  assert.equal(r.sensitive, false);
});

test('medication times must be HH:MM and are de-duplicated and sorted', () => {
  assert.ok(validateMedication({ name: 'X', times: ['8am'] }).errors.length);
  assert.ok(validateMedication({ name: '', times: [] }).errors.length);
  assert.deepEqual(validateMedication({ name: 'Vit D', times: ['21:00', '08:00', '08:00'] }).data.times, ['08:00', '21:00']);
});

// --- coins --------------------------------------------------------------------

test('every question is coin-eligible and completion counts all of them', () => {
  assert.equal(QUESTION_KEYS.length, 17);
  for (const k of BASICS_KEYS) assert.ok(QUESTION_KEYS.includes(k));
  assert.deepEqual(completion([]), { answered: 0, total: 17, percent: 0 });
  assert.equal(completion(QUESTION_KEYS).percent, 100);
});

test('the coin is keyed on the question, never the answer — re-answering cannot pay twice', () => {
  const src = read('utils', 'notifyChallengeService.js');
  assert.match(src, /idempotencyKey: `health-profile:\$\{userId\}:\$\{questionKey\}`/);
  assert.match(src, /amount: 1,/);
});

// --- nothing collected without a reader ---------------------------------------

test('every HealthProfile column names its consumer', () => {
  const missing = ANSWER_COLUMNS.filter((c) => !FIELD_CONSUMERS[c]);
  assert.deepEqual(missing, [], `columns with no named consumer: ${missing.join(', ')}`);
});

test('the user’s own export carries every health-profile column', () => {
  const src = read('services', 'exportService.js');
  const missing = ANSWER_COLUMNS.filter((c) => !new RegExp(`healthProfile\\.${c}\\b`).test(src));
  assert.deepEqual(missing, [], `export drops: ${missing.join(', ')}`);
  assert.match(src, /medicationReminders\.map/);
});

// --- where the substance answers must never go ---------------------------------

function sourcesUnder(dir) {
  const out = [];
  for (const e of readdirSync(join(here, '..', dir), { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...sourcesUnder(join(dir, e.name)));
    else if (e.name.endsWith('.js')) out.push(read(dir, e.name));
  }
  return out.join('\n');
}

test('greens and other-substance answers never reach insurer-grade, FHIR, admin or analytics code', () => {
  const forbidden = [
    sourcesUnder('services/share'),
    sourcesUnder('services/fhir'),
    read('services', 'adminService.js'),
    read('controllers', 'adminController.js'),
  ].join('\n');
  for (const field of ['greens', 'otherSubstances', 'healthProfile']) {
    assert.doesNotMatch(forbidden, new RegExp(`\\b${field}\\b`), `${field} appears in an outward path`);
  }
});

// --- coach summary --------------------------------------------------------------

test('the coach gets allergies as a safety line and substances in the lifestyle line', () => {
  const { safety, lifestyle } = summariseForCoach(
    {
      allergyStatus: 'has',
      allergies: ['peanuts', 'tree_nuts'],
      drinking: 'weekly',
      smoking: 'never',
      greens: 'occasionally',
      occupation: 'shifts',
      workingHours: 'over_10',
      medicationsStatus: 'has',
    },
    { medicationCount: 2 },
  );
  assert.match(safety, /peanuts, tree nuts/);
  assert.match(lifestyle, /Smokes cannabis occasionally/);
  assert.match(lifestyle, /Smokes never/);
  assert.match(lifestyle, /shift work, over 10 hours a day/);
  assert.match(lifestyle, /Never advise on medicines/);
});

test('"prefer not to say" tells the coach nothing, and medicine names never reach it', () => {
  const { safety, lifestyle } = summariseForCoach(
    { allergyStatus: 'prefer_not', drinking: 'prefer_not', smoking: 'prefer_not', greens: 'prefer_not' },
    { medicationCount: 0 },
  );
  assert.equal(safety, null);
  assert.equal(lifestyle, null);
  const ctx = read('services', 'assistant', 'contextService.js');
  assert.doesNotMatch(ctx, /medicationReminder\??\.findMany/);
});

test('the medication note is a fixed sentence, never generated', () => {
  assert.equal(
    MEDICATION_NOTE,
    'Some medicines affect exercise and diet — check with your doctor before big changes.',
  );
});

test('the coach summary is deterministic, so the cached prompt prefix holds', () => {
  const p = { allergyStatus: 'has', allergies: ['milk'], whoCooks: 'cook', hometown: 'Indore' };
  assert.deepEqual(summariseForCoach(p), summariseForCoach({ ...p }));
});
