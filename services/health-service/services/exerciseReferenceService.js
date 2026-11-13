import { readFileSync } from 'node:fs';
import { isExerciseMediaUrl } from '../utils/exerciseMedia.js';
const profiles = JSON.parse(readFileSync(new URL('../prisma/exerciseReferenceData.json', import.meta.url), 'utf8'));

export function withExerciseReference(exercise) {
  if (exercise.createdByUserId != null) return exercise;
  const profile = profiles[exercise.name];
  if (!profile || profile.equipment !== exercise.equipment) return exercise;
  const needsImages = !exercise.sourceImageUrls?.length;
  const needsInstructions = !exercise.sourceInstructions?.length && profile.instructions.length;
  return {
    ...exercise,
    demoGifUrl: isExerciseMediaUrl(exercise.demoGifUrl) ? exercise.demoGifUrl : null,
    sourceImageUrls: needsImages ? profile.images : exercise.sourceImageUrls,
    demoImageUrl: isExerciseMediaUrl(exercise.demoImageUrl) ? exercise.demoImageUrl : profile.images[0] ?? null,
    sourceAttribution: needsImages ? profile.imageAttribution : exercise.sourceAttribution,
    sourceInstructions: needsInstructions ? profile.instructions : exercise.sourceInstructions ?? [],
    sourceInstructionAttribution: needsInstructions ? profile.instructionAttribution : exercise.sourceInstructionAttribution,
    sourceInstructionUrl: needsInstructions ? profile.instructionSourceUrl : exercise.sourceInstructionUrl,
    sourceInstructionLanguage: needsInstructions ? 'en' : exercise.sourceInstructionLanguage ?? 'en',
    secondaryMuscles: exercise.secondaryMuscles?.length ? exercise.secondaryMuscles : profile.secondaryMuscles,
    demoVideos: [...(exercise.demoVideos ?? []), ...profile.demoVideos],
    sourceMetadata: { ...exercise.sourceMetadata, references: { providers: profile.providers, classification: profile.classification, scope: profile.reason } },
  };
}
