import { readFileSync } from 'node:fs';
import { isExerciseMediaUrl, isExercisePoseGifUrl } from '../utils/exerciseMedia.js';
const references = JSON.parse(readFileSync(new URL('../prisma/exercisePoseGifs.json', import.meta.url), 'utf8'));
for (const [name, row] of Object.entries(references)) {
  if (!['pose_sequence', 'hold_reference', 'schematic_pose_sequence'].includes(row.kind) || !['public_domain', 'cc_by_sa_4', 'repdb_free_in_app', 'phool_gobhi_original'].includes(row.rights) || !row.userApprovedPoseSequences
    || (row.rights === 'cc_by_sa_4' && (row.licenseUrl !== 'https://creativecommons.org/licenses/by-sa/4.0/' || !row.attribution.includes('derivatives licensed CC BY-SA 4.0')))
    || (row.rights === 'repdb_free_in_app' && (!row.attribution.includes('Exercise data by RepDB') || !row.licenseUrl.startsWith('https://github.com/RepDB/exercise-dataset/blob/')))
    || (row.rights === 'phool_gobhi_original' && (row.reviewStatus !== 'approved_reference' || row.kind !== 'schematic_pose_sequence'))
    || row.frameCount < (row.kind === 'hold_reference' ? 1 : 2) || row.sourceImageUrls?.length !== row.frameCount
    || row.sourceImageSha256?.length !== row.frameCount || !row.assetSha256 || !row.attribution
    || !isExercisePoseGifUrl(row.gifUrl) || !isExerciseMediaUrl(row.sourceUrl)) {
    throw new Error(`Incomplete pose GIF reference: ${name}`);
  }
}

export function withExercisePoseGif(exercise) {
  if (exercise.createdByUserId != null) return exercise;
  const row = references[exercise.name];
  const existing = isExerciseMediaUrl(exercise.demoGifUrl);
  if (!row || row.equipment !== exercise.equipment) return exercise;
  // Real motion always wins, including when a pose GIF was backfilled earlier.
  if (existing && !isExercisePoseGifUrl(exercise.demoGifUrl)) return { ...exercise, demoGifKind: 'motion' };
  return {
    ...exercise, demoGifUrl: row.gifUrl, demoGifKind: row.kind, mediaAttribution: row.attribution,
    demoImageUrl: isExerciseMediaUrl(exercise.demoImageUrl) ? exercise.demoImageUrl : row.previewImageUrl ?? null,
    sourceImageUrls: exercise.sourceImageUrls?.length ? exercise.sourceImageUrls : row.previewImageUrl ? [row.previewImageUrl] : [],
    sourceAttribution: exercise.sourceImageUrls?.length ? exercise.sourceAttribution : row.attribution,
    sourceMetadata: { ...exercise.sourceMetadata, poseSequence: {
      kind: row.kind, frameCount: row.frameCount, sourceUrl: row.sourceUrl,
      sourceImageUrls: row.sourceImageUrls, licenseUrl: row.licenseUrl, assetSha256: row.assetSha256,
    } },
  };
}
