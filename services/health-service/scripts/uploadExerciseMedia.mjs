// Uploads the exercise demo GIFs/thumbnails to Cloudinary and records the
// resulting URLs in prisma/exerciseMedia.json (resumable: entries that already
// have URLs are skipped).
//
//   CLOUDINARY_CLOUD_NAME=… CLOUDINARY_API_KEY=… CLOUDINARY_API_SECRET=… \
//   node scripts/uploadExerciseMedia.mjs <dir containing gif/ and img/>
//
// Media is © Gym visual (https://gymvisual.com/), 180x180 only — do not
// upscale, and keep the attribution wherever it is shown.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { v2 as cloudinary } from 'cloudinary';

const dir = process.argv[2];
if (!dir) { console.error('usage: uploadExerciseMedia.mjs <media dir>'); process.exit(1); }
for (const k of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) {
  if (!process.env[k]) { console.error(`Missing ${k}`); process.exit(1); }
}
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const file = new URL('../prisma/exerciseMedia.json', import.meta.url);
const data = JSON.parse(readFileSync(file, 'utf8'));
const upload = (path, publicId) =>
  cloudinary.uploader.upload(path, { public_id: publicId, folder: 'phool-gobhi/exercises', overwrite: false, resource_type: 'image' })
    .then((r) => r.secure_url);

let done = 0, skipped = 0;
for (const [name, e] of Object.entries(data)) {
  if (e.gifUrl && e.imageUrl) { skipped++; continue; }
  const gif = join(dir, 'gif', e.gifFile), img = join(dir, 'img', e.imageFile);
  if (!existsSync(gif) || !existsSync(img)) { console.warn(`missing local media for ${name}`); continue; }
  try {
    e.gifUrl = e.gifUrl || await upload(gif, `${e.mediaId}-demo`);
    e.imageUrl = e.imageUrl || await upload(img, `${e.mediaId}-thumb`);
    done++;
    writeFileSync(file, JSON.stringify(data, null, 1)); // persist progress
  } catch (err) { console.error(`FAILED ${name}: ${err.message}`); }
}
console.log(`uploaded ${done}, already done ${skipped}, total ${Object.keys(data).length}`);
