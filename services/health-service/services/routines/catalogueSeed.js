// Seeds the routine catalogue from prisma/catalogue/routines.json.
//
// Additive and idempotent, and safe to run on every deploy: it only ever
// CREATES what is missing. A routine whose key already exists keeps its
// exercises, name, description and every text row exactly as they are (users
// may have scheduled it, and an admin may have edited it), and only gains
// translations it does not have yet. Edit routines through the admin portal,
// not by changing this data and re-running it.
import { withCategoryPreparation, preparationExerciseNames } from './preparation.js';
import { estimateRoutineMinutes } from './estimate.js';

export const CATEGORIES = ['push', 'pull', 'legs', 'full_body', 'cardio', 'core', 'mobility'];
export const LEVELS = ['beginner', 'intermediate'];
export const TEXT_LANGS = ['en', 'hinglish', 'hi'];
// Library logging types that are counted in time rather than reps.
const REPS_TYPE = 'sets_reps_weight';

/** Every exercise name the catalogue (including generated preparation) uses. */
export function catalogueExerciseNames(routines) {
  const names = new Set(preparationExerciseNames());
  for (const r of routines) for (const e of r.exercises) names.add(e.name);
  return [...names];
}

/** Final ordered rows for one routine, preparation included. */
export function routineRows(routine) {
  return withCategoryPreparation(routine.exercises, routine.category);
}

/** Shape check for the data file itself; throws a message naming the routine. */
export function validateCatalogueData(routines) {
  const keys = new Set();
  const names = new Set();
  for (const r of routines) {
    const fail = (m) => { throw new Error(`routines.json "${r.key}": ${m}`); };
    if (!/^[a-z0-9_]{3,60}$/.test(r.key || '')) fail('key must be 3-60 chars of a-z, 0-9, _');
    if (keys.has(r.key)) fail('duplicate key');
    keys.add(r.key);
    if (!CATEGORIES.includes(r.category)) fail(`unknown category ${r.category}`);
    if (!LEVELS.includes(r.level)) fail(`unknown level ${r.level}`);
    if (!r.texts?.en?.name) fail('English name is required');
    const lower = r.texts.en.name.toLowerCase();
    if (names.has(lower)) fail(`duplicate English name ${r.texts.en.name}`);
    names.add(lower);
    for (const lang of Object.keys(r.texts)) {
      if (!TEXT_LANGS.includes(lang)) fail(`unknown language ${lang}`);
      if (!r.texts[lang].name) fail(`${lang} name is empty`);
    }
    const main = r.exercises.filter((e) => (e.phase ?? 'main') === 'main');
    if (main.length === 0) fail('needs at least one main exercise');
  }
}

function buildRow(spec, order, byName, routineKey) {
  const exercise = byName.get(spec.name);
  const isReps = exercise.loggingType === REPS_TYPE;
  if (isReps && spec.reps === undefined) {
    throw new Error(`routine ${routineKey}: "${spec.name}" is counted in reps but has no "reps"`);
  }
  if (!isReps && spec.seconds === undefined) {
    throw new Error(`routine ${routineKey}: "${spec.name}" is timed (${exercise.loggingType}) but has no "seconds"`);
  }
  return {
    exerciseId: exercise.id,
    order,
    phase: spec.phase ?? 'main',
    instructions: spec.instructions ?? null,
    targetSets: spec.sets,
    targetReps: isReps ? spec.reps : null,
    targetDurationSeconds: isReps ? null : spec.seconds,
    restSeconds: spec.rest ?? null,
  };
}

const textRow = (lang, t) => ({
  lang, name: t.name, description: t.description ?? null, guidance: t.guidance ?? null,
});

export async function seedRoutineCatalogue(prisma, routines) {
  validateCatalogueData(routines);
  const wanted = catalogueExerciseNames(routines);
  const found = await prisma.exercise.findMany({ where: { name: { in: wanted }, createdByUserId: null } });
  const byName = new Map(found.map((e) => [e.name, e]));
  const missing = wanted.filter((n) => !byName.has(n));
  if (missing.length > 0) {
    throw new Error(`seedRoutineCatalogue: missing exercises [${missing.join(', ')}] — run "node prisma/seed.js" first.`);
  }

  let created = 0;
  let textsAdded = 0;
  const skipped = [];
  for (const r of routines) {
    const existing = await prisma.workoutTemplate.findUnique({ where: { key: r.key } });
    if (existing) {
      const have = await prisma.workoutTemplateText.findMany({
        where: { templateId: existing.id }, select: { lang: true },
      });
      const haveLangs = new Set(have.map((h) => h.lang));
      const add = Object.entries(r.texts).filter(([lang]) => !haveLangs.has(lang));
      if (add.length > 0) {
        await prisma.workoutTemplateText.createMany({
          data: add.map(([lang, t]) => ({ templateId: existing.id, ...textRow(lang, t) })),
          skipDuplicates: true,
        });
        textsAdded += add.length;
      }
      continue;
    }
    const en = r.texts.en;
    // A system routine that already carries this name but no key predates the
    // catalogue and was not matched by the migration: leave it alone rather
    // than create a lookalike next to it.
    const sameName = await prisma.workoutTemplate.findFirst({ where: { isSystem: true, name: en.name } });
    if (sameName) { skipped.push(r.key); continue; }

    const rows = routineRows(r);
    await prisma.workoutTemplate.create({
      data: {
        userId: null,
        isSystem: true,
        key: r.key,
        name: en.name,
        description: en.description ?? null,
        estMinutes: estimateRoutineMinutes(rows),
        level: r.level,
        category: r.category,
        goal: r.goal ?? null,
        sortOrder: r.sortOrder ?? 0,
        isPublished: true,
        legacyListed: Boolean(r.legacy),
        exercises: { create: rows.map((row, i) => buildRow(row, i, byName, r.key)) },
        texts: { create: Object.entries(r.texts).map(([lang, t]) => textRow(lang, t)) },
      },
    });
    created++;
  }
  return { created, textsAdded, skipped, total: routines.length };
}
