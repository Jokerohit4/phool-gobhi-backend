// Matching proposals only: callers must review movement variants before
// publishing assets. Unsupported source fields must not be inferred as facts.
const normalize = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const equipment = (value) => ({
  bodyweight: 'bodyweight', barbell: 'barbell', ezbarbell: 'barbell', olympicbarbell: 'barbell',
  dumbbell: 'dumbbell', cable: 'cable', kettlebell: 'kettlebell',
  leveragemachine: 'machine', smithmachine: 'machine', stationarybike: 'machine',
  ellipticalmachine: 'machine', machine: 'machine',
  stepmillmachine: 'machine', skiergmachine: 'machine', upperbodyergometer: 'machine', sledmachine: 'machine',
})[normalize(value)] ?? 'other';
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
// Preserve position, grip, angle and unilateral qualifiers. Only reorder words
// and reconcile explicit spelling/plural differences within the same equipment.
const movementWords = (value, kind) => {
  let words = String(value ?? '').toLowerCase()
    .replace(/biceps/g, 'bicep').replace(/triceps/g, 'tricep')
    .replace(/\b(one|single)[ -]arm\b/g, 'unilateralarm')
    .replace(/\b(one|single)[ -]leg\b/g, 'unilateralleg')
    .replace(/push[ -]?ups?/g, 'pushup').replace(/pull[ -]?ups?/g, 'pullup')
    .replace(/sit[ -]?ups?/g, 'situp').replace(/flyes/g, 'fly')
    .replace(/\b(curl|row|squat|raise|lunge|jack|extension|fly|dip|kick)s\b/g, '$1')
    .replace(/\b(alternate|alternating)\b/g, 'alternating')
    .replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean);
  const redundant = { barbell: ['barbell'], dumbbell: ['dumbbell'], cable: ['cable'], kettlebell: ['kettlebell'],
    bodyweight: ['bodyweight'], machine: ['machine', 'lever', 'leverage'] }[kind] ?? [];
  words = words.filter((word) => !redundant.includes(word));
  return words.sort().join(' ');
};
export const HASAN_LANGUAGES = ['en', 'es', 'it', 'tr', 'ru', 'zh', 'hi', 'pl', 'ko', 'fr'];

export function validateHasanDataset(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Expected a nonempty exercise array');
  const ids = new Set();
  for (const entry of entries) {
    if (!/^\d{4}$/.test(entry.id) || ids.has(entry.id)) throw new Error(`Missing/duplicate dataset id: ${entry.id}`);
    ids.add(entry.id);
    for (const field of ['name', 'equipment', 'category', 'body_part', 'target', 'muscle_group', 'media_id', 'attribution']) {
      if (!nonempty(entry[field])) throw new Error(`${entry.id}: missing ${field}`);
    }
    if (!Array.isArray(entry.secondary_muscles) || !entry.secondary_muscles.every(nonempty))
      throw new Error(`${entry.id}: invalid secondary_muscles`);
    for (const lang of HASAN_LANGUAGES) {
      if (typeof entry.instructions?.[lang] !== 'string' || !Array.isArray(entry.instruction_steps?.[lang])
        || !entry.instruction_steps[lang].every(nonempty)) throw new Error(`${entry.id}: invalid instructions for ${lang}`);
    }
    for (const [field, prefix, extension] of [['image', 'images/', /\.(jpg|jpeg|png)$/i], ['gif_url', 'videos/', /\.gif$/i]]) {
      const path = entry[field];
      if (typeof path !== 'string' || !path.startsWith(prefix) || path.includes('..') || path.includes('\\')
        || !extension.test(path) || path.slice(prefix.length).includes('/')) throw new Error(`${entry.id}: unsafe ${field}`);
    }
  }
  return entries;
}

export function proposeHasanMatches(catalogue, entries, legacyMedia = {}) {
  return catalogue.map((exercise) => {
    const key = normalize(exercise.name);
    const aliases = new Set((exercise.aliases ?? []).map(normalize));
    const candidates = entries.flatMap((entry) => {
      if (equipment(entry.equipment) !== exercise.equipment) return [];
      const method = entry.media_id === legacyMedia[exercise.name]?.mediaId ? 'existing_media_id'
        : normalize(entry.name) === key ? 'exact_name'
        : aliases.has(normalize(entry.name)) ? 'explicit_alias' : null;
      const equivalent = method ?? (movementWords(entry.name, exercise.equipment) === movementWords(exercise.name, exercise.equipment)
        ? 'equivalent_words' : null);
      return equivalent ? [{ entry, method: equivalent }] : [];
    });
    const priority = { existing_media_id: 0, exact_name: 1, explicit_alias: 2, equivalent_words: 3 };
    candidates.sort((a, b) => priority[a.method] - priority[b.method] || a.entry.id.localeCompare(b.entry.id));
    const best = candidates[0];
    const tied = best ? candidates.filter((candidate) => candidate.method === best.method) : [];
    return {
      name: exercise.name, muscleGroup: exercise.muscleGroup, equipment: exercise.equipment,
      status: !best ? 'unmatched' : tied.length > 1 ? 'ambiguous' : 'candidate_requires_movement_review',
      candidates: tied.map(({ entry, method }) => ({
        sourceId: entry.id, sourceName: entry.name, method, sourceEquipment: entry.equipment,
        target: entry.target, bodyPart: entry.body_part,
        image: entry.image, gif: entry.gif_url, attribution: entry.attribution,
        instructionLanguages: HASAN_LANGUAGES.filter((lang) => entry.instruction_steps[lang].length > 0 || nonempty(entry.instructions[lang])),
        secondaryMuscles: entry.secondary_muscles,
      })),
    };
  });
}
