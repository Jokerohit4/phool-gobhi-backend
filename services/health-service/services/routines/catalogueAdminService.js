// Staff-side management of the routine catalogue (gobhi role). Staff create and
// edit system routines here; users never write them (the user-facing template
// routes are scoped to the caller's own rows).
//
// Rules this enforces on every save, so the catalogue cannot get into the state
// the app-side contract tests used to guard:
//   - every exercise is a global library exercise
//   - a rep-counted exercise has reps, a timed one has seconds
//   - at most 6 main exercises (past that a session stops being training)
//   - category / goal / level are from the known sets, English text is present
// Routines are unpublished, never deleted: plan days, sessions and users'
// schedules reference them.
import prisma from '../../db/prisma.js';
import { structuredExercises } from '../routineStructure.js';
import { ROUTINE_GOALS } from '../../utils/workoutGoals.js';
import { CATEGORIES, LEVELS, TEXT_LANGS } from './catalogueSeed.js';
import { estimateRoutineMinutes } from './estimate.js';
import { catalogueCache, includeExercises } from './catalogueService.js';
import { systemTemplatesCache } from '../templateService.js';

export const MAX_MAIN_EXERCISES = 6;
export const CONFIG_CONFLICT = 'CONFIG_CONFLICT';

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const withTexts = { ...includeExercises, texts: true };

function evict() {
  catalogueCache.invalidate('catalogue');
  systemTemplatesCache.invalidate('system');
}

export async function adminListTemplatesService() {
  return prisma.workoutTemplate.findMany({
    where: { isSystem: true, userId: null },
    include: withTexts,
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
}

export async function adminGetTemplateService(id) {
  const row = await prisma.workoutTemplate.findFirst({
    where: { id, isSystem: true, userId: null }, include: withTexts,
  });
  if (!row) throw fail(404, 'Routine not found');
  return row;
}

function parseExpectedUpdatedAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw fail(400, 'expectedUpdatedAt must be an ISO date');
  return d;
}

function cleanText(lang, t) {
  const name = typeof t?.name === 'string' ? t.name.trim() : '';
  if (!name || name.length > 120) throw fail(400, `${lang} name is required (up to 120 characters)`);
  const optional = (v, label, max) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || v.length > max) throw fail(400, `${lang} ${label} must be text up to ${max} characters`);
    return v.trim() || null;
  };
  return { name, description: optional(t.description, 'description', 400), guidance: optional(t.guidance, 'guidance', 600) };
}

async function validatedRows(exercises) {
  const rows = structuredExercises(exercises);
  const ids = [...new Set(rows.map((r) => r.exerciseId))];
  const found = await prisma.exercise.findMany({
    where: { id: { in: ids }, createdByUserId: null },
    select: { id: true, name: true, loggingType: true },
  });
  const byId = new Map(found.map((e) => [e.id, e]));
  for (const row of rows) {
    const ex = byId.get(row.exerciseId);
    if (!ex) throw fail(400, `Exercise ${row.exerciseId} is not in the exercise library`);
    const counted = ex.loggingType === 'sets_reps_weight';
    if (counted && row.targetReps == null) throw fail(400, `${ex.name} is counted in reps and needs a rep target`);
    if (!counted && row.targetDurationSeconds == null) throw fail(400, `${ex.name} is timed and needs a duration`);
  }
  const main = rows.filter((r) => r.phase === 'main').length;
  if (main === 0) throw fail(400, 'A routine needs at least one main exercise');
  if (main > MAX_MAIN_EXERCISES) throw fail(400, `A routine can have at most ${MAX_MAIN_EXERCISES} main exercises`);
  return rows;
}

const rowData = (row, i) => ({
  exerciseId: row.exerciseId,
  order: i,
  phase: row.phase,
  instructions: row.instructions,
  targetSets: row.targetSets,
  targetReps: row.targetReps ?? null,
  targetDurationSeconds: row.targetDurationSeconds ?? null,
  restSeconds: row.restSeconds ?? null,
  supersetGroup: row.supersetGroup ?? null,
  repMin: row.repMin ?? null,
  repMax: row.repMax ?? null,
  targetWeightKg: row.targetWeightKg ?? null,
});

const estimateFrom = (rows) => estimateRoutineMinutes(rows.map((r) => ({
  phase: r.phase, sets: r.targetSets, reps: r.targetReps ?? undefined,
  seconds: r.targetDurationSeconds ?? undefined, rest: r.restSeconds ?? undefined,
})));

function metaFrom(body, { creating }) {
  const meta = {};
  const set = (field, ok, label) => {
    if (body[field] === undefined) return;
    if (!ok(body[field])) throw fail(400, label);
    meta[field] = body[field];
  };
  set('category', (v) => CATEGORIES.includes(v), `category must be one of ${CATEGORIES.join(', ')}`);
  set('goal', (v) => ROUTINE_GOALS.includes(v), `goal must be one of ${ROUTINE_GOALS.join(', ')}`);
  set('level', (v) => LEVELS.includes(v), `level must be one of ${LEVELS.join(', ')}`);
  set('sortOrder', (v) => Number.isInteger(v) && v >= 0 && v <= 100000, 'sortOrder must be a whole number');
  set('isPublished', (v) => typeof v === 'boolean', 'isPublished must be true or false');
  if (creating) {
    for (const field of ['category', 'goal', 'level']) {
      if (meta[field] === undefined) throw fail(400, `${field} is required`);
    }
  }
  return meta;
}

/**
 * Create (no id) or update (id) a catalogue routine. `body.texts` is
 * { en, hi?, hinglish? }; on update a language set to null is removed (English
 * cannot be), and omitted languages are left as they are. `body.exercises`, when
 * present, replaces the whole row list.
 */
export async function adminSaveTemplateService(actorId, body, id = null) {
  const creating = id === null;
  const meta = metaFrom(body || {}, { creating });
  const expected = parseExpectedUpdatedAt(body?.expectedUpdatedAt);

  const texts = {};
  for (const [lang, value] of Object.entries(body?.texts ?? {})) {
    if (!TEXT_LANGS.includes(lang)) throw fail(400, `Unknown language ${lang}`);
    if (value === null) {
      if (lang === 'en') throw fail(400, 'English text cannot be removed');
      texts[lang] = null;
    } else {
      texts[lang] = cleanText(lang, value);
    }
  }
  if (creating && !texts.en) throw fail(400, 'English text is required');
  const rows = body?.exercises === undefined ? null : await validatedRows(body.exercises);
  if (creating && !rows) throw fail(400, 'exercises are required');

  let key;
  if (creating) {
    key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!/^[a-z0-9_]{3,60}$/.test(key)) throw fail(400, 'key must be 3-60 characters of a-z, 0-9 and _');
  }

  const saved = await prisma.$transaction(async (tx) => {
    let templateId = id;
    if (creating) {
      if (await tx.workoutTemplate.findUnique({ where: { key } })) throw fail(409, 'A routine with this key already exists');
      const clash = await tx.workoutTemplate.findFirst({ where: { isSystem: true, name: texts.en.name } });
      if (clash) throw fail(409, 'A routine with this English name already exists');
      const created = await tx.workoutTemplate.create({
        data: {
          userId: null, isSystem: true, key, ...meta, updatedBy: actorId,
          name: texts.en.name, description: texts.en.description,
          estMinutes: estimateFrom(rows),
          exercises: { create: rows.map(rowData) },
        },
      });
      templateId = created.id;
    } else {
      const current = await tx.workoutTemplate.findFirst({
        where: { id, isSystem: true, userId: null }, select: { id: true },
      });
      if (!current) throw fail(404, 'Routine not found');
      if (expected) {
        // Atomic compare-and-set: succeeds only if nobody saved since the form loaded.
        const claimed = await tx.workoutTemplate.updateMany({
          where: { id, updatedAt: expected }, data: { updatedBy: actorId },
        });
        if (claimed.count === 0) {
          const latest = await tx.workoutTemplate.findUnique({ where: { id }, select: { updatedAt: true } });
          throw fail(409, 'This routine was changed by someone else. Reload and try again.', {
            errorCode: CONFIG_CONFLICT, currentUpdatedAt: latest?.updatedAt?.toISOString?.() ?? null,
          });
        }
      }
      if (texts.en) {
        // The row's own name/description mirror the English text.
        meta.name = texts.en.name;
        meta.description = texts.en.description;
      }
      if (rows) {
        await tx.templateExercise.deleteMany({ where: { templateId: id } });
        await tx.templateExercise.createMany({ data: rows.map((r, i) => ({ templateId: id, ...rowData(r, i) })) });
        meta.estMinutes = estimateFrom(rows);
      }
      await tx.workoutTemplate.update({
        where: { id }, data: { ...meta, updatedBy: actorId, version: { increment: 1 } },
      });
    }
    for (const [lang, t] of Object.entries(texts)) {
      if (t === null) {
        await tx.workoutTemplateText.deleteMany({ where: { templateId, lang } });
      } else {
        await tx.workoutTemplateText.upsert({
          where: { templateId_lang: { templateId, lang } }, create: { templateId, lang, ...t }, update: t,
        });
      }
    }
    return tx.workoutTemplate.findUnique({ where: { id: templateId }, include: withTexts });
  });
  evict();
  return saved;
}
