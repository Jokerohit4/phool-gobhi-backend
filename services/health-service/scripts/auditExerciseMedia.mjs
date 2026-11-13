// Local content inventory only: no database writes or network verification.
// Run from health-service: node scripts/auditExerciseMedia.mjs > exercise-media-audit.json
import { readFileSync } from 'node:fs';
import { demoStatus, isExerciseMediaUrl } from '../utils/exerciseMedia.js';
import { withExerciseSource } from '../services/exerciseSourceService.js';

const read = (name) => JSON.parse(readFileSync(new URL(`../prisma/${name}`, import.meta.url), 'utf8'));
const catalogue = read('exerciseCatalogue.json');
const media = read('exerciseMedia.json');
const videos = read('exerciseVideos.json');
const sources = read('exerciseSources.json');
const concerns = {
  jYX5FpYZA7c: 'Title promotes an alternative to planks; review movement match before using as a plank tutorial.',
  j19PaQSE_Nc: 'Title specifies cross-body hammer curls; review against the catalogue hammer curl variant.',
  ENsp0DEryrM: 'Title compares raise variants; verify that it teaches the catalogue movement.',
};
const rows = catalogue.map((exercise) => {
  const entry = media[exercise.name];
  const tutorials = videos.filter((video) => video.exercise === exercise.name);
  const effective = withExerciseSource({ ...exercise, demoGifUrl: entry?.gifUrl, demoImageUrl: entry?.imageUrl });
  return {
    name: exercise.name,
    muscleGroup: exercise.muscleGroup,
    equipment: exercise.equipment,
    demoStatus: demoStatus({ gifUrl: effective.demoGifUrl }),
    legacyMediaStatus: demoStatus(entry),
    sourceImageCount: effective.sourceImageUrls?.length ?? 0,
    sourceInstructionCount: effective.sourceInstructions?.length ?? 0,
    demoUrl: effective.demoGifUrl ?? null,
    imageStatus: !effective.demoImageUrl ? 'missing' : isExerciseMediaUrl(effective.demoImageUrl) ? 'needs_review' : 'invalid_url',
    tutorialStatus: tutorials.length ? tutorials.some((video) => concerns[video.youtubeVideoId]) ? 'check_movement_match' : 'needs_review' : 'missing',
    tutorialLanguages: [...new Set(tutorials.map((v) => v.languageCode ?? 'en'))],
    tutorials: tutorials.map(({ youtubeVideoId, title, channelName }) => ({ youtubeVideoId, title, channelName })),
    reviewNote: tutorials.map((video) => concerns[video.youtubeVideoId]).filter(Boolean).join(' ') || null,
  };
});
const names = new Set(catalogue.map((e) => e.name));
console.log(JSON.stringify({
  scope: 'Local seed files only. URLs are syntax-checked, not verified live. Every existing asset still needs movement review. Database content may differ.',
  summary: {
    exercises: rows.length,
    demoUrlsToReview: rows.filter((r) => r.demoStatus === 'needs_review').length,
    invalidDemoUrls: rows.filter((r) => r.demoStatus === 'invalid_url').length,
    missingDemoUrls: rows.filter((r) => r.demoStatus === 'missing').length,
    exercisesWithTutorialSeeds: rows.filter((r) => r.tutorials.length).length,
    missingTutorials: rows.filter((r) => !r.tutorials.length).length,
    exercisesWithSourcePhotos: rows.filter((r) => r.sourceImageCount > 0).length,
    exercisesWithSourceInstructions: rows.filter((r) => r.sourceInstructionCount > 0).length,
    mediaEntriesOutsideCatalogue: Object.keys(media).filter((name) => !names.has(name)).length,
  },
  exercises: rows,
}, null, 2));
