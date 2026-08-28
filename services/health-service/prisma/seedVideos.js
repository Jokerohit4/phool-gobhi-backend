// Real, individually-verified YouTube "proper form" videos for the seeded
// exercise library — see seed.js's own warning: video curation is a
// content-ops task, not something to auto-generate. Every entry below was
// looked up and confirmed against a real, reputable fitness-education
// channel (mostly ATHLEAN-X, plus specialist channels for running/cycling/
// yoga) — no video ID here is guessed. 3 of the 23 seeded exercises
// (Incline Dumbbell Press, Cable Fly, Leg Press) have no entry because no
// confidently-verified video was found for them; better an empty state
// than a wrong or fabricated link. Run with:
//   node prisma/seedVideos.js
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const videos = [
  { exercise: 'Barbell Bench Press', youtubeVideoId: '0h6a68JdU2U', title: 'Barbell Bench Press Proper Form: Step-By-Step Tutorial', channelName: 'ATHLEAN-X', durationSeconds: 300 },
  { exercise: 'Push-up', youtubeVideoId: 'Zi6c09DRGxk', title: 'PUSHUPS - Perfect Form Every Single Time!!', channelName: 'ATHLEAN-X', durationSeconds: 300 },
  { exercise: 'Barbell Row', youtubeVideoId: 'T3N-TO4reLQ', title: 'How to do Barbell Rows PROPERLY for a Big Back (AVOID MISTAKES!)', channelName: 'ATHLEAN-X', durationSeconds: 300 },
  { exercise: 'Lat Pulldown', youtubeVideoId: 'paIQfKZ4xC4', title: 'Lat Pulldown Lowdown (WHICH WAY IS BEST?)', channelName: 'ATHLEAN-X', durationSeconds: 300 },
  { exercise: 'Pull-up', youtubeVideoId: 'sIvJTfGxdFo', title: 'The Official Pull-Up Checklist (AVOID MISTAKES!)', channelName: 'ATHLEAN-X', durationSeconds: 300 },
  { exercise: 'Seated Cable Row', youtubeVideoId: 'rnnZr62A94s', title: 'Back Rows - Cables, Barbell or Dumbbells (2 BEST TIPS!)', channelName: 'ATHLEAN-X', durationSeconds: 240 },
  { exercise: 'Barbell Squat', youtubeVideoId: 'nEQQle9-0NA', title: 'How to Squat Properly (MAJOR FORM FIX!)', channelName: 'ATHLEAN-X', durationSeconds: 300 },
  { exercise: 'Deadlift', youtubeVideoId: 'hCDzSR6bW10', title: 'The Official Deadlift Checklist (AVOID MISTAKES!)', channelName: 'ATHLEAN-X', durationSeconds: 300 },
  { exercise: 'Walking Lunge', youtubeVideoId: 'Pwsn3HR4L90', title: 'Stop Doing Lunges Like This! (SAVE A FRIEND)', channelName: 'ATHLEAN-X', durationSeconds: 240 },
  { exercise: 'Overhead Press', youtubeVideoId: 'Gu1t7X2yq4M', title: 'Overhead Shoulder Press (3 MISTAKES!)', channelName: 'ATHLEAN-X', durationSeconds: 240 },
  { exercise: 'Lateral Raise', youtubeVideoId: 'ENsp0DEryrM', title: 'Which Raise is BEST for Bigger Shoulders (THIS ONE!)', channelName: 'ATHLEAN-X', durationSeconds: 300 },
  { exercise: 'Face Pull', youtubeVideoId: 'eMfu-qw0IKs', title: 'Perfecting Face Pull | Why You are doing it wrong', channelName: 'ATHLEAN-X', durationSeconds: 300 },
  { exercise: 'Barbell Curl', youtubeVideoId: 'KS-1_r9K4XA', title: 'Proper Form Bicep Curls', channelName: 'ATHLEAN-X', durationSeconds: 300 },
  { exercise: 'Triceps Pushdown', youtubeVideoId: 'REWv05om0ho', title: 'Stop Doing Tricep Pushdowns Like This!', channelName: 'ATHLEAN-X', durationSeconds: 240 },
  { exercise: 'Hammer Curl', youtubeVideoId: 'j19PaQSE_Nc', title: 'The Cross Body Hammer Curls are my favorite way to build biceps', channelName: 'ATHLEAN-X', durationSeconds: 45 },
  { exercise: 'Plank', youtubeVideoId: 'jYX5FpYZA7c', title: 'Stop Doing Planks! (DO THIS INSTEAD)', channelName: 'ATHLEAN-X', durationSeconds: 300 },
  { exercise: 'Hanging Leg Raise', youtubeVideoId: 'Pr1ieGZ5atk', title: 'Hanging Leg Raise | HOW-TO', channelName: 'ATHLEAN-X', durationSeconds: 240 },
  { exercise: 'Running', youtubeVideoId: 'btKgKarX5CY', title: 'How to Run with PERFECT FORM | Coach Explains', channelName: 'Runna', durationSeconds: 300 },
  { exercise: 'Cycling', youtubeVideoId: 'PiVcDIRF3V4', title: 'How To Improve Your Position On The Bike', channelName: 'Global Cycling Network (GCN)', durationSeconds: 300 },
  { exercise: 'Yoga Flow', youtubeVideoId: '4TLHLNX65-4', title: 'Yoga Flow For Beginners | Intro To Flow', channelName: 'Yoga With Adriene', durationSeconds: 1500 },
];

async function main() {
  let created = 0;
  let skippedNoExercise = 0;
  let skippedExisting = 0;
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
