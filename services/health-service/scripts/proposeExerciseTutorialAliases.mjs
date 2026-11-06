// Candidate-only: do not infer exercise equivalence from names alone.
import { readFileSync, writeFileSync } from 'node:fs';
import { withExerciseSource } from '../services/exerciseSourceService.js';
const read = (name) => JSON.parse(readFileSync(new URL(`../prisma/${name}`, import.meta.url), 'utf8'));
const videos = read('exerciseVideos.json');
const media = read('exerciseMedia.json');
const rows = read('exerciseCatalogue.json').map((row) => withExerciseSource({ ...row, demoGifUrl: media[row.name]?.gifUrl, demoImageUrl: media[row.name]?.imageUrl }));
const proposals = [];
for (const exercise of rows.filter((row) => !videos.some((video) => video.exercise === row.name))) {
  for (const known of rows.filter((row) => row.equipment === exercise.equipment && videos.some((video) => video.exercise === row.name))) {
    const sameInstructions = JSON.stringify(exercise.sourceInstructions) === JSON.stringify(known.sourceInstructions);
    const sameAsset = exercise.demoGifUrl && exercise.demoGifUrl === known.demoGifUrl;
    const sameFreeSource = exercise.sourceInstructionUrl?.includes('/yuhonas/free-exercise-db/') && exercise.sourceInstructionUrl === known.sourceInstructionUrl;
    if ((sameInstructions && exercise.sourceInstructions?.length) || sameAsset || sameFreeSource) {
      proposals.push({ exercise: exercise.name, equipment: exercise.equipment, fromExercise: known.name,
        youtubeVideoId: videos.find((video) => video.exercise === known.name).youtubeVideoId,
        sameInstructions, sameAsset, sameFreeSource: Boolean(sameFreeSource),
        setup: exercise.sourceInstructions?.slice(0, 2), knownSetup: known.sourceInstructions?.slice(0, 2),
        status: 'requires_explicit_variant_review' });
    }
  }
}
writeFileSync(new URL('../../../docs/exercise-dev/tutorial-alias-proposals.json', import.meta.url), JSON.stringify(proposals, null, 2) + '\n');
console.log(JSON.stringify({ proposals: proposals.length }));
