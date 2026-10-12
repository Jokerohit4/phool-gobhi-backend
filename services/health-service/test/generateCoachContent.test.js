// Coach content generation script (B15).
//
// Pinned: argument parsing; dry run makes no LLM calls and no writes (and
// survives an unreachable database); English generation is create-only and
// writes `pending`; unsafe model output is refused, never written; and
// translations are made from APPROVED English rows only.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, generate, unsafeReason, parseJsonReply, FIRST_VISIT_ARTICLES,
} from '../scripts/generateCoachContent.js';

const here = dirname(fileURLToPath(import.meta.url));

function matches(where, row) {
  return Object.entries(where || {}).every(([k, v]) => row[k] === v);
}

function fakePrisma({ exerciseContent = [], coachArticle = [], templateExercises = [], failReads = false } = {}) {
  const writes = [];
  const model = (rows, name) => ({
    findFirst: async ({ where }) => rows.find((r) => matches(where, r)) ?? null,
    findMany: async ({ where } = {}) => rows.filter((r) => matches(where, r)),
    count: async ({ where } = {}) => rows.filter((r) => matches(where, r)).length,
    create: async ({ data }) => { writes.push({ model: name, data }); rows.push(data); return data; },
  });
  return {
    writes,
    exerciseContent: model(exerciseContent, 'exerciseContent'),
    coachArticle: model(coachArticle, 'coachArticle'),
    templateExercise: {
      findMany: async () => {
        if (failReads) throw new Error("Can't reach database server");
        return templateExercises;
      },
    },
  };
}

const SQUAT = { exercise: { id: 7, name: 'Bodyweight Squat', equipment: 'bodyweight', primaryMuscles: ['quads'], muscleGroup: 'legs' } };
const GOOD_EX = { steps: ['Stand tall.', 'Stop if you feel sharp pain.'], feelCues: ['You should feel your thighs.'], mistakes: ['Knees cave in: push them out.'] };

function fakeProvider(reply) {
  const calls = [];
  return {
    calls,
    generate: async (args) => {
      calls.push(args);
      const r = typeof reply === 'function' ? reply(args) : reply;
      return { content: JSON.stringify(r) };
    },
  };
}

const articleReply = { title: 'Day one', body: 'Walk in, say hi, start easy.' };

test('parseArgs accepts --flag=value and --flag value, and rejects bad input', () => {
  assert.deepEqual(parseArgs(['--batch=1', '--lang=hi', '--dry-run']), { batch: 1, lang: 'hi', dryRun: true, limit: null });
  assert.deepEqual(parseArgs(['--batch', '1', '--lang', 'hinglish', '--limit', '3']), { batch: 1, lang: 'hinglish', dryRun: false, limit: 3 });
  assert.throws(() => parseArgs(['--batch=2']));
  assert.throws(() => parseArgs(['--batch=1', '--lang=fr']));
  assert.throws(() => parseArgs(['--batch=1', '--oops']));
});

test('dry run: no LLM calls, no writes', async () => {
  const prisma = fakePrisma({ templateExercises: [SQUAT] });
  const provider = fakeProvider(GOOD_EX);
  const r = await generate({ prisma, provider, opts: parseArgs(['--batch=1', '--dry-run']), log: () => {} });
  assert.equal(provider.calls.length, 0);
  assert.equal(prisma.writes.length, 0);
  assert.equal(r.planned, 1 + FIRST_VISIT_ARTICLES.length);
});

test('dry run survives an unreachable database', async () => {
  const prisma = fakePrisma({ failReads: true });
  const logs = [];
  const r = await generate({ prisma, provider: null, opts: parseArgs(['--batch=1', '--dry-run']), log: (m) => logs.push(m) });
  assert.equal(r.planned, FIRST_VISIT_ARTICLES.length);
  assert.ok(logs.some((l) => l.includes('exercise list skipped')));
});

test('the CLI dry run exits 0 with no database configured', () => {
  const out = execFileSync(process.execPath, [join(here, '..', 'scripts', 'generateCoachContent.js'), '--batch=1', '--lang=en', '--dry-run'], {
    cwd: join(here, '..'),
    env: { ...process.env, DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/none' },
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.match(out, /dry run/);
  assert.match(out, /article what-to-bring/);
});

test('English generation writes pending rows and skips rows that already exist', async () => {
  const prisma = fakePrisma({
    templateExercises: [SQUAT, SQUAT],
    coachArticle: [{ slug: 'day-one', lang: 'en', reviewStatus: 'approved' }],
  });
  const provider = fakeProvider(({ messages }) => (messages[0].content.includes('Slug:') ? articleReply : GOOD_EX));
  const r = await generate({ prisma, provider, opts: parseArgs(['--batch=1']), log: () => {} });
  assert.equal(r.created, 1 + FIRST_VISIT_ARTICLES.length - 1);
  assert.equal(r.skippedExisting, 1);
  assert.ok(prisma.writes.every((w) => w.data.reviewStatus === 'pending'));
  assert.ok(!prisma.writes.some((w) => w.data.slug === 'day-one'), 'existing article must not be regenerated');
});

test('unsafe model output is refused and never written', async () => {
  const prisma = fakePrisma({ templateExercises: [SQUAT] });
  const provider = fakeProvider({ ...GOOD_EX, mistakes: ['Take 5 g creatine before this.'] });
  const r = await generate({ prisma, provider, opts: parseArgs(['--batch=1', '--limit=1']), log: () => {} });
  assert.equal(r.created, 0);
  assert.equal(r.refused.length, 1);
  assert.equal(prisma.writes.length, 0);
});

test('translations come from approved English rows only', async () => {
  const prisma = fakePrisma({
    exerciseContent: [
      { exerciseId: 7, lang: 'en', reviewStatus: 'approved', ...GOOD_EX },
      { exerciseId: 8, lang: 'en', reviewStatus: 'pending', ...GOOD_EX },
    ],
  });
  const provider = fakeProvider(GOOD_EX);
  const r = await generate({ prisma, provider, opts: parseArgs(['--batch=1', '--lang=hinglish']), log: () => {} });
  assert.equal(r.created, 1);
  assert.deepEqual(prisma.writes.map((w) => [w.data.exerciseId, w.data.lang, w.data.reviewStatus]), [[7, 'hinglish', 'pending']]);
});

test('a translation that drops a line is refused', async () => {
  const prisma = fakePrisma({ exerciseContent: [{ exerciseId: 7, lang: 'en', reviewStatus: 'approved', ...GOOD_EX }] });
  const provider = fakeProvider({ ...GOOD_EX, steps: ['Seedhe khade raho.'] });
  const r = await generate({ prisma, provider, opts: parseArgs(['--batch=1', '--lang=hinglish']), log: () => {} });
  assert.equal(r.created, 0);
  assert.equal(r.refused[0].reason, 'translation changed the number of lines');
});

test('unsafeReason: doses with drug words and cure claims; ordinary coaching passes', () => {
  assert.ok(unsafeReason('Take 500 mg of vitamin C'));
  assert.ok(unsafeReason('5 g creatine daily'));
  assert.ok(unsafeReason('This cures diabetes'));
  assert.equal(unsafeReason('Hold for 30 seconds, rest 60 seconds.'), null);
  assert.equal(unsafeReason('Eat dal and paneer for protein.'), null);
});

test('parseJsonReply tolerates a ```json fence', () => {
  assert.deepEqual(parseJsonReply('```json\n{"a":1}\n```'), { a: 1 });
});
