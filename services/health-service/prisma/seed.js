// Starter exercise library — a working set of ~34 common gym exercises
// across every muscle group (cable-machine movements deliberately
// over-represented per a direct ask — 16 of the 34 — since cable stations
// are common gym equipment this library was under-covering: only 5
// entries before, and legs/core had none at all), enough to build and
// test the whole feature end-to-end. Growing this to the ~80-100
// exercises (and the per-language ExerciseFormVideo rows) the
// implementation plan calls for is a real, separate content-ops task —
// see the plan's warning note. Run with:
//   node prisma/seed.js
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const exercises = [
  { name: 'Barbell Bench Press', muscleGroup: 'chest', equipment: 'barbell', loggingType: 'sets_reps_weight', primaryMuscles: ['Chest'], secondaryMuscles: ['Shoulders', 'Triceps'] },
  { name: 'Incline Dumbbell Press', muscleGroup: 'chest', equipment: 'dumbbell', loggingType: 'sets_reps_weight', primaryMuscles: ['Chest'], secondaryMuscles: ['Shoulders'] },
  { name: 'Cable Fly', muscleGroup: 'chest', equipment: 'cable', loggingType: 'sets_reps_weight', primaryMuscles: ['Chest'], secondaryMuscles: [] },
  { name: 'Cable Crossover', muscleGroup: 'chest', equipment: 'cable', loggingType: 'sets_reps_weight', primaryMuscles: ['Chest'], secondaryMuscles: ['Shoulders'] },
  { name: 'Standing Cable Chest Press', muscleGroup: 'chest', equipment: 'cable', loggingType: 'sets_reps_weight', primaryMuscles: ['Chest'], secondaryMuscles: ['Shoulders', 'Triceps'] },
  { name: 'Push-up', muscleGroup: 'chest', equipment: 'bodyweight', loggingType: 'sets_reps_weight', primaryMuscles: ['Chest'], secondaryMuscles: ['Triceps', 'Core'] },
  { name: 'Barbell Row', muscleGroup: 'back', equipment: 'barbell', loggingType: 'sets_reps_weight', primaryMuscles: ['Back'], secondaryMuscles: ['Biceps'] },
  { name: 'Lat Pulldown', muscleGroup: 'back', equipment: 'cable', loggingType: 'sets_reps_weight', primaryMuscles: ['Back'], secondaryMuscles: ['Biceps'] },
  { name: 'Pull-up', muscleGroup: 'back', equipment: 'bodyweight', loggingType: 'sets_reps_weight', primaryMuscles: ['Back'], secondaryMuscles: ['Biceps'] },
  { name: 'Seated Cable Row', muscleGroup: 'back', equipment: 'cable', loggingType: 'sets_reps_weight', primaryMuscles: ['Back'], secondaryMuscles: ['Biceps'] },
  { name: 'Straight-Arm Pulldown', muscleGroup: 'back', equipment: 'cable', loggingType: 'sets_reps_weight', primaryMuscles: ['Back'], secondaryMuscles: ['Triceps'] },
  { name: 'Single-Arm Cable Row', muscleGroup: 'back', equipment: 'cable', loggingType: 'sets_reps_weight', primaryMuscles: ['Back'], secondaryMuscles: ['Biceps'] },
  { name: 'Barbell Squat', muscleGroup: 'legs', equipment: 'barbell', loggingType: 'sets_reps_weight', primaryMuscles: ['Quadriceps', 'Glutes'], secondaryMuscles: ['Core'] },
  { name: 'Deadlift', muscleGroup: 'legs', equipment: 'barbell', loggingType: 'sets_reps_weight', primaryMuscles: ['Hamstrings', 'Glutes'], secondaryMuscles: ['Back', 'Core'] },
  { name: 'Leg Press', muscleGroup: 'legs', equipment: 'machine', loggingType: 'sets_reps_weight', primaryMuscles: ['Quadriceps'], secondaryMuscles: ['Glutes'] },
  { name: 'Walking Lunge', muscleGroup: 'legs', equipment: 'dumbbell', loggingType: 'sets_reps_weight', primaryMuscles: ['Quadriceps', 'Glutes'], secondaryMuscles: [] },
  { name: 'Cable Pull-Through', muscleGroup: 'legs', equipment: 'cable', loggingType: 'sets_reps_weight', primaryMuscles: ['Glutes', 'Hamstrings'], secondaryMuscles: ['Core'] },
  { name: 'Cable Kickback', muscleGroup: 'legs', equipment: 'cable', loggingType: 'sets_reps_weight', primaryMuscles: ['Glutes'], secondaryMuscles: [] },
  { name: 'Overhead Press', muscleGroup: 'shoulders', equipment: 'barbell', loggingType: 'sets_reps_weight', primaryMuscles: ['Shoulders'], secondaryMuscles: ['Triceps'] },
  { name: 'Lateral Raise', muscleGroup: 'shoulders', equipment: 'dumbbell', loggingType: 'sets_reps_weight', primaryMuscles: ['Shoulders'], secondaryMuscles: [] },
  { name: 'Face Pull', muscleGroup: 'shoulders', equipment: 'cable', loggingType: 'sets_reps_weight', primaryMuscles: ['Shoulders'], secondaryMuscles: ['Back'] },
  { name: 'Cable Lateral Raise', muscleGroup: 'shoulders', equipment: 'cable', loggingType: 'sets_reps_weight', primaryMuscles: ['Shoulders'], secondaryMuscles: [] },
  { name: 'Cable Upright Row', muscleGroup: 'shoulders', equipment: 'cable', loggingType: 'sets_reps_weight', primaryMuscles: ['Shoulders'], secondaryMuscles: ['Back'] },
  { name: 'Barbell Curl', muscleGroup: 'arms', equipment: 'barbell', loggingType: 'sets_reps_weight', primaryMuscles: ['Biceps'], secondaryMuscles: [] },
  { name: 'Triceps Pushdown', muscleGroup: 'arms', equipment: 'cable', loggingType: 'sets_reps_weight', primaryMuscles: ['Triceps'], secondaryMuscles: [] },
  { name: 'Hammer Curl', muscleGroup: 'arms', equipment: 'dumbbell', loggingType: 'sets_reps_weight', primaryMuscles: ['Biceps'], secondaryMuscles: ['Forearms'] },
  { name: 'Cable Curl', muscleGroup: 'arms', equipment: 'cable', loggingType: 'sets_reps_weight', primaryMuscles: ['Biceps'], secondaryMuscles: [] },
  { name: 'Cable Overhead Triceps Extension', muscleGroup: 'arms', equipment: 'cable', loggingType: 'sets_reps_weight', primaryMuscles: ['Triceps'], secondaryMuscles: [] },
  { name: 'Plank', muscleGroup: 'core', equipment: 'bodyweight', loggingType: 'duration', primaryMuscles: ['Core'], secondaryMuscles: [] },
  { name: 'Hanging Leg Raise', muscleGroup: 'core', equipment: 'bodyweight', loggingType: 'sets_reps_weight', primaryMuscles: ['Core'], secondaryMuscles: [] },
  { name: 'Cable Crunch', muscleGroup: 'core', equipment: 'cable', loggingType: 'sets_reps_weight', primaryMuscles: ['Core'], secondaryMuscles: [] },
  { name: 'Cable Woodchopper', muscleGroup: 'core', equipment: 'cable', loggingType: 'sets_reps_weight', primaryMuscles: ['Core'], secondaryMuscles: ['Back'] },
  { name: 'Running', muscleGroup: 'cardio', equipment: 'other', loggingType: 'duration_distance', primaryMuscles: ['Legs', 'Cardiovascular'], secondaryMuscles: [] },
  { name: 'Cycling', muscleGroup: 'cardio', equipment: 'other', loggingType: 'duration_distance', primaryMuscles: ['Legs', 'Cardiovascular'], secondaryMuscles: [] },
  { name: 'Yoga Flow', muscleGroup: 'fullBody', equipment: 'bodyweight', loggingType: 'duration', primaryMuscles: ['Full Body'], secondaryMuscles: [] },
];

async function main() {
  for (const exercise of exercises) {
    const existing = await prisma.exercise.findFirst({ where: { name: exercise.name, createdByUserId: null } });
    if (existing) continue;
    await prisma.exercise.create({ data: exercise });
  }
  console.log(`Seeded ${exercises.length} exercises (skipping any that already exist by name).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
