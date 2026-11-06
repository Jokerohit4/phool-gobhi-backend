// Explicit dev-only backfill; no deletion, ID replacement or history edits.
import pg from 'pg';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { withExerciseSource } from '../services/exerciseSourceService.js';
import { isExerciseMediaUrl } from '../utils/exerciseMedia.js';
if (process.env.EXERCISE_DEV_TARGET !== 'health-service-dev') throw Error('Explicit dev target required');
const action = process.argv[2];
if (!['audit', 'apply', 'verify'].includes(action)) throw Error('Unknown dev operation');
const read = (name) => JSON.parse(readFileSync(new URL(`../prisma/${name}`, import.meta.url), 'utf8'));
const catalogue = read('exerciseCatalogue.json');
const media = read('exerciseMedia.json');
const videos = read('exerciseVideos.json');
const tutorialMetadata = read('sources/reviewed-tutorial-metadata.json');
const tutorialReplacements = read('exerciseTutorialReplacements.json');
for (const video of videos) {
  const source = tutorialMetadata[video.youtubeVideoId];
  if (!source?.oembedAvailable || ['title', 'channelName', 'durationSeconds'].some((key) => source[key] !== video[key])) throw Error('Tutorial source metadata mismatch');
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
const output = new URL('../../../docs/exercise-dev/', import.meta.url);
mkdirSync(output, { recursive: true });
try {
  await client.connect();
  await client.query(action === 'apply' ? 'BEGIN' : 'BEGIN READ ONLY');
  const before = (await client.query('SELECT * FROM health."Exercise" WHERE "createdByUserId" IS NULL ORDER BY id')).rows;
  const columns = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='health' AND table_name='Exercise' ORDER BY ordinal_position")).rows.map((row) => row.column_name);
  if (action === 'apply') {
    let added = 0, mediaFilled = 0, metadataFilled = 0, videosAdded = 0, videosReplaced = 0;
    // Only catalogue additions. Existing rows, including custom exercises, survive.
    const additions = catalogue.filter((exercise) => !before.some((row) => row.name.toLowerCase() === exercise.name.toLowerCase()));
    const insertedExercises = await client.query(`INSERT INTO health."Exercise" (name,"muscleGroup",equipment,"loggingType","primaryMuscles","secondaryMuscles","createdAt","updatedAt")
      SELECT v.name,v."muscleGroup"::health."MuscleGroup",v.equipment::health."Equipment",v."loggingType"::health."LoggingType",v."primaryMuscles",v."secondaryMuscles",NOW(),NOW()
      FROM jsonb_to_recordset($1::jsonb) AS v(name text,"muscleGroup" text,equipment text,"loggingType" text,"primaryMuscles" text[],"secondaryMuscles" text[])
      WHERE NOT EXISTS (SELECT 1 FROM health."Exercise" e WHERE lower(e.name)=lower(v.name) AND e."createdByUserId" IS NULL)`, [JSON.stringify(additions)]);
    added = insertedExercises.rowCount;
    const rows = (await client.query('SELECT * FROM health."Exercise" WHERE "createdByUserId" IS NULL')).rows;
    const mediaUpdates = [];
    for (const exercise of rows) {
      const seed = media[exercise.name];
      const enriched = withExerciseSource({ ...exercise,
        demoGifUrl: isExerciseMediaUrl(exercise.demoGifUrl) ? exercise.demoGifUrl : seed?.gifUrl,
        demoImageUrl: isExerciseMediaUrl(exercise.demoImageUrl) ? exercise.demoImageUrl : seed?.imageUrl,
      });
      const gif = isExerciseMediaUrl(enriched.demoGifUrl) ? enriched.demoGifUrl : exercise.demoGifUrl;
      const image = isExerciseMediaUrl(enriched.demoImageUrl) ? enriched.demoImageUrl : exercise.demoImageUrl;
      const difficulty = exercise.difficulty ?? enriched.sourceMetadata?.freeExerciseDb?.difficulty ?? enriched.sourceMetadata?.references?.classification?.difficulty ?? null;
      const secondary = exercise.secondaryMuscles?.length ? exercise.secondaryMuscles : enriched.secondaryMuscles ?? [];
      const changedMedia = gif !== exercise.demoGifUrl || image !== exercise.demoImageUrl;
      const changedMetadata = difficulty !== exercise.difficulty || JSON.stringify(secondary) !== JSON.stringify(exercise.secondaryMuscles);
      if (changedMedia || changedMetadata) {
        const credit = enriched.mediaAttribution || (gif === seed?.gifUrl ? '© Gym visual — https://gymvisual.com/' : exercise.mediaAttribution);
        mediaUpdates.push({ id: exercise.id, gif, image, credit, difficulty, secondary });
        mediaFilled += changedMedia ? 1 : 0;
        metadataFilled += changedMetadata ? 1 : 0;
      }
    }
    await client.query(`UPDATE health."Exercise" e SET "demoGifUrl"=v.gif,"demoImageUrl"=v.image,"mediaAttribution"=v.credit,"difficulty"=v.difficulty,"secondaryMuscles"=v.secondary,"updatedAt"=NOW()
      FROM jsonb_to_recordset($1::jsonb) AS v(id integer,gif text,image text,credit text,difficulty text,secondary text[])
      WHERE e.id=v.id AND e."createdByUserId" IS NULL`, [JSON.stringify(mediaUpdates)]);
    const replacementRows = tutorialReplacements.flatMap((replacement) => {
      const exercise = rows.find((row) => row.name === replacement.exercise);
      const source = tutorialMetadata[replacement.newId];
      return exercise && source ? [{ exerciseId: exercise.id, oldId: replacement.oldId, newId: replacement.newId,
        title: source.title, channelName: source.channelName, durationSeconds: source.durationSeconds }] : [];
    });
    const replacementRecord = 'AS r("exerciseId" integer,"oldId" text,"newId" text,title text,"channelName" text,"durationSeconds" integer)';
    const removedObsolete = await client.query(`DELETE FROM health."ExerciseFormVideo" v USING jsonb_to_recordset($1::jsonb) ${replacementRecord}
      WHERE v."exerciseId"=r."exerciseId" AND v."languageCode"='en' AND v."youtubeVideoId"=r."oldId"
      AND EXISTS (SELECT 1 FROM health."ExerciseFormVideo" current WHERE current."exerciseId"=r."exerciseId" AND current."languageCode"='en' AND current."youtubeVideoId"=r."newId")`, [JSON.stringify(replacementRows)]);
    const replaced = await client.query(`UPDATE health."ExerciseFormVideo" v SET "youtubeVideoId"=r."newId",title=r.title,"channelName"=r."channelName","durationSeconds"=r."durationSeconds"
      FROM jsonb_to_recordset($1::jsonb) ${replacementRecord} WHERE v."exerciseId"=r."exerciseId" AND v."languageCode"='en' AND v."youtubeVideoId"=r."oldId"`, [JSON.stringify(replacementRows)]);
    videosReplaced = replaced.rowCount + removedObsolete.rowCount;
    const tutorialRows = videos.flatMap((video) => {
      const exercise = rows.find((row) => row.name === video.exercise);
      return exercise ? [{ ...video, exerciseId: exercise.id }] : [];
    });
    const tutorialRecord = 'AS v("exerciseId" integer,"youtubeVideoId" text,title text,"channelName" text,"durationSeconds" integer)';
    const insertedVideos = await client.query(`INSERT INTO health."ExerciseFormVideo" ("exerciseId","languageCode","youtubeVideoId",title,"channelName","durationSeconds","order","createdAt")
      SELECT v."exerciseId",'en',v."youtubeVideoId",v.title,v."channelName",v."durationSeconds",0,NOW() FROM jsonb_to_recordset($1::jsonb) ${tutorialRecord}
      WHERE NOT EXISTS (SELECT 1 FROM health."ExerciseFormVideo" old WHERE old."exerciseId"=v."exerciseId" AND old."languageCode"='en' AND old."youtubeVideoId"=v."youtubeVideoId")`, [JSON.stringify(tutorialRows)]);
    videosAdded = insertedVideos.rowCount;
    await client.query(`UPDATE health."ExerciseFormVideo" old SET title=v.title,"channelName"=v."channelName","durationSeconds"=v."durationSeconds"
      FROM jsonb_to_recordset($1::jsonb) ${tutorialRecord} WHERE old."exerciseId"=v."exerciseId" AND old."languageCode"='en' AND old."youtubeVideoId"=v."youtubeVideoId"
      AND (old.title,old."channelName",old."durationSeconds") IS DISTINCT FROM (v.title,v."channelName",v."durationSeconds")`, [JSON.stringify(tutorialRows)]);
    const preserved = (await client.query('SELECT id,name,equipment FROM health."Exercise" WHERE id=ANY($1::int[])', [before.map((row) => row.id)])).rows;
    if (preserved.length !== before.length || before.some((old) => !preserved.some((row) => row.id === old.id && row.name === old.name && row.equipment === old.equipment))) throw Error('Existing catalogue identity changed');
    await client.query('COMMIT');
    console.log(JSON.stringify({ target: 'dev', added, mediaFilled, metadataFilled, videosAdded, videosReplaced }));
    await client.query('BEGIN READ ONLY');
  }
  const rows = (await client.query('SELECT * FROM health."Exercise" WHERE "createdByUserId" IS NULL ORDER BY id')).rows;
  const forms = (await client.query('SELECT v.* FROM health."ExerciseFormVideo" v JOIN health."Exercise" e ON e.id=v."exerciseId" WHERE e."createdByUserId" IS NULL')).rows;
  const missing = { demoGif: [], photo: [], tutorial: [], sourceInstructions: [] };
  for (const row of rows) {
    const enriched = withExerciseSource({ ...row, formVideos: forms.filter((video) => video.exerciseId === row.id) });
    const ref = { id: row.id, name: row.name, equipment: row.equipment };
    if (!isExerciseMediaUrl(enriched.demoGifUrl)) missing.demoGif.push(ref);
    if (!isExerciseMediaUrl(enriched.demoImageUrl)) missing.photo.push(ref);
    if (!enriched.formVideos?.length) missing.tutorial.push(ref);
    if (!enriched.sourceInstructions?.length) missing.sourceInstructions.push(ref);
  }
  const report = { target: 'dev', checkedAt: new Date().toISOString(), exercises: rows.length,
    exerciseColumns: columns,
    storedMissingGif: rows.filter((row) => !isExerciseMediaUrl(row.demoGifUrl)).length,
    storedMissingPhoto: rows.filter((row) => !isExerciseMediaUrl(row.demoImageUrl)).length,
    effectiveMissing: Object.fromEntries(Object.entries(missing).map(([key, list]) => [key, list.length])), missing };
  report.mediaComplete = Object.values(missing).every((list) => list.length === 0);
  report.gifComplete = missing.demoGif.length === 0 && report.storedMissingGif === 0;
  report.gifKinds = {};
  for (const row of rows) {
    const enriched = withExerciseSource(row);
    const kind = enriched.demoGifKind ?? 'motion';
    report.gifKinds[kind] = (report.gifKinds[kind] ?? 0) + 1;
  }
  if (action === 'verify') {
    const url = process.env.EXERCISE_DEV_URL;
    const headers = { Authorization: `Bearer ${process.env.EXERCISE_DEV_IDENTITY_TOKEN}`, 'x-user-id': '0', 'x-user-role': 'customer', 'x-user-type': 'gym_seeker' };
    const get = async (path) => {
      const response = await fetch(url + path, { headers, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw Error(`Dev HTTP ${response.status} at ${path}`);
      return response.json();
    };
    await get('/health');
    const library = await get('/exercises');
    const found = new Set(library.data.map((row) => row.id));
    if (rows.some((row) => !found.has(row.id))) throw Error('Dev exercise picker omits catalogue rows');
    const failures = [];
    const videoFields = (list) => list.map(({ youtubeVideoId, title, channelName, durationSeconds, languageCode, videoUrl }) => ({ youtubeVideoId, title, channelName, durationSeconds, languageCode, videoUrl: videoUrl ?? null })).sort((a, b) => a.youtubeVideoId.localeCompare(b.youtubeVideoId));
    let next = 0;
    await Promise.all(Array.from({ length: 5 }, async () => {
      while (next < rows.length) {
        const row = rows[next++];
        try {
          const expected = withExerciseSource({ ...row, formVideos: forms.filter((video) => video.exerciseId === row.id && video.languageCode === 'en') }, 'en');
          const { data } = await get(`/exercises/${row.id}?lang=en`);
          for (const key of ['name', 'demoGifUrl', 'demoGifKind', 'demoImageUrl', 'sourceInstructions', 'sourceInstructionLanguage', 'sourceInstructionAttribution', 'sourceImageUrls', 'demoVideos', 'sourceInstructionUrl']) {
            if (JSON.stringify(data[key] ?? null) !== JSON.stringify(expected[key] ?? null)) throw Error(`Mismatch in ${key}`);
          }
          if (JSON.stringify(data.sourceMetadata?.poseSequence ?? null) !== JSON.stringify(expected.sourceMetadata?.poseSequence ?? null)) throw Error('Pose reference metadata mismatch');
          if (JSON.stringify(data.sourceMetadata?.instructionFallback ?? null) !== JSON.stringify(expected.sourceMetadata?.instructionFallback ?? null)) throw Error('Instruction provenance mismatch');
          if (JSON.stringify(videoFields(data.formVideos ?? [])) !== JSON.stringify(videoFields(expected.formVideos))) throw Error('Tutorial metadata mismatch');
        } catch (error) { failures.push({ id: row.id, name: row.name, error: error.message }); }
      }
    }));
    for (const name of ['Knee Push-up', 'Plank', 'Dumbbell Step Ups', 'Barbell Rollout from Bench', 'Towel Row']) {
      const row = rows.find((exercise) => exercise.name === name);
      const expected = withExerciseSource(row, 'hi');
      const { data } = await get(`/exercises/${row.id}?lang=hi`);
      if (data.sourceInstructionLanguage !== expected.sourceInstructionLanguage || JSON.stringify(data.sourceInstructions) !== JSON.stringify(expected.sourceInstructions)) failures.push({ id: row.id, name, error: 'Hindi source/fallback mismatch' });
      const hindi = forms.filter((video) => video.exerciseId === row.id && video.languageCode === 'hi');
      const fallback = !hindi.length ? forms.filter((video) => video.exerciseId === row.id && video.languageCode === 'en') : [];
      if (JSON.stringify(videoFields(data.formVideos ?? [])) !== JSON.stringify(videoFields(hindi.length ? hindi : fallback))) failures.push({ id: row.id, name, error: 'Hindi tutorial/English fallback mismatch' });
      if (fallback.length && data.formVideoFallbackLanguage !== 'en') failures.push({ id: row.id, name, error: 'English fallback not labelled' });
    }
    report.http = { url, libraryRows: library.data.length, detailsChecked: rows.length, failures };
    if (failures.length) process.exitCode = 1;
  }
  writeFileSync(new URL(`${action}.json`, output), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, missing: undefined }, null, 2));
  await client.query('ROLLBACK');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  // Database connection errors may contain credentials; report only safe codes.
  const safeDetail = /^Dev (HTTP|exercise picker)/.test(error.message) ? ` ${error.message}` : '';
  console.error(`Dev exercise ${action} failed (${error.code ?? error.name}).${safeDetail} No credential details disclosed.`);
  process.exitCode = 1;
} finally { await client.end(); }
