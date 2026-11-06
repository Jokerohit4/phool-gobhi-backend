// Field-level reference enrichment. Leaves existing IDs and curated data intact.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = (name) => JSON.parse(readFileSync(new URL(`../prisma/${name}`, import.meta.url), 'utf8'));
for (const [name, snapshot] of Object.entries(read('sources/wger-provenance.json').snapshots)) {
  const bytes = readFileSync(new URL(`../prisma/sources/wger-${name}.json`, import.meta.url));
  const data = JSON.parse(bytes.toString('utf8'));
  if (createHash('sha256').update(bytes).digest('hex') !== snapshot.sha256 || data.results.length !== snapshot.records || data.next) {
    throw new Error(`Wger snapshot provenance mismatch or incomplete pagination: ${name}`);
  }
}
const catalogue = read('exerciseCatalogue.json');
const mappings = read('sources/exercise-reference-mappings.json');
const free = new Map(read('sources/free-exercise-db.json').map((row) => [row.id, row]));
const wger = new Map(read('sources/wger-exerciseinfo.json').results.map((row) => [row.id, row]));
const licenses = new Map(read('sources/wger-license.json').results.map((row) => [row.id, row]));
const videos = read('sources/wger-video.json').results;
const allowed = new Set([1, 2, 3, 4]);
const result = {};
const freeRevision = 'a859101d633a01c4a1a920d6a8ce41dabba0705f';
const credit = (asset, fallback) => {
  const license = licenses.get(typeof asset.license === 'object' ? asset.license.id : asset.license);
  const author = asset.license_author || fallback || 'wger contributors';
  return `wger · ${author} · ${license.short_name} · ${license.url}`;
};
const plain = (value) => String(value ?? '').replace(/<\/(p|li|div|h[1-6])>/gi, '\n\n')
  .replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\*\*/g, '').replace(/\r/g, '').trim();
for (const [name, decision] of Object.entries(mappings)) {
  const exercise = catalogue.find((row) => row.name === name);
  if (!exercise) throw new Error(`Unknown catalogue exercise: ${name}`);
  const profile = { equipment: exercise.equipment, reason: decision.reason,
    images: [], instructions: [], secondaryMuscles: [], providers: [], demoVideos: [], classification: {} };
  if (decision.freeId) {
    const source = free.get(decision.freeId);
    if (!source) throw new Error(`Unknown free source: ${decision.freeId}`);
    const url = `https://github.com/yuhonas/free-exercise-db/blob/${freeRevision}/exercises/${encodeURIComponent(source.id)}.json`;
    const imagePaths = decision.freeImageIndexes ? decision.freeImageIndexes.map((index) => source.images[index]) : source.images;
    if (imagePaths.some((path) => !path)) throw new Error(`Missing selected image for ${name}`);
    profile.images = imagePaths.map((path) => `https://raw.githubusercontent.com/yuhonas/free-exercise-db/${freeRevision}/exercises/${path.split('/').map(encodeURIComponent).join('/')}`);
    profile.imageAttribution = 'free-exercise-db (Public Domain / Unlicense)';
    if (decision.useInstructions !== false) {
      profile.instructions = source.instructions;
      profile.instructionAttribution = profile.imageAttribution;
      profile.instructionSourceUrl = url;
    }
    profile.secondaryMuscles = source.secondaryMuscles;
    profile.classification = { difficulty: source.level, force: source.force, mechanic: source.mechanic, category: source.category, equipment: source.equipment };
    profile.providers.push({ provider: 'free-exercise-db', sourceId: source.id, sourceUrl: url, license: 'Unlicense' });
  }
  if (decision.wgerId) {
    const source = wger.get(decision.wgerId);
    if (!source) throw new Error(`Unknown wger exercise: ${decision.wgerId}`);
    const translation = source.translations.find((row) => row.language === 2);
    const url = `https://wger.de/api/v2/exerciseinfo/${source.id}/`;
    const images = source.images.filter((row) => !row.is_ai_generated && allowed.has(row.license));
    if (decision.useImages !== false && !profile.images.length && images.length) {
      profile.images = images.map((row) => row.image);
      profile.imageAttribution = [...new Set(images.map((row) => credit(row)))].join('\n');
    }
    if (!profile.instructions.length && decision.useInstructions !== false && translation && allowed.has(translation.license)) {
      let text = plain(translation.description_source || translation.description);
      const stepStart = text.search(/(?:^|\n)\s*1[.)]\s/);
      if (stepStart >= 0) text = text.slice(stepStart);
      profile.instructions = text.split(/\n\s*\n|\n(?=\s*\d+[.)]\s)/).map((step) => step.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
      profile.instructionAttribution = credit(translation, source.license_author);
      profile.instructionSourceUrl = url;
    }
    if (!profile.secondaryMuscles.length) profile.secondaryMuscles = source.muscles_secondary.map((row) => row.name_en || row.name);
    if (!profile.classification.category) profile.classification.category = source.category.name;
    if (!profile.classification.equipment && source.equipment.length) profile.classification.equipment = source.equipment.map((row) => row.name).join(', ');
    profile.providers.push({ provider: 'wger', sourceId: source.id, sourceUrl: url,
      license: source.license.short_name, licenseUrl: source.license.url, author: source.license_author || translation?.license_author || '' });
    profile.demoVideos = videos.filter((row) => row.exercise === source.id && allowed.has(row.license)
      && row.codec === 'h264' && /\.mp4$/i.test(row.video)).map((row) => ({
        id: -50000 - row.id, videoUrl: row.video, kind: 'demo', languageCode: 'und', youtubeVideoId: '',
        title: `${name} — demonstration`, channelName: 'wger', durationSeconds: Math.ceil(Number(row.duration)),
        attribution: credit(row), licenseUrl: licenses.get(row.license).url, sourceUrl: url,
      }));
  }
  result[name] = profile;
}
writeFileSync(new URL('../prisma/exerciseReferenceData.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ profiles: Object.keys(result).length,
  withImages: Object.values(result).filter((row) => row.images.length).length,
  withInstructions: Object.values(result).filter((row) => row.instructions.length).length,
  withDirectVideo: Object.values(result).filter((row) => row.demoVideos.length).length }, null, 2));
