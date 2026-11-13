// Source-backed instructional references. Selected movements/equipment and
// actual title/channel/duration metadata are retained in prisma/sources/.
// Search candidates are reviewed separately and are never seeded directly.
// Run with:
//   node prisma/seedVideos.js
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

import { readFileSync } from 'node:fs';
const videos = JSON.parse(readFileSync(new URL('./exerciseVideos.json', import.meta.url), 'utf8'));
const replacements = JSON.parse(readFileSync(new URL('./exerciseTutorialReplacements.json', import.meta.url), 'utf8'));

async function main() {
  let created = 0;
  let skippedNoExercise = 0;
  let skippedExisting = 0;
  for (const replacement of replacements) {
    const exercise = await prisma.exercise.findFirst({ where: { name: replacement.exercise, createdByUserId: null } });
    const source = videos.find((video) => video.exercise === replacement.exercise && video.youtubeVideoId === replacement.newId);
    if (!exercise || !source) continue;
    const current = await prisma.exerciseFormVideo.findFirst({ where: { exerciseId: exercise.id, languageCode: 'en', youtubeVideoId: replacement.newId } });
    const where = { exerciseId: exercise.id, languageCode: 'en', youtubeVideoId: replacement.oldId };
    if (current) {
      // Remove only the obsolete reference when its reviewed replacement exists.
      await prisma.exerciseFormVideo.deleteMany({ where });
    } else {
      await prisma.exerciseFormVideo.updateMany({ where, data: { youtubeVideoId: source.youtubeVideoId,
        title: source.title, channelName: source.channelName, durationSeconds: source.durationSeconds } });
    }
  }
  for (const [i, v] of videos.entries()) {
    const exercise = await prisma.exercise.findFirst({ where: { name: v.exercise, createdByUserId: null } });
    if (!exercise) {
      console.warn(`No seeded Exercise found for "${v.exercise}" — skipping.`);
      skippedNoExercise++;
      continue;
    }
    const existing = await prisma.exerciseFormVideo.findFirst({
      where: { exerciseId: exercise.id, languageCode: 'en', youtubeVideoId: v.youtubeVideoId },
    });
    if (existing) {
      await prisma.exerciseFormVideo.updateMany({ where: { id: existing.id }, data: {
        title: v.title, channelName: v.channelName, durationSeconds: v.durationSeconds,
      } });
      skippedExisting++;
      continue;
    }
    await prisma.exerciseFormVideo.create({
      data: {
        exerciseId: exercise.id,
        languageCode: 'en',
        youtubeVideoId: v.youtubeVideoId,
        title: v.title,
        channelName: v.channelName,
        durationSeconds: v.durationSeconds,
        order: i,
      },
    });
    created++;
  }
  console.log(`Seeded ${created} form videos (${skippedExisting} already existed, ${skippedNoExercise} had no matching exercise).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
