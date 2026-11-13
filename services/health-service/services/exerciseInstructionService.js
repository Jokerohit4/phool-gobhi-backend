import { readFileSync } from 'node:fs';
import { isExerciseMediaUrl } from '../utils/exerciseMedia.js';

const profiles = JSON.parse(readFileSync(new URL('../prisma/exerciseInstructionFallbacks.json', import.meta.url), 'utf8'));
for (const [name, profile] of Object.entries(profiles)) {
  if (!['repdb_free_in_app', 'phool_gobhi_original'].includes(profile.rights)
    || profile.language !== 'en' || profile.reviewType !== 'implementation_content_check'
    || !profile.equipment || !profile.attribution || !profile.reviewNotes
    || (profile.mode != null && (profile.mode !== 'replace_incompatible_source' || profile.rights !== 'phool_gobhi_original' || !profile.replacementReason))
    || (profile.replaceSourceLanguages != null && (!isExerciseMediaUrl(profile.replacementSourceUrl)
      || !Array.isArray(profile.replaceSourceLanguages) || !profile.replaceSourceLanguages.length
      || !profile.replaceSourceLanguages.every((language) => ['en', 'hi'].includes(language))))
    || !Array.isArray(profile.instructions) || profile.instructions.length < 3
    || !profile.instructions.every((step) => typeof step === 'string' && step.trim())
    || (profile.rights === 'repdb_free_in_app' && (!isExerciseMediaUrl(profile.sourceUrl)
      || !isExerciseMediaUrl(profile.licenseUrl) || !profile.attribution.includes('Exercise data by RepDB')))) {
    throw Error(`Invalid instruction fallback: ${name}`);
  }
}

export function withExerciseInstructionFallback(exercise) {
  if (exercise.createdByUserId != null) return exercise;
  const profile = profiles[exercise.name];
  if (!profile || profile.equipment !== exercise.equipment) return exercise;
  if (exercise.sourceInstructions?.length && profile.mode !== 'replace_incompatible_source') return exercise;
  if (exercise.sourceInstructions?.length && profile.replacementSourceUrl
    && exercise.sourceInstructionUrl !== profile.replacementSourceUrl) return exercise;
  if (profile.mode === 'replace_incompatible_source' && exercise.sourceInstructions?.length
    && exercise.sourceInstructionLanguage && exercise.sourceInstructionLanguage !== 'en'
    && !profile.replaceSourceLanguages?.includes(exercise.sourceInstructionLanguage)) return exercise;
  return {
    ...exercise,
    sourceInstructions: profile.instructions,
    sourceInstructionLanguage: profile.language,
    sourceInstructionAttribution: profile.attribution,
    sourceInstructionUrl: profile.sourceUrl,
    sourceMetadata: { ...exercise.sourceMetadata,
      ...(profile.mode === 'replace_incompatible_source' ? { supersededInstructionSource: {
        sourceUrl: exercise.sourceInstructionUrl ?? null, attribution: exercise.sourceInstructionAttribution ?? null,
        language: exercise.sourceInstructionLanguage ?? null, reason: profile.replacementReason,
      } } : {}), instructionFallback: {
      provider: profile.provider, sourceId: profile.sourceId, rights: profile.rights,
      licenseUrl: profile.licenseUrl, reviewType: profile.reviewType,
    } },
  };
}
