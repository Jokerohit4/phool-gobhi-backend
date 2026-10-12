import { PrismaClient } from '@prisma/client';
import * as contentService from '../services/contentService.js';

const prisma = new PrismaClient();

// Thin adapter over contentService (B15): parse, delegate, wrap errors. The
// review rules live in the service so the tests pin them without HTTP.
//
//   GET  /content/exercises/:exerciseId?lang=   200 {data:{steps,feelCues,mistakes,difficulty,lang}} | 404
//   GET  /content/articles?kind=&lang=          200 {data:[{slug,title,kind}]}
//   GET  /content/articles/:slug?lang=          200 {data:{slug,title,body,lang}} | 404
//   GET  /content/admin/queue?type=&lang=&status=  200 {data:{items,total}}
//   PUT  /content/admin/exercises/:id           200 {data:row}
//   PUT  /content/admin/articles/:id            200 {data:row}
//   POST /content/admin/:type/:id/approve       200 {data:row}   body {version?}
//   POST /content/admin/:type/:id/reject        200 {data:row}   body {version?}

function fail(res, err, tag) {
  const status = err.status || 500;
  if (status >= 500) console.error(`[${tag}]`, err);
  return res.status(status).json({
    error: status >= 500 ? 'Server error' : (err.error || err.message),
    code: err.code,
  });
}

function positiveInt(raw) {
  const s = String(raw ?? '');
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function badId(res) {
  return res.status(400).json({ error: 'id must be a positive integer', code: 'INVALID_ID' });
}

export const getExercise = async (req, res) => {
  const exerciseId = positiveInt(req.params.exerciseId);
  if (!exerciseId) return badId(res);
  try {
    const data = await contentService.getExerciseContent(prisma, exerciseId, req.query?.lang);
    if (!data) return res.status(404).json({ error: 'No instructions for this exercise yet', code: 'NOT_FOUND' });
    return res.json({ data });
  } catch (err) {
    return fail(res, err, 'content');
  }
};

export const listArticles = async (req, res) => {
  try {
    const data = await contentService.listArticles(prisma, {
      kind: req.query?.kind,
      lang: req.query?.lang,
    });
    return res.json({ data });
  } catch (err) {
    return fail(res, err, 'content');
  }
};

export const getArticle = async (req, res) => {
  try {
    const data = await contentService.getArticle(prisma, String(req.params.slug), req.query?.lang);
    if (!data) return res.status(404).json({ error: 'Article not found', code: 'NOT_FOUND' });
    return res.json({ data });
  } catch (err) {
    return fail(res, err, 'content');
  }
};

export const adminQueue = async (req, res) => {
  try {
    const data = await contentService.listQueue(prisma, {
      type: req.query?.type || undefined,
      lang: req.query?.lang || undefined,
      status: req.query?.status || undefined,
    });
    return res.json({ data });
  } catch (err) {
    return fail(res, err, 'content-admin');
  }
};

const edit = (type) => async (req, res) => {
  const id = positiveInt(req.params.id);
  if (!id) return badId(res);
  try {
    const data = await contentService.editContent(prisma, { type, id, updates: req.body });
    return res.json({ data });
  } catch (err) {
    return fail(res, err, 'content-admin');
  }
};

export const editExercise = edit('exercise');
export const editArticle = edit('article');

const review = (decision) => async (req, res) => {
  const id = positiveInt(req.params.id);
  if (!id) return badId(res);
  const rawVersion = req.body?.version;
  let expectedVersion;
  if (rawVersion !== undefined && rawVersion !== null) {
    expectedVersion = positiveInt(rawVersion);
    if (!expectedVersion) return res.status(400).json({ error: 'version must be a positive integer', code: 'INVALID_VERSION' });
  }
  try {
    const data = await contentService.reviewContent(prisma, {
      type: req.params.type,
      id,
      decision,
      // The reviewer is whoever the gateway authenticated — never a body field.
      reviewerId: req.userId,
      expectedVersion,
    });
    return res.json({ data });
  } catch (err) {
    return fail(res, err, 'content-admin');
  }
};

export const approve = review('approve');
export const reject = review('reject');
