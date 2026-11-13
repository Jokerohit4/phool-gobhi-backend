// This checks URL structure, not availability or whether an asset shows the
// correct movement. Those still require an upload and content review.
export function isExerciseMediaUrl(value) {
  if (typeof value !== 'string' || /[\s{}<>]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && url.hostname.includes('.') && url.pathname !== '/';
  } catch {
    return false;
  }
}

export function demoStatus(entry) {
  if (!entry?.gifUrl) return 'missing';
  return isExerciseMediaUrl(entry.gifUrl) ? 'needs_review' : 'invalid_url';
}

export function isExercisePoseGifUrl(value) {
  return isExerciseMediaUrl(value) && value.startsWith('https://storage.googleapis.com/phool-gobhi-exercise-media-dev/pose-references/');
}
