// Complete owned/licensed content packages close gaps without changing history.
import { isExerciseMediaUrl } from './exerciseMedia.js';
export function validateExerciseContentBundles(bundles, catalogue) {
  if (!Array.isArray(bundles)) throw new Error('Expected an array of content packages');
  const names = new Set();
  for (const bundle of bundles) {
    const exercise = catalogue.find((row) => row.name === bundle.exerciseName);
    const fail = (message) => { throw new Error(`${bundle.exerciseName ?? '(unnamed)'}: ${message}`); };
    const text = (value) => typeof value === 'string' && value.trim().length > 0;
    if (!exercise) fail('Unknown exercise; use its exact catalogue name');
    if (names.has(bundle.exerciseName)) fail('Duplicate package');
    names.add(bundle.exerciseName);
    if (bundle.equipment !== exercise.equipment) fail('Equipment differs from catalogue movement');
    if (bundle.reviewStatus !== 'approved' || !text(bundle.reviewedBy) || !text(bundle.reviewedAt) || !/^\d{4}-\d{2}-\d{2}T/.test(bundle.reviewedAt) || !Number.isFinite(Date.parse(bundle.reviewedAt))) fail('A completed content review is required');
    if (!['owned', 'licensed'].includes(bundle.rights) || !text(bundle.rightsEvidence) || !text(bundle.attribution)) fail('Record rights, supporting evidence reference, and display credit');
    for (const [field, extension] of [['imageUrl', /\.(jpg|jpeg|png)$/i], ['demoGifUrl', /\.gif$/i],
      ['demoVideoUrl', /\.mp4$/i], ['tutorialVideoUrl', /\.mp4$/i]]) {
      if (!isExerciseMediaUrl(bundle[field]) || !extension.test(new URL(bundle[field]).pathname)) fail(`Invalid/missing ${field}`);
    }
    if (bundle.hasInstructionalExplanation !== true || !['en', 'hi'].includes(bundle.tutorialLanguage)) fail('Tutorial must contain instruction and declare its actual language');
    if (bundle.videoCodec !== 'h264') fail('Deliver mobile-compatible H.264 MP4 video');
    if (!(Number(bundle.tutorialDurationSeconds) > 0)) fail('Record the real tutorial duration');
    for (const lang of ['en', 'hi']) {
      if (!Array.isArray(bundle.instructions?.[lang]) || bundle.instructions[lang].length < 3 || !bundle.instructions[lang].every(text)) fail(`Provide setup, movement and finish steps in ${lang}`);
    }
    for (const [field, values] of [['difficulty', ['beginner', 'intermediate', 'advanced']],
      ['force', ['push', 'pull', 'static', 'mixed', 'not_applicable']], ['mechanic', ['compound', 'isolation', 'not_applicable']]]) {
      if (!values.includes(bundle.classification?.[field]?.value) || !text(bundle.classification[field].basis)) fail(`Missing reviewed ${field} and basis`);
    }
    if (!Array.isArray(bundle.secondaryMuscles) || !bundle.secondaryMuscles.every(text)) fail('Invalid supporting muscles');
    if (!bundle.secondaryMuscles.length && !text(bundle.emptySecondaryMusclesReason)) fail('Explain an intentionally empty supporting-muscle list');
  }
  return bundles;
}

export function applyExerciseContentBundle(exercise, bundle, lang = 'en') {
  if (!bundle || bundle.reviewStatus !== 'approved' || exercise.createdByUserId != null || bundle.exerciseName !== exercise.name || bundle.equipment !== exercise.equipment) return exercise;
  const requested = String(lang).replace('_', '-').toLowerCase();
  const language = requested.split('-')[0] === 'hi' && !requested.includes('latn') ? 'hi' : 'en';
  return {
    ...exercise,
    demoGifUrl: bundle.demoGifUrl, demoGifKind: 'motion', demoImageUrl: bundle.imageUrl, mediaAttribution: bundle.attribution,
    sourceImageUrls: [bundle.imageUrl], sourceAttribution: bundle.attribution,
    sourceInstructions: bundle.instructions[language], sourceInstructionLanguage: language,
    sourceInstructionAttribution: bundle.attribution,
    sourceInstructionUrl: null,
    secondaryMuscles: bundle.secondaryMuscles,
    demoVideos: [{ id: -1000000 - (exercise.id ?? 0), kind: 'demo', videoUrl: bundle.demoVideoUrl,
      languageCode: 'und', youtubeVideoId: '', title: `${exercise.name} — demonstration`, channelName: 'Phool Gobhi', durationSeconds: 0,
      attribution: bundle.attribution }, ...(exercise.demoVideos ?? [])],
    formVideos: [...(language === bundle.tutorialLanguage ? [{ id: -2000000 - (exercise.id ?? 0), kind: 'tutorial', videoUrl: bundle.tutorialVideoUrl,
      languageCode: bundle.tutorialLanguage, youtubeVideoId: '', title: `${exercise.name} — form guide`, channelName: 'Phool Gobhi',
      durationSeconds: bundle.tutorialDurationSeconds, attribution: bundle.attribution }] : []), ...(exercise.formVideos ?? [])],
    sourceMetadata: { ...exercise.sourceMetadata, owned: { classification: bundle.classification,
      reviewedAt: bundle.reviewedAt, emptySecondaryMusclesReason: bundle.emptySecondaryMusclesReason ?? null } },
  };
}

// A syntactically valid filename is not evidence that an upload exists.
export async function verifyExerciseBundleAssets(bundles, request = fetch) {
  const tasks = bundles.flatMap((bundle) => ['imageUrl', 'demoGifUrl', 'demoVideoUrl', 'tutorialVideoUrl'].map((field) => ({ bundle, field })));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, tasks.length) }, async () => {
    while (next < tasks.length) {
      const { bundle, field } = tasks[next++];
      const response = await request(bundle[field], { method: 'HEAD', signal: AbortSignal.timeout(15000) });
      const type = (response.headers.get('content-type') ?? '').split(';')[0].toLowerCase();
      const validType = field === 'imageUrl' ? ['image/jpeg', 'image/png'].includes(type)
        : field === 'demoGifUrl' ? type === 'image/gif' : type === 'video/mp4';
      if (!response.ok || !validType || response.headers.get('content-length') === '0') {
        throw new Error(`${bundle.exerciseName}: ${field} is unavailable or has an invalid media content type (HTTP ${response.status})`);
      }
    }
  }));
}
