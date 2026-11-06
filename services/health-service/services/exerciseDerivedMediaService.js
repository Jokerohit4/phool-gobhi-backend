import { readFileSync } from 'node:fs';
import { isExerciseMediaUrl, isExercisePoseGifUrl } from '../utils/exerciseMedia.js';
const media = JSON.parse(readFileSync(new URL('../prisma/derivedExerciseMedia.json', import.meta.url), 'utf8'));
for (const [name, source] of Object.entries(media)) {
  if (source.reviewStatus !== 'approved_reference' || source.kind !== 'demo' || source.codec !== 'h264'
    || !['public_domain', 'cc_by_sa_4'].includes(source.rights) || !source.attribution || !source.sourceVideoSha256
    || (source.rights === 'cc_by_sa_4' && (source.licenseUrl !== 'https://creativecommons.org/licenses/by-sa/4.0/' || !source.attribution.includes('derivatives licensed CC BY-SA 4.0')))
    || ![source.gifUrl, source.imageUrl, source.videoUrl, source.sourceUrl, source.licenseUrl].every(isExerciseMediaUrl)) {
    throw new Error(`Incomplete derived media reference: ${name}`);
  }
}

export function withDerivedExerciseMedia(exercise) {
  if (exercise.createdByUserId != null) return exercise;
  const source = media[exercise.name];
  if (!source || source.equipment !== exercise.equipment) return exercise;
  const needsGif = !isExerciseMediaUrl(exercise.demoGifUrl) || isExercisePoseGifUrl(exercise.demoGifUrl);
  const needsGallery = !exercise.sourceImageUrls?.length;
  return {
    ...exercise,
    demoGifUrl: needsGif ? source.gifUrl : exercise.demoGifUrl,
    demoImageUrl: isExerciseMediaUrl(exercise.demoImageUrl) ? exercise.demoImageUrl : source.imageUrl,
    mediaAttribution: needsGif ? source.attribution : exercise.mediaAttribution,
    sourceImageUrls: needsGallery ? [source.imageUrl] : exercise.sourceImageUrls,
    sourceAttribution: needsGallery ? source.attribution : exercise.sourceAttribution,
    demoVideos: [...(exercise.demoVideos ?? []).filter((video) => video.videoUrl !== source.videoUrl), {
      id: -3000000 - (exercise.id ?? 0), kind: 'demo', videoUrl: source.videoUrl, youtubeVideoId: '',
      languageCode: 'und', title: `${exercise.name} — demonstration`, channelName: source.provider === 'wger' ? 'wger' : 'DVIDS',
      durationSeconds: source.durationSeconds, attribution: source.attribution,
      sourceUrl: source.sourceUrl, licenseUrl: source.licenseUrl,
    }],
    sourceMetadata: { ...exercise.sourceMetadata, derivedMedia: { provider: source.provider,
      sourceId: source.sourceId, sourceUrl: source.sourceUrl, rights: source.rights, licenseUrl: source.licenseUrl,
      sourceVideoSha256: source.sourceVideoSha256, assetSha256: source.assetSha256 } },
  };
}
