// Which memories get loaded for a given message. Run with:
//   node --experimental-test-module-mocks --test
//
// Loading every memory every turn does not scale: a user's twentieth
// remembered fact would cost them on every message thereafter, forever.
// Selection makes the cost flat. The risk it introduces is that a miss is
// silent, so the properties pinned here are (a) safety-tier facts are never
// subject to selection at all, and (b) whatever is left out is still declared.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let selectMemoriesForMessage;

test('setup: stub Prisma, import the service once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: { PrismaClient: class {}, Prisma: {} },
  });
  ({ selectMemoriesForMessage } = await import('../services/assistant/memoryService.js'));
});

function mem(key, value, updatedAt = '2026-09-01T00:00:00Z') {
  return { key, value, updatedAt };
}

const BUDGET = 600;
const keysOf = (rows) => rows.map((m) => m.value);

test('safety-tier facts load no matter what the message is about', () => {
  // An allergy must reach the model on a question about deadlifts, because a
  // relevance score that misses one is how someone gets hurt. This is the
  // single most important property in the file.
  const memories = [mem('allergy', 'peanuts'), mem('injury_mentioned', 'left knee')];
  const { always, selected } = selectMemoriesForMessage(
    memories,
    'how heavy should I go on deadlifts tonight?',
    BUDGET
  );

  assert.deepEqual(keysOf(always).sort(), ['left knee', 'peanuts']);
  assert.equal(selected.length, 0);
});

test('safety-tier facts are not charged against the budget', () => {
  // Budget zero: nothing optional can load, and the allergy still must.
  const { always, selected } = selectMemoriesForMessage(
    [mem('allergy', 'peanuts'), mem('preference', 'trains alone')],
    'anything',
    0
  );
  assert.equal(keysOf(always).join(), 'peanuts');
  assert.equal(selected.length, 0);
});

test('a memory matching the message outranks one that does not', () => {
  const memories = [
    mem('preference', 'hates burpees'),
    mem('equipment', 'has a squat rack at home'),
  ];
  // Budget fits exactly one.
  const { selected } = selectMemoriesForMessage(
    memories,
    'can I train legs with just a squat rack?',
    40
  );
  assert.equal(keysOf(selected).join(), 'has a squat rack at home');
});

test('a key is matched by topic even when it shares no words', () => {
  // "what should I eat after training" has no token in common with "lactose",
  // but it is obviously a diet question — that is what KEY_ALIASES is for.
  const memories = [
    mem('preference', 'avoids lactose'),
    mem('equipment', 'owns a treadmill'),
  ];
  const { selected } = selectMemoriesForMessage(
    memories,
    'what should I eat after training?',
    45
  );
  assert.equal(keysOf(selected).join(), 'avoids lactose');
});

test('a goal outranks a well-matching preference', () => {
  // Tier beats score: direction is worth more than colour even when the
  // colour matches the words better.
  const memories = [
    mem('preference', 'prefers evening sessions'),
    mem('goal', 'wants to add 5kg of muscle'),
  ];
  const { selected } = selectMemoriesForMessage(
    memories,
    'should I do evening sessions or morning ones?',
    45
  );
  assert.equal(keysOf(selected).join(), 'wants to add 5kg of muscle');
});

test('what was left out is declared by category and count, never content', () => {
  // The model has to know it is holding more than it is looking at, or the
  // coach silently appears to have forgotten things — indistinguishable from
  // the bug that motivated all of this.
  const memories = Array.from({ length: 8 }, (_, i) =>
    mem('preference', `a preference about something at index ${i} padded out`)
  );
  const { selected, omittedByKey } = selectMemoriesForMessage(memories, 'hello', 120);

  assert.ok(selected.length > 0 && selected.length < 8);
  assert.equal(omittedByKey.preference, 8 - selected.length);
  // Counts only — spelling out what was omitted would defeat omitting it.
  assert.deepEqual(Object.keys(omittedByKey), ['preference']);
});

test('nothing is omitted when everything fits', () => {
  const { selected, omittedByKey } = selectMemoriesForMessage(
    [mem('goal', 'wants to run 5k'), mem('equipment', 'dumbbells only')],
    'what now?',
    BUDGET
  );
  assert.equal(selected.length, 2);
  assert.deepEqual(omittedByKey, {});
});

test('the selection stays inside its budget', () => {
  const memories = Array.from({ length: 30 }, (_, i) =>
    mem('preference', `preference number ${i} written out at a realistic length`)
  );
  const { selected } = selectMemoriesForMessage(memories, 'training', BUDGET);
  const rendered = selected.map((m) => `- ${m.key}: ${m.value}`).join('\n');
  assert.ok(rendered.length <= BUDGET, `rendered ${rendered.length} > ${BUDGET}`);
});

test('recency breaks a tie when nothing matches', () => {
  const memories = [
    mem('preference', 'older fact', '2026-01-01T00:00:00Z'),
    mem('preference', 'newer fact', '2026-09-01T00:00:00Z'),
  ];
  const { selected } = selectMemoriesForMessage(memories, 'unrelated question', 30);
  assert.equal(keysOf(selected).join(), 'newer fact');
});

test('an empty message still returns a usable selection', () => {
  // The first turn of a conversation, or a message of pure punctuation. No
  // signal to score on must not mean no memories.
  const { always, selected } = selectMemoriesForMessage(
    [mem('allergy', 'peanuts'), mem('goal', 'wants to run 5k')],
    '',
    BUDGET
  );
  assert.equal(always.length, 1);
  assert.equal(selected.length, 1);
});
