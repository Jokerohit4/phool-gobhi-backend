// Approved coach content copy (dev -> prod) script.
//
// Pinned: dry run writes nothing; --apply needs the matching --target-host;
// only approved rows are copied; exercises are matched by name, not id;
// create-only unless --update; identical rows are a no-op; reviewedBy is the
// target's --reviewer, never the source's id.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, checkTargets, copyContent } from '../scripts/copyApprovedContent.js';

function matches(where, row) {
  return Object.entries(where || {}).every(([k, v]) => {
    if (v && typeof v === 'object' && Array.isArray(v.in)) return v.in.includes(row[k]);
    return row[k] === v;
  });
}

function fakeDb({ exercises = [], exerciseContent = [], coachArticle = [] } = {}) {
  const writes = [];
  let nextId = 1000;
  const model = (rows, name) => ({
    findFirst: async ({ where }) => rows.find((r) => matches(where, r)) ?? null,
    findMany: async ({ where } = {}) => rows.filter((r) => matches(where, r)),
    create: async ({ data }) => { const row = { id: nextId++, ...data }; writes.push({ op: 'create', model: name, data }); rows.push(row); return row; },
    update: async ({ where, data }) => {
      const row = rows.find((r) => r.id === where.id);
      const { version, ...rest } = data;
      Object.assign(row, rest);
      if (version?.increment) row.version = (row.version ?? 1) + version.increment;
      writes.push({ op: 'update', model: name, data });
      return row;
    },
  });
  return {
    writes,
    exercise: model(exercises, 'exercise'),
    exerciseContent: model(exerciseContent, 'exerciseContent'),
    coachArticle: model(coachArticle, 'coachArticle'),
  };
}

const EX = { steps: ['Stand tall.'], feelCues: ['Thighs.'], mistakes: ['Knees in.'] };

function devDb() {
  return fakeDb({
    exercises: [
      { id: 7, name: 'Bodyweight Squat', createdByUserId: null },
      { id: 8, name: 'Plank', createdByUserId: null },
    ],
    exerciseContent: [
      { id: 1, exerciseId: 7, lang: 'en', ...EX, reviewStatus: 'approved', reviewedBy: 9 },
      { id: 2, exerciseId: 7, lang: 'hi', ...EX, reviewStatus: 'pending' },
      { id: 3, exerciseId: 8, lang: 'en', ...EX, reviewStatus: 'rejected' },
    ],
    coachArticle: [
      { id: 1, slug: 'day-one', lang: 'en', kind: 'first_visit', title: 'Day one', body: 'Start easy.', reviewStatus: 'approved', reviewedBy: 9 },
    ],
  });
}

// Prod: same exercise under a different id.
const prodDb = (extra = {}) => fakeDb({ exercises: [{ id: 41, name: 'Bodyweight Squat', createdByUserId: null }], ...extra });

test('parseArgs: defaults to a create-only dry run', () => {
  assert.deepEqual(parseArgs([]), { lang: null, update: false, apply: false, targetHost: null, reviewer: null });
  assert.throws(() => parseArgs(['--lang=fr']), /--lang/);
  assert.throws(() => parseArgs(['--reviewer=abc']), /--reviewer/);
  assert.throws(() => parseArgs(['--force']), /Unknown argument/);
});

test('checkTargets: refuses a missing or identical URL, and --apply without the matching host', () => {
  const opts = parseArgs([]);
  assert.throws(() => checkTargets({ sourceUrl: 'postgres://a/db', targetUrl: '', opts }), /Set both/);
  assert.throws(() => checkTargets({ sourceUrl: 'postgres://a/db', targetUrl: 'postgres://a/db', opts }), /same database/);
  assert.equal(checkTargets({ sourceUrl: 'postgres://dev.host/db', targetUrl: 'postgres://prod.host/db', opts }), 'prod.host');
  const apply = parseArgs(['--apply', '--target-host=dev.host']);
  assert.throws(() => checkTargets({ sourceUrl: 'postgres://dev.host/db', targetUrl: 'postgres://prod.host/db', opts: apply }), /--target-host=prod\.host/);
  const ok = parseArgs(['--apply', '--target-host=prod.host']);
  assert.equal(checkTargets({ sourceUrl: 'postgres://dev.host/db', targetUrl: 'postgres://prod.host/db', opts: ok }), 'prod.host');
});

test('dry run plans the copy but writes nothing', async () => {
  const target = prodDb();
  const r = await copyContent({ source: devDb(), target, opts: parseArgs([]), log: () => {} });
  assert.equal(r.created.length, 2);
  assert.equal(target.writes.length, 0);
});

test('apply copies approved rows only, matched to the target exercise by name', async () => {
  const target = prodDb();
  const r = await copyContent({ source: devDb(), target, opts: parseArgs(['--apply', '--reviewer=3']), log: () => {} });
  assert.deepEqual(r.created, ['exercise "Bodyweight Squat" [en]', 'article day-one [en]']);
  const ex = target.writes.find((w) => w.model === 'exerciseContent').data;
  assert.equal(ex.exerciseId, 41);
  assert.equal(ex.reviewStatus, 'approved');
  assert.equal(ex.reviewedBy, 3);
  assert.deepEqual(ex.steps, EX.steps);
  assert.equal(target.writes.some((w) => w.data.lang === 'hi'), false);
});

test('an exercise missing on the target is reported, not created', async () => {
  const source = devDb();
  source.exerciseContent.findMany = async () => [{ id: 9, exerciseId: 8, lang: 'en', ...EX, reviewStatus: 'approved' }];
  const target = prodDb();
  const r = await copyContent({ source, target, opts: parseArgs(['--apply']), log: () => {} });
  assert.deepEqual(r.missingExercise, ['exercise "Plank" [en]']);
  assert.equal(target.writes.filter((w) => w.model === 'exerciseContent').length, 0);
});

test('re-running is a no-op; a differing target row is skipped unless --update', async () => {
  const target = prodDb();
  await copyContent({ source: devDb(), target, opts: parseArgs(['--apply']), log: () => {} });
  const again = await copyContent({ source: devDb(), target, opts: parseArgs(['--apply']), log: () => {} });
  assert.equal(again.unchanged, 2);
  assert.equal(again.created.length + again.updated.length, 0);

  const edited = devDb();
  edited.coachArticle.findMany = async () => [{ slug: 'day-one', lang: 'en', kind: 'first_visit', title: 'Day one', body: 'Start easy. Drink water.', reviewStatus: 'approved' }];
  const skipped = await copyContent({ source: edited, target, opts: parseArgs(['--apply', '--lang=en']), log: () => {} });
  assert.equal(skipped.differs.length, 1);
  const updated = await copyContent({ source: edited, target, opts: parseArgs(['--apply', '--update', '--lang=en']), log: () => {} });
  assert.deepEqual(updated.updated, ['article day-one [en]']);
  const row = await target.coachArticle.findFirst({ where: { slug: 'day-one', lang: 'en' } });
  assert.equal(row.body, 'Start easy. Drink water.');
  assert.equal(row.version, 2);
});
