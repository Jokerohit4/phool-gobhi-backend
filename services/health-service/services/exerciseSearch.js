import { readFileSync } from 'node:fs';

const catalogue = JSON.parse(readFileSync(new URL('../prisma/exerciseCatalogue.json', import.meta.url), 'utf8'));
const aliasesByName = new Map(catalogue.map((e) => [e.name.toLowerCase(), e.aliases || []]));
const preparedExercises = new WeakMap();

export function normalizeExerciseQuery(value) {
  return String(value ?? '').slice(0, 200).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(db|dumb\s+bell)\b/g, 'dumbbell').replace(/\b(bb|bar\s+bell)\b/g, 'barbell')
    .replace(/\brdl\b/g, 'romanian deadlift').replace(/\bohp\b/g, 'overhead press')
    .replace(/\bbenchpress\b/g, 'bench press')
    .replace(/\b(push|pull|chin|sit)\s*ups?\b/g, '$1up')
    .replace(/\bbiceps\b/g, 'bicep').replace(/\btriceps\b/g, 'tricep')
    .replace(/\b(curl|row|squat|raise|lunge|jack)s\b/g, '$1')
    .replace(/\s+/g, ' ').trim();
}

// Light plural fold (presses->press, crunches->crunch, deadlifts->deadlift).
// Applied identically to query tokens and catalogue words. Tokens under 4
// chars are left alone ("abs", "leg"), as are words ending in ss/us/is.
export function foldPlural(word) {
  if (word.length < 4 || /(ss|us|is)$/.test(word)) return word;
  if (/(ch|sh|ss|x|z)es$/.test(word)) return word.slice(0, -2);
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

// Spoken-query noise: rep/set counts and filler. Dropped from the token list
// only while at least one other token remains (see queryTokens).
const FILLER = new Set(['set', 'sets', 'rep', 'reps', 'of', 'for', 'x', 'do', 'times', 'time', 'a', 'an', 'the',
  'with', 'to', 'on', 'in', 'my', 'some', 'please', 'and']);
const isNoise = (t) => FILLER.has(t) || /^\d+(x\d*|sets?|reps?|times?)?$/.test(t) || /^x\d+$/.test(t);

function queryTokens(q) {
  const all = q.split(' ');
  const kept = all.filter((t) => !isNoise(t));
  return (kept.length ? kept : all).map(foldPlural);
}

// allowSubstitution is false for 4-letter words: a single substituted letter
// there is usually a different word (back/hack, neck/deck, bell/belt).
function oneEditApart(a, b, allowSubstitution = true) {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const gap = longer.length - shorter.length;
  if (gap > 1) return false;
  let index = 0;
  while (index < shorter.length && shorter[index] === longer[index]) index++;
  if (gap === 1) return shorter.slice(index) === longer.slice(index + 1);
  if (index === shorter.length) return false;
  const tail = index + 1;
  return (allowSubstitution && shorter.slice(tail) === longer.slice(tail)) ||
    (tail < shorter.length && shorter[index] === longer[tail] &&
      shorter[tail] === longer[index] && shorter.slice(tail + 1) === longer.slice(tail + 1));
}

function prepare(exercise) {
  const cached = preparedExercises.get(exercise);
  if (cached) return cached;
  const name = normalizeExerciseQuery(exercise.name);
  const aliases = (aliasesByName.get(exercise.name.toLowerCase()) || []).map(normalizeExerciseQuery);
  const terms = [name, ...aliases];
  const words = new Set([
    ...terms,
    ...[exercise.muscleGroup, exercise.equipment, ...(exercise.primaryMuscles || []),
      ...(exercise.secondaryMuscles || [])].map(normalizeExerciseQuery),
  ].flatMap((term) => term.split(' ')).map(foldPlural));
  // size: fewer name words = more specific, used to break score ties.
  const prepared = { name, aliases, terms, words, size: name.split(' ').length };
  preparedExercises.set(exercise, prepared);
  return prepared;
}

// Only rank already-authorized, already-filtered rows. This function cannot
// introduce another user's exercise or relax a muscle/equipment filter.
export function rankExercises(exercises, query) {
  const q = normalizeExerciseQuery(query);
  // A non-empty query that normalizes to nothing (Devanagari, "!!!") matches nothing.
  if (!q && String(query ?? '').trim()) return [];
  if (!q) return [...exercises].sort((a, b) => a.name.localeCompare(b.name));
  const tokens = queryTokens(q).map((token) => {
    const scores = new Map();
    return (words) => {
      if (words.has(token)) return 100;
      let best = 0;
      for (const word of words) {
        let score = scores.get(word);
        if (score === undefined) {
          score = word.startsWith(token) ? 70
            : token.length >= 4 && word.length >= 4 &&
              oneEditApart(token, word, token.length >= 5 && word.length >= 5) ? 40 : 0;
          scores.set(word, score);
        }
        if (score === 70) return score;
        if (score > best) best = score;
      }
      return best;
    };
  });
  const ranked = [];
  for (const exercise of exercises) {
    const { name, aliases, terms, words, size } = prepare(exercise);
    let score = name === q ? 1000 : aliases.includes(q) ? 900 : terms.some((t) => t.startsWith(q)) ? 800 : 0;
    if (!score) {
      for (const match of tokens) {
        const wordScore = match(words);
        if (!wordScore) {
          score = 0;
          break;
        }
        score += wordScore;
      }
      score /= tokens.length;
    }
    if (score > 0) ranked.push({ exercise, score, size });
  }
  return ranked.sort((a, b) => b.score - a.score || a.size - b.size ||
    a.exercise.name.localeCompare(b.exercise.name))
    .map(({ exercise }) => exercise);
}
