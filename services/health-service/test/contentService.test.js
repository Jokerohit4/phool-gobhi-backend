// Coach content review gate (B15).
//
// What is pinned here:
//   - pending and rejected rows are never served, in any language;
//   - a missing or unapproved translation falls back to approved English, and
//     the response says which language was served;
//   - an edit after approval goes back to pending with version + 1, and can
//     only touch content fields — never status, reviewer or version;
//   - approve/reject record the reviewer passed in (the controller passes the
//     JWT id), and a stale expected version is a 409, not a silent approval;
//   - the admin queue carries the English master on translations.
//
// The fake prisma filters by the `where` it is given, so "approved only" is
// actually tested. Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as svc from '../services/contentService.js';

function matches(where, row) {
  return Object.entries(where || {}).every(([k, v]) => row[k] === v);
}

function fakeModel(rows) {
  return {
    rows,
    findFirst: async ({ where }) => rows.find((r) => matches(where, r)) ?? null,
    findUnique: async ({ where }) => rows.find((r) => matches(where, r)) ?? null,
    findMany: async ({ where } = {}) => rows.filter((r) => matches(where, r)),
    update: async ({ where, data }) => {
      const row = rows.find((r) => r.id === where.id);
      for (const [k, v] of Object.entries(data)) {
        row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + v.increment : v;
      }
      return { ...row };
    },
  };
}

function fakePrisma({ exercises = [], articles = [] } = {}) {
  return {
    exerciseContent: fakeModel(exercises),
    coachArticle: fakeModel(articles),
    exercise: {
      findUnique: async ({ where }) => ({ 7: { name: 'Goblet Squat', difficulty: 'beginner' } }[where.id] ?? null),
    },
  };
}

const ex = (over) => ({
  id: 1, exerciseId: 7, lang: 'en', steps: ['a'], feelCues: ['b'], mistakes: ['c'],
  reviewStatus: 'approved', reviewedBy: 9, version: 1, approvedAt: new Date(), ...over,
});
const art = (over) => ({
  id: 1, slug: 'day-one', kind: 'first_visit', lang: 'en', title: 'Day one', body: 'Hello',
  reviewStatus: 'approved', reviewedBy: 9, version: 1, approvedAt: new Date(), ...over,
});

test('pending exercise content is never served', async () => {
  const prisma = fakePrisma({ exercises: [ex({ reviewStatus: 'pending' })] });
  assert.equal(await svc.getExerciseContent(prisma, 7, 'en'), null);
});

test('rejected content is never served, even as a fallback', async () => {
  const prisma = fakePrisma({ exercises: [ex({ reviewStatus: 'rejected' }), ex({ id: 2, lang: 'hi', reviewStatus: 'rejected' })] });
  assert.equal(await svc.getExerciseContent(prisma, 7, 'hi'), null);
});

test('approved exercise content comes back with the exercise difficulty', async () => {
  const prisma = fakePrisma({ exercises: [ex()] });
  const out = await svc.getExerciseContent(prisma, 7, 'en');
  assert.deepEqual(out, { exerciseId: 7, steps: ['a'], feelCues: ['b'], mistakes: ['c'], difficulty: 'beginner', lang: 'en' });
});

test('hinglish falls back to approved English when the translation is pending', async () => {
  const prisma = fakePrisma({ exercises: [ex(), ex({ id: 2, lang: 'hinglish', steps: ['x'], reviewStatus: 'pending' })] });
  const out = await svc.getExerciseContent(prisma, 7, 'hinglish');
  assert.equal(out.lang, 'en');
  assert.deepEqual(out.steps, ['a']);
});

test('an approved translation is served in its own language', async () => {
  const prisma = fakePrisma({ exercises: [ex(), ex({ id: 2, lang: 'hi', steps: ['हिंदी'] })] });
  const out = await svc.getExerciseContent(prisma, 7, 'hi');
  assert.equal(out.lang, 'hi');
  assert.deepEqual(out.steps, ['हिंदी']);
});

test('an unknown language is treated as English', async () => {
  const prisma = fakePrisma({ exercises: [ex()] });
  assert.equal((await svc.getExerciseContent(prisma, 7, 'fr')).lang, 'en');
});

test('article list: approved only, translation where approved, English otherwise', async () => {
  const prisma = fakePrisma({
    articles: [
      art(),
      art({ id: 2, slug: 'what-to-bring', title: 'Bring' }),
      art({ id: 3, slug: 'gym-etiquette', title: 'Manners', reviewStatus: 'pending' }),
      art({ id: 4, slug: 'day-one', lang: 'hinglish', title: 'Pehla din' }),
    ],
  });
  const out = await svc.listArticles(prisma, { kind: 'first_visit', lang: 'hinglish' });
  assert.deepEqual(out, [
    { slug: 'day-one', title: 'Pehla din', kind: 'first_visit' },
    { slug: 'what-to-bring', title: 'Bring', kind: 'first_visit' },
  ]);
});

test('article list rejects an unknown kind', async () => {
  await assert.rejects(svc.listArticles(fakePrisma(), { kind: 'nope' }), { status: 400 });
});

test('single article falls back to English and never serves pending', async () => {
  const prisma = fakePrisma({ articles: [art(), art({ id: 2, lang: 'hi', reviewStatus: 'pending', title: 'पहला दिन' })] });
  const out = await svc.getArticle(prisma, 'day-one', 'hi');
  assert.deepEqual(out, { slug: 'day-one', title: 'Day one', body: 'Hello', lang: 'en' });
  assert.equal(await svc.getArticle(fakePrisma({ articles: [art({ reviewStatus: 'pending' })] }), 'day-one', 'en'), null);
});

test('an edit after approval goes back to pending with version + 1', async () => {
  const prisma = fakePrisma({ exercises: [ex({ version: 3 })] });
  const out = await svc.editContent(prisma, { type: 'exercise', id: 1, updates: { steps: [' new step '] } });
  assert.equal(out.reviewStatus, 'pending');
  assert.equal(out.version, 4);
  assert.equal(out.reviewedBy, null);
  assert.equal(out.approvedAt, null);
  assert.deepEqual(out.steps, ['new step']);
  assert.equal(await svc.getExerciseContent(prisma, 7, 'en'), null, 'edited row must stop being served');
});

test('an edit cannot set status, reviewer, version or identity', async () => {
  const prisma = fakePrisma({ articles: [art({ version: 2 })] });
  const out = await svc.editContent(prisma, {
    type: 'article', id: 1,
    updates: { body: 'Edited', reviewStatus: 'approved', reviewedBy: 1, version: 99, slug: 'x', lang: 'hi' },
  });
  assert.equal(out.reviewStatus, 'pending');
  assert.equal(out.version, 3);
  assert.equal(out.slug, 'day-one');
  assert.equal(out.lang, 'en');
  assert.equal(out.body, 'Edited');
});

test('an edit with no editable field is a 400; a bad list is a 400; a missing row is a 404', async () => {
  const prisma = fakePrisma({ exercises: [ex()] });
  await assert.rejects(svc.editContent(prisma, { type: 'exercise', id: 1, updates: { reviewStatus: 'approved' } }), { status: 400 });
  await assert.rejects(svc.editContent(prisma, { type: 'exercise', id: 1, updates: { steps: 'not a list' } }), { status: 400 });
  await assert.rejects(svc.editContent(prisma, { type: 'exercise', id: 1, updates: { steps: [''] } }), { status: 400 });
  await assert.rejects(svc.editContent(prisma, { type: 'exercise', id: 99, updates: { steps: ['a'] } }), { status: 404 });
  await assert.rejects(svc.editContent(prisma, { type: 'video', id: 1, updates: { steps: ['a'] } }), { status: 400 });
});

test('approve records the reviewer and the time; reject clears approvedAt', async () => {
  const prisma = fakePrisma({ exercises: [ex({ reviewStatus: 'pending', reviewedBy: null, approvedAt: null })] });
  const ok = await svc.reviewContent(prisma, { type: 'exercise', id: 1, decision: 'approve', reviewerId: 42 });
  assert.equal(ok.reviewStatus, 'approved');
  assert.equal(ok.reviewedBy, 42);
  assert.ok(ok.approvedAt instanceof Date);
  const no = await svc.reviewContent(prisma, { type: 'exercise', id: 1, decision: 'reject', reviewerId: 43 });
  assert.equal(no.reviewStatus, 'rejected');
  assert.equal(no.reviewedBy, 43);
  assert.equal(no.approvedAt, null);
});

test('approving a version that changed since it was opened is a 409', async () => {
  const prisma = fakePrisma({ articles: [art({ reviewStatus: 'pending', version: 5 })] });
  await assert.rejects(
    svc.reviewContent(prisma, { type: 'article', id: 1, decision: 'approve', reviewerId: 1, expectedVersion: 4 }),
    { status: 409, code: 'CONTENT_CHANGED' },
  );
  const ok = await svc.reviewContent(prisma, { type: 'article', id: 1, decision: 'approve', reviewerId: 1, expectedVersion: 5 });
  assert.equal(ok.reviewStatus, 'approved');
});

test('review without a reviewer id is refused', async () => {
  const prisma = fakePrisma({ exercises: [ex()] });
  await assert.rejects(svc.reviewContent(prisma, { type: 'exercise', id: 1, decision: 'approve', reviewerId: undefined }), { status: 401 });
});

test('queue: filters by status and lang, and translations carry their English master', async () => {
  const prisma = fakePrisma({
    exercises: [ex(), ex({ id: 2, lang: 'hi', reviewStatus: 'pending' })],
    articles: [art({ reviewStatus: 'pending' })],
  });
  const { items, total } = await svc.listQueue(prisma, { status: 'pending' });
  assert.equal(total, 2);
  const hi = items.find((i) => i.type === 'exercise');
  assert.equal(hi.lang, 'hi');
  assert.equal(hi.master.id, 1);
  assert.equal(hi.exerciseName, 'Goblet Squat');
  assert.equal(items.find((i) => i.type === 'article').master, undefined);
  await assert.rejects(svc.listQueue(prisma, { status: 'done' }), { status: 400 });
  await assert.rejects(svc.listQueue(prisma, { lang: 'fr' }), { status: 400 });
});
