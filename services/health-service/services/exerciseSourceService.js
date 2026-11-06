import { readFileSync } from 'node:fs';
import { isExerciseMediaUrl, isExercisePoseGifUrl } from '../utils/exerciseMedia.js';
import { withExerciseReference } from './exerciseReferenceService.js';
import { withDerivedExerciseMedia } from './exerciseDerivedMediaService.js';
import { withExercisePoseGif } from './exercisePoseGifService.js';
import { withExerciseInstructionFallback } from './exerciseInstructionService.js';
import { applyExerciseContentBundle, validateExerciseContentBundles } from '../utils/exerciseContentBundle.js';
const sources = JSON.parse(readFileSync(new URL('../prisma/exerciseSources.json', import.meta.url), 'utf8'));
const supplements = JSON.parse(readFileSync(new URL('../prisma/exerciseSupplements.json', import.meta.url), 'utf8'));
const originals = new Map(JSON.parse(readFileSync(new URL('../prisma/sources/free-exercise-db.json', import.meta.url), 'utf8')).map((entry) => [entry.id, entry]));
const ownedContent = JSON.parse(readFileSync(new URL('../prisma/ownedExerciseContent.json', import.meta.url), 'utf8'));
validateExerciseContentBundles(Object.values(ownedContent), JSON.parse(readFileSync(new URL('../prisma/exerciseCatalogue.json', import.meta.url), 'utf8')));
const revision = 'a859101d633a01c4a1a920d6a8ce41dabba0705f';
const imageBase = `https://raw.githubusercontent.com/yuhonas/free-exercise-db/${revision}/exercises/`;
export const EXERCISE_SOURCE_ATTRIBUTION = 'free-exercise-db (Public Domain / Unlicense)';

// Exact, generated canonical mappings only. Private exercises never inherit
// public instructions or images merely because their display names match.
export function withExerciseSource(exercise, lang = 'en') {
  if (exercise.createdByUserId != null) return exercise;
  const enrich = (row) => {
    const referenced = withExerciseReference(row);
    const cleaned = Array.isArray(referenced.sourceInstructions) ? {
      ...referenced, sourceInstructions: referenced.sourceInstructions.filter((step) => typeof step === 'string' && step.trim()),
    } : referenced;
    return applyExerciseContentBundle(withExercisePoseGif(withDerivedExerciseMedia(withExerciseInstructionFallback(cleaned))), ownedContent[exercise.name], lang);
  };
  const mapped = sources[exercise.name];
  const extra = supplements[exercise.name];
  const source = mapped?.equipment === exercise.equipment ? mapped : null;
  const supplement = extra?.equipment === exercise.equipment ? extra : null;
  if (!source && !supplement) return enrich(exercise);
  const original = originals.get(source?.sourceId);
  const freePhotos = source?.images.map((path) => imageBase + path.split('/').map(encodeURIComponent).join('/')) ?? [];
  const sourceImageUrls = freePhotos.length ? freePhotos : supplement ? [supplement.imageUrl] : [];
  const requested = String(lang ?? 'en').replace('_', '-').toLowerCase();
  // Hinglish is not Devanagari Hindi; retain the labelled English fallback.
  const requestedLanguage = requested === 'hi-latn' ? 'en' : requested.split('-')[0];
  const translated = supplement?.instructionsByLanguage[requestedLanguage];
  const useFreeInstructions = requestedLanguage === 'en' && source?.instructions.length;
  const sourceInstructions = useFreeInstructions ? source.instructions : translated?.length ? translated
    : source?.instructions.length ? source.instructions : supplement?.instructionsByLanguage.en ?? [];
  const sourceInstructionLanguage = useFreeInstructions || !translated?.length ? 'en' : requestedLanguage;
  const usesSupplementInstructions = supplement && !useFreeInstructions && (translated?.length || !source?.instructions.length);
  const existingGif = isExerciseMediaUrl(exercise.demoGifUrl) && !isExercisePoseGifUrl(exercise.demoGifUrl);
  const primaryMuscles = exercise.primaryMuscles?.length ? exercise.primaryMuscles
    : supplement ? [supplement.target] : [];
  const primary = new Set(primaryMuscles.map((value) => value.toLowerCase()));
  const secondaryMuscles = exercise.secondaryMuscles?.length ? exercise.secondaryMuscles
    : [...new Set(supplement?.secondaryMuscles ?? [])].filter((muscle) => !primary.has(muscle.toLowerCase()));
  return enrich({
    ...exercise,
    primaryMuscles, secondaryMuscles,
    demoGifUrl: existingGif ? exercise.demoGifUrl : supplement?.gifUrl ?? null,
    demoImageUrl: isExerciseMediaUrl(exercise.demoImageUrl) ? exercise.demoImageUrl : supplement?.imageUrl ?? sourceImageUrls[0] ?? null,
    mediaAttribution: existingGif ? exercise.mediaAttribution : supplement?.mediaAttribution ?? exercise.mediaAttribution,
    sourceImageUrls,
    sourceInstructions, sourceInstructionLanguage,
    sourceInstructionAttribution: usesSupplementInstructions ? supplement.instructionAttribution : EXERCISE_SOURCE_ATTRIBUTION,
    sourceInstructionUrl: usesSupplementInstructions ? supplement.sourceUrl
      : source ? `https://github.com/yuhonas/free-exercise-db/blob/${revision}/exercises/${encodeURIComponent(source.sourceId)}.json` : null,
    sourceAttribution: freePhotos.length ? EXERCISE_SOURCE_ATTRIBUTION : supplement?.mediaAttribution ?? EXERCISE_SOURCE_ATTRIBUTION,
    sourceUrl: supplement?.sourceUrl ?? `https://github.com/yuhonas/free-exercise-db/blob/${revision}/exercises/${encodeURIComponent(source.sourceId)}.json`,
    sourceMetadata: {
      freeExerciseDb: original ? { difficulty: original.level, force: original.force, mechanic: original.mechanic,
        category: original.category, equipment: original.equipment } : null,
      hasaneyldrm: supplement ? { sourceId: supplement.sourceId, sourceName: supplement.sourceName, category: supplement.category, bodyPart: supplement.bodyPart,
        target: supplement.target, equipment: supplement.sourceEquipment } : null,
    },
  });
}
