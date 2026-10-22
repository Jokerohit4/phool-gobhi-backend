// Used for newly seeded system templates; existing templates are upgraded by migration.
export function withPreparation(exercises) {
  return [
    { name: 'March in Place', sets: 1, seconds: 300, restSeconds: 0, phase: 'warm_up', instructions: 'Start gently and gradually increase your pace over 5 minutes.' },
    { name: 'Cat-Cow', sets: 1, seconds: 60, restSeconds: 0, phase: 'warm_up', instructions: 'Move smoothly with your breath through a comfortable range.' },
    ...exercises.map((ex) => ({ ...ex, phase: 'main' })),
    { name: 'March in Place', sets: 1, seconds: 300, restSeconds: 0, phase: 'cool_down', instructions: 'Gradually slow your pace and let your breathing settle.' },
    ...['Chest Doorway Stretch', 'Hip Flexor Stretch', 'Standing Hamstring Stretch'].map((name) => ({ name, sets: 2, seconds: 30, restSeconds: 0, phase: 'cool_down', instructions: 'Hold gently for 30 seconds on each side, one side per set. Breathe normally; do not bounce or push into pain.' })),
  ];
}
