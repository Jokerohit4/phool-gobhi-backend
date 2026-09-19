// What the coach is allowed to remember. Run with:
//   node --experimental-test-module-mocks --test
//
// Everything parseMemories touches is untrusted model output on its way to a
// durable store that is replayed into every future prompt. A bad row here is
// not a one-off wrong answer — it is a wrong answer repeated forever, so the
// validation is pinned rather than assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let parseMemories, looksMemorable, MEMORY_KEYS;

test('setup: stub Prisma, import the service once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: { PrismaClient: class {}, Prisma: {} },
  });
  ({ parseMemories, looksMemorable, MEMORY_KEYS } = await import(
    '../services/assistant/memoryService.js'
  ));
});

// --- the gate --------------------------------------------------------------

test('questions and small talk never reach the model', () => {
  // The gate exists to protect the token budget: on a plan where tokens per
  // minute is the binding limit, extracting from every turn would roughly
  // double usage to learn nothing.
  for (const t of [
    'ok thanks',
    'cool',
    'yes',
    'what should I do tomorrow?',
    'what do I need to do first?',
    'how many sets should I be doing?',
  ]) {
    assert.equal(looksMemorable(t), false, t);
  }
});

test('a fact followed by a question is still extracted from', () => {
  // Only an unbroken single-clause question is skipped — people routinely
  // state something durable and then ask about it in the same breath, and
  // dropping those would lose the fact entirely.
  assert.equal(looksMemorable("I'm allergic to peanuts, is that a problem?"), true);
  assert.equal(looksMemorable('I have a bad knee. what should I avoid?'), true);
});

test('statements about themselves do reach the model', () => {
  for (const t of [
    'I am allergic to peanuts',
    'my goal is to add 5kg of muscle',
    'I have a home gym with dumbbells only',
    'I had knee surgery two years ago',
    "I'm vegetarian",
  ]) {
    assert.equal(looksMemorable(t), true, t);
  }
});

// --- the validator ---------------------------------------------------------

test('a well-formed proposal is accepted', () => {
  const out = parseMemories(
    JSON.stringify({ memories: [{ key: 'goal', value: 'wants to add 5kg of muscle' }] })
  );
  assert.deepEqual(out, [{ key: 'goal', value: 'wants to add 5kg of muscle' }]);
});

test('JSON wrapped in prose or a code fence is still read', () => {
  const out = parseMemories(
    'Sure!\n```json\n{"memories":[{"key":"allergy","value":"peanuts"}]}\n```\nHope that helps.'
  );
  assert.deepEqual(out, [{ key: 'allergy', value: 'peanuts' }]);
});

test('an invented key is dropped, not stored', () => {
  // The model proposes; MEMORY_KEYS disposes. A hallucinated category must not
  // become permanent context.
  const out = parseMemories(
    JSON.stringify({
      memories: [
        { key: 'medication', value: 'metformin 500mg' },
        { key: 'diagnosis', value: 'type 2 diabetes' },
        { key: 'goal', value: 'wants to run 5k' },
      ],
    })
  );
  assert.deepEqual(out, [{ key: 'goal', value: 'wants to run 5k' }]);
});

test('nothing in MEMORY_KEYS writes to a field other features trust', () => {
  // injuryZones drives real programming decisions and has its own consent
  // gate. A model-extracted injury silently changing someone's training plan
  // is a bug in any regime, so the assistant's store stays separate.
  assert.ok(!MEMORY_KEYS.includes('injuryZones'));
  assert.ok(MEMORY_KEYS.includes('injury_mentioned'));
});

test('an over-long value is dropped rather than truncated', () => {
  // Truncating would store a half-sentence as though it were a fact.
  const out = parseMemories(
    JSON.stringify({ memories: [{ key: 'preference', value: 'x'.repeat(201) }] })
  );
  assert.deepEqual(out, []);
});

test('duplicate keys in one proposal keep only the first', () => {
  // (userId, key) is unique, so two writes for one key in a turn would race.
  const out = parseMemories(
    JSON.stringify({
      memories: [
        { key: 'goal', value: 'first' },
        { key: 'goal', value: 'second' },
      ],
    })
  );
  assert.deepEqual(out, [{ key: 'goal', value: 'first' }]);
});

test('at most three memories come out of one turn', () => {
  const out = parseMemories(
    JSON.stringify({
      memories: MEMORY_KEYS.map((key) => ({ key, value: `v-${key}` })),
    })
  );
  assert.equal(out.length, 3);
});

test('malformed output produces nothing rather than throwing', () => {
  // The extraction runs fire-and-forget behind a reply the user already has;
  // it must fail quietly on anything.
  for (const bad of [
    '',
    'I could not find any facts.',
    '{"memories": "not an array"}',
    '{"memories":[{"key":"goal"}]}',
    '{"memories":[null]}',
    '{broken json',
    null,
    undefined,
    42,
  ]) {
    assert.deepEqual(parseMemories(bad), [], String(bad));
  }
});

test('whitespace is normalised so one fact is not stored two ways', () => {
  const out = parseMemories(
    JSON.stringify({ memories: [{ key: 'equipment', value: '  dumbbells\n  and a bench ' }] })
  );
  assert.deepEqual(out, [{ key: 'equipment', value: 'dumbbells and a bench' }]);
});
