import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHasanDataset, proposeHasanMatches, HASAN_LANGUAGES } from '../utils/hasanExerciseDataset.js';

const entry = (overrides = {}) => ({
  id: '0001', name: 'Plank', equipment: 'body weight', category: 'waist', body_part: 'waist',
  target: 'abs', muscle_group: 'hip flexors', secondary_muscles: [], media_id: 'realRef',
  image: 'images/0001-realRef.jpg', gif_url: 'videos/0001-realRef.gif', attribution: '© Gym visual — https://gymvisual.com/',
  instructions: Object.fromEntries(HASAN_LANGUAGES.map((lang) => [lang, 'Instruction text.'])),
  instruction_steps: Object.fromEntries(HASAN_LANGUAGES.map((lang) => [lang, ['Instruction text.']])),
  ...overrides,
});
const catalogue = [{ name: 'Plank', equipment: 'bodyweight', muscleGroup: 'core', aliases: [] }];

test('validates the multilingual source and rejects duplicates and unsafe media paths', () => {
  assert.equal(validateHasanDataset([entry()]).length, 1);
  assert.throws(() => validateHasanDataset([entry(), entry()]), /duplicate/);
  assert.throws(() => validateHasanDataset([entry({ gif_url: 'videos/../fake.gif' })]), /unsafe/);
  assert.throws(() => validateHasanDataset([entry({ instruction_steps: { en: [] } })]), /instructions/);
});

test('keeps unrelated equipment and ambiguous variants out of unambiguous matches', () => {
  assert.equal(proposeHasanMatches(catalogue, [entry()])[0].status, 'candidate_requires_movement_review');
  assert.equal(proposeHasanMatches(catalogue, [entry({ equipment: 'machine' })])[0].status, 'unmatched');
  assert.equal(proposeHasanMatches(catalogue, [entry(), entry({ id: '0002' })])[0].status, 'ambiguous');
});

test('existing media IDs outrank names; fuzzy guesses cannot fill missing records', () => {
  const rows = proposeHasanMatches(catalogue,
    [entry({ name: 'Forearm Plank' }), entry({ id: '0002', media_id: 'different' })],
    { Plank: { mediaId: 'realRef' } });
  assert.equal(rows[0].candidates[0].sourceId, '0001');
  assert.equal(rows[0].candidates[0].method, 'existing_media_id');
  assert.equal(proposeHasanMatches(catalogue, [entry({ name: 'Side Plank' })])[0].status, 'unmatched');
});
