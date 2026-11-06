// Read-only checks of the exact resolved GIF URLs, with no guessed asset paths.
import { readFileSync, writeFileSync } from 'node:fs';
import { withExerciseSource } from '../services/exerciseSourceService.js';
import { isExerciseMediaUrl } from '../utils/exerciseMedia.js';

const read = (file) => JSON.parse(readFileSync(new URL(`../prisma/${file}`, import.meta.url), 'utf8'));
const catalogue = read('exerciseCatalogue.json');
const media = read('exerciseMedia.json');
const grouped = new Map();
for (const row of catalogue) {
  const seed = media[row.name];
  const exercise = withExerciseSource({ ...row, demoGifUrl: seed?.gifUrl, demoImageUrl: seed?.imageUrl });
  if (!isExerciseMediaUrl(exercise.demoGifUrl)) continue;
  if (!grouped.has(exercise.demoGifUrl)) grouped.set(exercise.demoGifUrl, []);
  grouped.get(exercise.demoGifUrl).push(row.name);
}
const entries = [...grouped];
const assets = [];
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < entries.length) {
    const [url, names] = entries[next++];
    try {
      const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(20000) });
      const contentType = response.headers.get('content-type');
      assets.push({ url, names, status: response.status, contentType,
        ok: response.ok && contentType?.split(';')[0] === 'image/gif' });
    } catch (error) {
      assets.push({ url, names, ok: false, error: error.name });
    }
  }
}));
assets.sort((a, b) => a.url.localeCompare(b.url));
const failures = assets.filter((asset) => !asset.ok);
const report = { checkedAt: new Date().toISOString(), exercisesWithGif: assets.reduce((count, asset) => count + asset.names.length, 0),
  uniqueAssets: assets.length, failed: failures.length, assets };
writeFileSync(new URL('../../../docs/exercise-dev/gif-availability.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, assets: undefined, failures }));
if (failures.length) process.exitCode = 1;
