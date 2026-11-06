import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (name) => JSON.parse(readFileSync(new URL(`../prisma/${name}`, import.meta.url), 'utf8'));

test('published trainer references retain primary metadata and explicit instructional review evidence', () => {
  const catalogue = read('exerciseCatalogue.json');
  const videos = read('exerciseVideos.json');
  const primary = read('sources/reviewed-tutorial-metadata.json');
  const review = read('sources/trainer-tutorial-review-20261106.json');
  const annotated = read('sources/reviewed-annotated-trainer-tutorials-20261106.json');
  const resumed = read('sources/resumed-trainer-decisions-20261106.json');
  const audio = read('sources/reviewed-audio-trainer-tutorials-20261106.json');
  const speechEvidence = JSON.parse(readFileSync(new URL('../../../docs/exercise-dev/trainer-audio-candidates.json', import.meta.url), 'utf8'));
  for (const [name, decision] of Object.entries(resumed.selected)) {
    assert.equal(review.selected[name]?.youtubeVideoId, decision.youtubeVideoId, name);
    if (decision.contactSheet) {
      assert.ok(existsSync(new URL(`../../../docs/exercise-dev/reference-review/${decision.contactSheet}`, import.meta.url)), name);
    }
  }
  for (const [name, decision] of Object.entries(review.selected)) {
    assert.equal(decision.equipment, catalogue.find((row) => row.name === name)?.equipment, name);
    const video = videos.find((row) => row.exercise === name);
    assert.equal(video?.youtubeVideoId, decision.youtubeVideoId, name);
    assert.match(video.youtubeVideoId, /^[A-Za-z0-9_-]{11}$/);
    const source = primary[video.youtubeVideoId];
    for (const key of ['title', 'channelName', 'durationSeconds']) assert.equal(video[key], source[key], `${name}: ${key}`);
    assert.equal(source.playabilityStatus, 'OK', name);
    assert.equal(source.embeddable, true, name);
    assert.equal(source.oembedAvailable, true, name);
    if (decision.instructionFormat === 'recorded_trainer_with_on_screen_steps') {
      const visual = annotated.selected[name];
      assert.equal(visual.youtubeVideoId, video.youtubeVideoId, name);
      assert.ok(visual.previewFrames >= 4 && visual.reason, name);
      assert.ok(existsSync(new URL(`../../../docs/exercise-dev/reference-review/${visual.contactSheet}`, import.meta.url)), name);
    } else if (decision.instructionFormat === 'recorded_trainer_with_verified_english_audio') {
      const spoken = audio.selected[name];
      const evidence = speechEvidence[video.youtubeVideoId];
      assert.equal(spoken.youtubeVideoId, video.youtubeVideoId, name);
      assert.equal(evidence.language, 'en', name);
      assert.ok(evidence.languageProbability >= .9 && evidence.wordCount >= 20, name);
      assert.ok(evidence.meanNoSpeechProbability < .4 && evidence.meanLogProbability > -1, name);
      assert.equal(spoken.audioSha256, evidence.audioSha256, name);
      assert.equal(spoken.transcriptSha256, evidence.transcriptSha256, name);
      assert.ok(spoken.instructionSummary && spoken.reason && spoken.previewFrames >= 4, name);
      assert.ok(existsSync(new URL(`../../../docs/exercise-dev/reference-review/${spoken.contactSheet}`, import.meta.url)), name);
    } else {
      assert.ok(source.captionLanguages.some((language) => language.startsWith('en')), name);
    }
  }
  for (const rejected of [...review.rejectedCandidates, ...annotated.rejected, ...resumed.rejected, ...audio.rejected]) {
    assert.ok(!videos.some((video) => video.exercise === rejected.exercise && video.youtubeVideoId === rejected.youtubeVideoId), rejected.exercise);
  }
});
