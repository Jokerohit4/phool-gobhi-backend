// Export exact source photo galleries for user-approved labelled pose GIFs.
import { readFileSync, writeFileSync } from 'node:fs';
import { withExerciseSource } from '../services/exerciseSourceService.js';
import { isExerciseMediaUrl } from '../utils/exerciseMedia.js';
const read = (file) => JSON.parse(readFileSync(new URL(`../prisma/${file}`, import.meta.url), 'utf8'));
const media = read('exerciseMedia.json');
const rows = read('exerciseCatalogue.json').map((row) => withExerciseSource({ ...row,
  demoGifUrl: media[row.name]?.gifUrl, demoImageUrl: media[row.name]?.imageUrl,
})).filter((row) => !isExerciseMediaUrl(row.demoGifUrl));
const candidates = rows.map((row) => ({ name: row.name, equipment: row.equipment,
  urls: [...new Set(row.sourceImageUrls?.length ? row.sourceImageUrls : [row.demoImageUrl].filter(isExerciseMediaUrl))],
  attribution: row.sourceAttribution || row.mediaAttribution, sourceUrl: row.sourceUrl,
}));
writeFileSync(new URL('../../../docs/exercise-dev/pose-gif-candidates.json', import.meta.url), JSON.stringify(candidates, null, 2) + '\n');
console.log(JSON.stringify({ missingGif: rows.length, multiplePhotos: candidates.filter((row) => row.urls.length >= 2).length }));
