// Attaches demo media + step instructions to catalogue exercises from
// exerciseMedia.json. Idempotent. Never touches user-created exercises and
// never overwrites existing ExerciseContent (so approved copy is preserved).
// New en/hi content rows land as reviewStatus 'pending' (the review gate).
//   DRY_RUN=1 node prisma/seedExerciseMedia.js
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dry = process.env.DRY_RUN === '1';
const ATTRIBUTION = '© Gym visual — https://gymvisual.com/';
const media = JSON.parse(readFileSync(new URL('./exerciseMedia.json', import.meta.url), 'utf8'));

try {
  const c = { exercise: 0, noUrl: 0, notFound: 0, content: 0, contentKept: 0 };
  for (const [name, e] of Object.entries(media)) {
    const exercise = await prisma.exercise.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, createdByUserId: null },
    });
    if (!exercise) { c.notFound++; console.warn(`not in DB: ${name}`); continue; }
    if (e.gifUrl && e.imageUrl) {
      if (!dry) {
        await prisma.exercise.update({
          where: { id: exercise.id },
          data: { demoGifUrl: e.gifUrl, demoImageUrl: e.imageUrl, mediaAttribution: ATTRIBUTION },
        });
      }
      c.exercise++;
    } else c.noUrl++;
    for (const lang of ['en', 'hi']) {
      const steps = e.steps?.[lang] ?? [];
      if (!steps.length) continue;
      const existing = await prisma.exerciseContent.findUnique({
        where: { exerciseId_lang: { exerciseId: exercise.id, lang } },
      });
      if (existing) { c.contentKept++; continue; }
      if (!dry) {
        await prisma.exerciseContent.create({
          data: { exerciseId: exercise.id, lang, steps, feelCues: [], mistakes: [], reviewStatus: 'pending' },
        });
      }
      c.content++;
    }
  }
  console.log(`${dry ? '[dry run] ' : ''}`, c);
} finally {
  await prisma.$disconnect();
}
