import { readFileSync } from 'node:fs';

const catalogue = JSON.parse(readFileSync(new URL('../prisma/exerciseCatalogue.json', import.meta.url), 'utf8'));
const aliasesByName = new Map(catalogue.map((e) => [e.name.toLowerCase(), e.aliases || []]));

export function normalizeExerciseQuery(value) {
  return String(value ?? '').slice(0, 200).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\bdb\b/g, 'dumbbell').replace(/\bbb\b/g, 'barbell')
    .replace(/\brdl\b/g, 'romanian deadlift').replace(/\bohp\b/g, 'overhead press')
    .replace(/\bbenchpress\b/g, 'bench press')
    .replace(/\b(push|pull|chin|sit)\s+ups?\b/g, '$1up')
    .replace(/\b(push|pull|chin|sit)ups\b/g, '$1up')
    .replace(/\bbiceps\b/g, 'bicep').replace(/\btriceps\b/g, 'tricep')
    .replace(/\b(curl|row|squat|raise|lunge|jack)s\b/g, '$1')
    .replace(/\s+/g, ' ').trim();
}

function distance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

// Only rank already-authorized, already-filtered rows. This function cannot
// introduce another user's exercise or relax a muscle/equipment filter.
export function rankExercises(exercises, query) {
  const q = normalizeExerciseQuery(query);
  if (!q) return [...exercises].sort((a, b) => a.name.localeCompare(b.name));
  const tokens = q.split(' ');
  const ranked = [];
  for (const exercise of exercises) {
    const name = normalizeExerciseQuery(exercise.name);
    const aliases = (aliasesByName.get(exercise.name.toLowerCase()) || []).map(normalizeExerciseQuery);
    const terms = [name, ...aliases];
    let score = name === q ? 1000 : aliases.includes(q) ? 900 : terms.some((t) => t.startsWith(q)) ? 800 : 0;
    if (!score) {
      const words = [...terms, exercise.muscleGroup, exercise.equipment,
        ...(exercise.primaryMuscles || []), ...(exercise.secondaryMuscles || [])]
        .flatMap((term) => normalizeExerciseQuery(term).split(' '));
      const matches = tokens.map((token) => {
        if (words.includes(token)) return 100;
        if (words.some((word) => word.startsWith(token))) return 70;
        if (token.length >= 5 && words.some((word) => Math.abs(word.length - token.length) <= 1 && distance(word, token) <= 1)) return 40;
        return 0;
      });
      if (matches.every((match) => match > 0)) score = matches.reduce((a, b) => a + b, 0) / tokens.length;
    }
    if (score > 0) ranked.push({ exercise, score });
  }
  return ranked.sort((a, b) => b.score - a.score || a.exercise.name.localeCompare(b.exercise.name))
    .map(({ exercise }) => exercise);
}
