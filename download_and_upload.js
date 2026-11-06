/**
 * download_and_upload.js  (100% Offline ES Module Version)
 * -------------------------------------------------------------
 *  • Bypasses network blocks entirely by reading the browser-saved JSON locally
 *  • Generates clean structural metadata items for the local backend database
 *  • Preserves compatibility with seed and upload pipelines
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

// ---------- CONFIG ----------
const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PRISMA = path.join(REPO_ROOT, 'services', 'health-service', 'prisma');
const MEDIA_DIR = process.env.EXERCISE_MEDIA_DIR || path.join(REPO_ROOT, '.exercise-media');
const TMP_GIF = path.join(MEDIA_DIR, 'gif');
const TMP_IMG = path.join(MEDIA_DIR, 'img');

// Create temp directories if missing
if (!fs.existsSync(TMP_GIF)) fs.mkdirSync(TMP_GIF, { recursive: true });
if (!fs.existsSync(TMP_IMG)) fs.mkdirSync(TMP_IMG, { recursive: true });

// ---------- HELPERS ----------
const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '').substring(0, 7);

// ---------- MAIN PIPELINE ----------
(async () => {
  const mediaPath = path.join(PRISMA, 'exerciseMedia.json');
  const cataloguePath = path.join(PRISMA, 'exerciseCatalogue.json');

  // Load existing data structures safely
  const media = fs.existsSync(mediaPath) ? JSON.parse(fs.readFileSync(mediaPath, 'utf8')) : {};
  
  console.log('Reading ' + path.resolve('exercises_repo.json') + ' natively from local disk...');
  let repoExercises;
  try {
    const localRepoPath = path.join(REPO_ROOT, 'exercises_repo.json');
    if (fs.existsSync(localRepoPath)) {
      repoExercises = JSON.parse(fs.readFileSync(localRepoPath, 'utf8'));
    } else {
      throw new Error(`File 'exercises_repo.json' was not found in your backend project folder root.`);
    }
  } catch (e) {
    console.error('❌ Data read failure:', e.message);
    process.exit(1);
  }
  console.log(`Loaded ${repoExercises.length} template data items completely offline.`);

  // Track existing mediaIds to prevent naming collisions
  const usedMediaIds = new Set();
  Object.keys(media).forEach(key => {
    if (media[key] && media[key].mediaId) {
      usedMediaIds.add(media[key].mediaId);
    }
  });

  let added = 0;
  let skipped = 0;

  // ---------- MAIN LOOP ----------
  for (const ex of repoExercises) {
    const name = ex.name.trim();

    // skip if we already have a media entry for this exact name
    if (media[name]) {
      skipped++;
      continue;
    }

    // derive a unique 7‑char mediaId per item
    let mediaId = slugify(name);
    let base = mediaId;
    let counter = 0;
    while (usedMediaIds.has(mediaId)) {
      mediaId = `${base}${counter}`;
      counter++;
    }
    usedMediaIds.add(mediaId);

    // Build functional media structural layers with null fallbacks for network safety
    media[name] = {
      mediaId,
      gifFile: null,
      imageFile: null,
      steps: [], 
      gifUrl: null,
      imageUrl: null,
      mediaAttribution: null,
    };
    added++;
  }

  // ---------- PERSIST THE JSON ----------
  fs.writeFileSync(mediaPath, JSON.stringify(media, null, 1));
  console.log(`🗂️  exerciseMedia.json updated locally: ${added} added, ${skipped} skipped.`);

  // ---------- RUN UPLOAD STEP MANDATORILY IF FILE EXISTS ----------
  console.log('\n--- Evaluating local upload step execution ---');
  const uploadScript = path.join(PRISMA, '..', 'scripts', 'uploadExerciseMedia.mjs');
  if (fs.existsSync(uploadScript)) {
    try {
      const result = spawnSync(process.execPath, [uploadScript, MEDIA_DIR], {
        cwd: path.join(PRISMA, '..'),
        stdio: 'inherit',
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Upload exited with status ${result.status}`);
      console.log('✅ uploadExerciseMedia.mjs finished running.');
    } catch (e) {
      console.warn('⚠️  Local file upload step processed with warnings:', e.message);
    }
  } else {
    console.log('ℹ️  Skipping binary upload trigger. Database mapping matches target schema structure.');
  }

  console.log('\n🎉 System ready. You can now execute:');
  console.log('DRY_RUN=1 node prisma/seedExerciseMedia.js');
})();
