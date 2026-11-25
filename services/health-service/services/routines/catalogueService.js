// The routine catalogue as the customer app sees it: published system
// templates with localized text, derived location fit, and a server-side clone
// into the caller's own routines.
import prisma from '../../db/prisma.js';
import { createTtlCache } from '../../utils/ttlCache.js';
import { normaliseLang } from '../contentService.js';
import { equipmentFit } from '../homeSetup.js';
import { locationFit } from './locationFit.js';

export const includeExercises = {
  exercises: { include: { exercise: true }, orderBy: { order: 'asc' } },
};

// One cached copy of every published catalogue routine (all languages), shared
// by every user. Short on purpose: an admin edit on another instance shows up
// within a minute, and writes on this instance evict it immediately.
export const CATALOGUE_TTL_MS = 60_000;
export const catalogueCache = createTtlCache({ ttlMs: CATALOGUE_TTL_MS, maxEntries: 1 });
const loadCatalogue = () => catalogueCache.get('catalogue', () => prisma.workoutTemplate.findMany({
  where: { isSystem: true, isPublished: true, userId: null, key: { not: null } },
  include: { ...includeExercises, texts: true },
  orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
}));

/** The text for a language, falling back to English, then to the template's own name. */
export function pickText(template, lang) {
  const texts = template.texts ?? [];
  const wanted = texts.find((t) => t.lang === lang) ?? texts.find((t) => t.lang === 'en');
  return {
    lang: wanted?.lang ?? 'en',
    name: wanted?.name ?? template.name,
    description: wanted?.description ?? template.description ?? null,
    guidance: wanted?.guidance ?? null,
  };
}

export function shapeCatalogueRoutine(template, lang, profile) {
  const text = pickText(template, lang);
  const { texts, ...row } = template;
  const mainCount = (template.exercises ?? []).filter((e) => (e.phase ?? 'main') === 'main').length;
  return {
    ...row,
    name: text.name,
    description: text.description,
    guidance: text.guidance,
    lang: text.lang,
    mainCount,
    ...locationFit(template),
    equipmentFit: equipmentFit(template, profile),
  };
}

export async function listCatalogueService(userId, langParam) {
  const lang = normaliseLang(langParam);
  const [templates, profile] = await Promise.all([
    loadCatalogue(),
    // Best-effort: a failed read costs the fit badge, never the list.
    (async () => prisma.personalisationProfile.findUnique({
      where: { userId }, select: { homeEquipment: true, homeSetupAt: true },
    }))().catch(() => null),
  ]);
  return templates.map((t) => shapeCatalogueRoutine(t, lang, profile));
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

// "Chest · shoulders · triceps" + the goal's coaching sentence, the way the app
// wrote the guidance into a copied routine's description.
export function copiedDescription(text) {
  const parts = [text.description, text.guidance].filter(Boolean).map((s) => s.trim());
  if (parts.length === 0) return null;
  const [first, ...rest] = parts;
  const lead = rest.length > 0 && !/[.!?।]$/.test(first) ? `${first}.` : first;
  return [lead, ...rest].join(' ');
}

/**
 * Copy a published catalogue routine into the caller's own routines. The
 * exercise ids are already resolved, so unlike the old client-side copy there
 * is no name matching to fail halfway. The copy is independent: later edits to
 * the catalogue never change it.
 */
export async function cloneTemplateService(userId, templateId, langParam) {
  const lang = normaliseLang(langParam);
  const source = await prisma.workoutTemplate.findFirst({
    where: { id: templateId, isSystem: true, isPublished: true, userId: null },
    include: { ...includeExercises, texts: true },
  });
  if (!source) throw httpError(404, 'Routine not found');
  const text = pickText(source, lang);
  return prisma.workoutTemplate.create({
    data: {
      userId,
      name: text.name,
      description: copiedDescription(text),
      category: source.category,
      goal: source.goal,
      level: source.level,
      estMinutes: source.estMinutes,
      exercises: {
        create: source.exercises.map((e, i) => ({
          exerciseId: e.exerciseId,
          order: i,
          phase: e.phase,
          instructions: e.instructions,
          targetSets: e.targetSets,
          targetReps: e.targetReps,
          targetDurationSeconds: e.targetDurationSeconds,
          restSeconds: e.restSeconds,
          supersetGroup: e.supersetGroup,
          repMin: e.repMin,
          repMax: e.repMax,
          targetWeightKg: e.targetWeightKg,
        })),
      },
    },
    include: includeExercises,
  });
}
