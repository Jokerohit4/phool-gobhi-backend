// Coach content (B15): exercise coaching copy and coach articles, behind a
// founder review gate.
//
// The one rule everything here serves: a user only ever sees content a human
// approved. Generation writes `pending`; only an admin approve makes a row
// servable; and ANY edit after that sends it back to `pending` with a new
// version, so an approved row can never change underneath its approval.
//
//   reads    approved rows only. A missing or unapproved translation falls back
//            to the approved English row, and the response says which language
//            was actually served so the app can note "not translated yet".
//   queue    every row by type/lang/status for the admin review screen; a
//            translation carries its English row as `master` so the reviewer
//            can check safety lines side by side.
//   edit     allow-listed fields only (never status, reviewer or version from
//            the client), resets to pending, version + 1.
//   review   approve / reject; the reviewer is the caller's JWT id, never a
//            body field. An optional expected `version` turns "approve what I
//            read" into a 409 when someone edited the row in between.
//
// Every function takes prisma first, same as habitsService, so the tests run
// against a fake with no database.

export const LANGS = ['en', 'hinglish', 'hi'];
export const ARTICLE_KINDS = ['first_visit', 'faq'];
export const STATUSES = ['pending', 'approved', 'rejected'];
export const TYPES = ['exercise', 'article'];

const EXERCISE_FIELDS = ['steps', 'feelCues', 'mistakes'];
const ARTICLE_FIELDS = ['title', 'body'];
const MAX_LIST_ITEMS = 20;
const MAX_LINE = 500;
const MAX_TITLE = 200;
const MAX_BODY = 20000;

function httpError(status, error, code) {
  return Object.assign(new Error(error), { status, error, code });
}

/// Unknown or missing languages are served English rather than refused: a
/// client on a newer build asking for a language this server doesn't know yet
/// should still get instructions.
export function normaliseLang(lang) {
  const l = String(lang || '').trim().toLowerCase();
  return LANGS.includes(l) ? l : 'en';
}

function modelFor(prisma, type) {
  if (type === 'exercise') return prisma.exerciseContent;
  if (type === 'article') return prisma.coachArticle;
  throw httpError(400, 'type must be exercise or article', 'INVALID_TYPE');
}

// ---- public reads -----------------------------------------------------------

export async function getExerciseContent(prisma, exerciseId, lang) {
  const want = normaliseLang(lang);
  const langs = want === 'en' ? ['en'] : [want, 'en'];
  let row = null;
  for (const l of langs) {
    row = await prisma.exerciseContent.findFirst({
      where: { exerciseId, lang: l, reviewStatus: 'approved' },
    });
    if (row) break;
  }
  if (!row) return null;
  // difficulty belongs to the exercise, not to one language's copy of it.
  const exercise = await prisma.exercise.findUnique({
    where: { id: exerciseId },
    select: { difficulty: true },
  });
  return {
    exerciseId,
    steps: row.steps ?? [],
    feelCues: row.feelCues ?? [],
    mistakes: row.mistakes ?? [],
    difficulty: exercise?.difficulty ?? null,
    lang: row.lang,
  };
}

export async function listArticles(prisma, { kind, lang } = {}) {
  if (kind !== undefined && kind !== null && kind !== '' && !ARTICLE_KINDS.includes(kind)) {
    throw httpError(400, `kind must be one of ${ARTICLE_KINDS.join(', ')}`, 'INVALID_KIND');
  }
  const want = normaliseLang(lang);
  const base = { reviewStatus: 'approved', ...(kind ? { kind } : {}) };
  const select = { slug: true, title: true, kind: true, lang: true };
  const english = await prisma.coachArticle.findMany({ where: { ...base, lang: 'en' }, select });
  const translated = want === 'en'
    ? []
    : await prisma.coachArticle.findMany({ where: { ...base, lang: want }, select });

  // Translation where approved, English for the rest — one row per slug.
  const bySlug = new Map();
  for (const a of english) bySlug.set(a.slug, a);
  for (const a of translated) bySlug.set(a.slug, a);
  return [...bySlug.values()]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map(({ slug, title, kind: k }) => ({ slug, title, kind: k }));
}

export async function getArticle(prisma, slug, lang) {
  const want = normaliseLang(lang);
  const langs = want === 'en' ? ['en'] : [want, 'en'];
  for (const l of langs) {
    const row = await prisma.coachArticle.findFirst({
      where: { slug, lang: l, reviewStatus: 'approved' },
      select: { slug: true, title: true, body: true, lang: true },
    });
    if (row) return { slug: row.slug, title: row.title, body: row.body, lang: row.lang };
  }
  return null;
}

// ---- admin ------------------------------------------------------------------

export async function listQueue(prisma, { type, lang, status } = {}) {
  const types = type ? [type] : TYPES;
  for (const t of types) modelFor(prisma, t);
  if (lang && !LANGS.includes(lang)) {
    throw httpError(400, `lang must be one of ${LANGS.join(', ')}`, 'INVALID_LANG');
  }
  if (status && !STATUSES.includes(status)) {
    throw httpError(400, `status must be one of ${STATUSES.join(', ')}`, 'INVALID_STATUS');
  }
  const where = { ...(lang ? { lang } : {}), ...(status ? { reviewStatus: status } : {}) };

  const items = [];
  for (const t of types) {
    const model = modelFor(prisma, t);
    const rows = await model.findMany({ where, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }] });
    for (const row of rows) {
      const item = { type: t, ...row };
      if (row.lang !== 'en') {
        item.master = await model.findFirst({
          where: t === 'exercise'
            ? { exerciseId: row.exerciseId, lang: 'en' }
            : { slug: row.slug, lang: 'en' },
        });
      }
      if (t === 'exercise') {
        const ex = await prisma.exercise.findUnique({
          where: { id: row.exerciseId },
          select: { name: true },
        });
        item.exerciseName = ex?.name ?? null;
      }
      items.push(item);
    }
  }
  return { items, total: items.length };
}

function cleanList(field, value) {
  if (!Array.isArray(value)) throw httpError(400, `${field} must be a list of lines`, 'INVALID_FIELD');
  const lines = value.map((v) => (typeof v === 'string' ? v.trim() : v));
  if (lines.length === 0 || lines.length > MAX_LIST_ITEMS
    || lines.some((v) => typeof v !== 'string' || v.length === 0 || v.length > MAX_LINE)) {
    throw httpError(400, `${field} must have 1-${MAX_LIST_ITEMS} non-empty lines of at most ${MAX_LINE} characters`, 'INVALID_FIELD');
  }
  return lines;
}

function cleanText(field, value, max) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > max) {
    throw httpError(400, `${field} must be 1-${max} characters`, 'INVALID_FIELD');
  }
  return value.trim();
}

/// Only the content itself is editable. Status, reviewer, approval time,
/// version, language and the row's identity never come from the client — an
/// edit that could also set `reviewStatus: 'approved'` would be a way around
/// the review gate.
export function pickEditable(type, updates) {
  const src = updates && typeof updates === 'object' ? updates : {};
  const data = {};
  if (type === 'exercise') {
    for (const f of EXERCISE_FIELDS) if (src[f] !== undefined) data[f] = cleanList(f, src[f]);
  } else {
    if (src.title !== undefined) data.title = cleanText('title', src.title, MAX_TITLE);
    if (src.body !== undefined) data.body = cleanText('body', src.body, MAX_BODY);
  }
  if (Object.keys(data).length === 0) {
    const allowed = type === 'exercise' ? EXERCISE_FIELDS : ARTICLE_FIELDS;
    throw httpError(400, `Nothing to update. Editable fields: ${allowed.join(', ')}`, 'NOTHING_TO_UPDATE');
  }
  return data;
}

export async function editContent(prisma, { type, id, updates }) {
  const model = modelFor(prisma, type);
  const data = pickEditable(type, updates);
  const existing = await model.findUnique({ where: { id } });
  if (!existing) throw httpError(404, 'Content not found', 'NOT_FOUND');
  return model.update({
    where: { id },
    data: {
      ...data,
      reviewStatus: 'pending',
      reviewedBy: null,
      approvedAt: null,
      version: { increment: 1 },
    },
  });
}

export async function reviewContent(prisma, { type, id, decision, reviewerId, expectedVersion }) {
  const model = modelFor(prisma, type);
  if (!['approve', 'reject'].includes(decision)) {
    throw httpError(400, 'decision must be approve or reject', 'INVALID_DECISION');
  }
  if (!Number.isInteger(reviewerId)) throw httpError(401, 'Unauthorized', 'UNAUTHORIZED');
  const existing = await model.findUnique({ where: { id } });
  if (!existing) throw httpError(404, 'Content not found', 'NOT_FOUND');
  if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== existing.version) {
    throw httpError(409, 'This item changed since you opened it. Reload and review the new version.', 'CONTENT_CHANGED');
  }
  const approve = decision === 'approve';
  return model.update({
    where: { id },
    data: {
      reviewStatus: approve ? 'approved' : 'rejected',
      reviewedBy: reviewerId,
      approvedAt: approve ? new Date() : null,
    },
  });
}
