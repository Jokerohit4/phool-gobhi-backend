// Where each kind of memory lands in the prompt. Run with:
//   node --experimental-test-module-mocks --test
//
// Every memory goes into every prompt — the per-key caps are what make that
// affordable, so the load-bearing test here is that a user at every cap still
// fits with truncation never firing.
//
// Ordering still matters for two reasons. Truncation slices the tail, so if a
// future change ever does overflow the budget it must eat preferences rather
// than allergies. And the block has to be byte-stable between turns, because
// the provider caches identical prompt prefixes and cached tokens are both
// half price and exempt from the rate limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let buildUserContextService;
const state = { memories: [], sessions: [], personalisation: null, weeklyGoal: null };

test('setup: stub Prisma and the attendance hop, import once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.workoutSession = { findMany: async () => state.sessions };
          this.personalisationProfile = { findUnique: async () => state.personalisation };
          this.assistantMemory = { findMany: async () => state.memories };
          this.weeklyGoal = { findUnique: async () => state.weeklyGoal };
        }
      },
      Prisma: {},
    },
  });
  // Attendance is a cross-service HTTP call; nothing here is about that.
  t.mock.module('../utils/fetchAttendance.js', {
    exports: { fetchAttendanceSince: async () => [] },
  });
  ({ buildUserContextService } = await import('../services/assistant/contextService.js'));
});

let nextId = 1;
function mem(key, value) {
  return { id: nextId++, key, value, updatedAt: '2026-09-01T00:00:00Z' };
}

test('safety memories are rendered before attendance and workouts', async () => {
  state.memories = [mem('preference', 'trains alone'), mem('allergy', 'peanuts')];
  const { text } = await buildUserContextService(1);

  const allergyAt = text.indexOf('peanuts');
  const attendanceAt = text.indexOf('No gym check-ins');
  const preferenceAt = text.indexOf('trains alone');

  assert.ok(allergyAt >= 0 && attendanceAt >= 0 && preferenceAt >= 0);
  assert.ok(allergyAt < attendanceAt, 'allergy must precede attendance');
  assert.ok(attendanceAt < preferenceAt, 'preference must come after attendance');
});

test('an injury is treated with the same priority as an allergy', async () => {
  state.memories = [mem('equipment', 'dumbbells only'), mem('injury_mentioned', 'left knee')];
  const { text } = await buildUserContextService(1);
  assert.ok(text.indexOf('left knee') < text.indexOf('No gym check-ins'));
  assert.ok(text.indexOf('dumbbells only') > text.indexOf('No gym check-ins'));
});

test('a goal outranks a preference but not an allergy', async () => {
  state.memories = [
    mem('preference', 'hates burpees'),
    mem('goal', 'wants to squat 100kg'),
    mem('allergy', 'shellfish'),
  ];
  const { text } = await buildUserContextService(1);
  assert.ok(text.indexOf('shellfish') < text.indexOf('wants to squat 100kg'));
  assert.ok(text.indexOf('wants to squat 100kg') < text.indexOf('hates burpees'));
});

test('a user at every cap still fits without truncation at all', async () => {
  // The claim the whole load-everything design rests on: KEY_POLICY's caps ARE
  // the budget. Build the absolute worst-case user — every key at its ceiling,
  // every value at the 80-char limit, five full workouts — and nothing is cut.
  // If this ever fails, either a cap or MAX_CONTEXT_CHARS moved, and memories
  // are silently being dropped from prompts again.
  const pad = (s) => s.padEnd(80, 'x').slice(0, 80);
  state.memories = [
    ...Array.from({ length: 6 }, (_, i) => mem('allergy', pad(`allergen ${i} `))),
    ...Array.from({ length: 6 }, (_, i) => mem('injury_mentioned', pad(`injury ${i} `))),
    mem('goal', pad('wants to add 5kg of muscle ')),
    ...Array.from({ length: 6 }, (_, i) => mem('equipment', pad(`equipment ${i} `))),
    ...Array.from({ length: 6 }, (_, i) => mem('preference', pad(`preference ${i} `))),
  ];
  state.sessions = Array.from({ length: 5 }, (_, i) => ({
    startedAt: new Date(`2026-09-0${i + 1}T07:00:00Z`),
    exercises: Array.from({ length: 4 }, () => ({
      exercise: { name: 'Barbell Back Squat' },
      sets: Array.from({ length: 5 }, () => ({})),
    })),
  }));

  const { text } = await buildUserContextService(1);

  assert.ok(!text.endsWith('…'), `truncation fired at ${text.length} chars`);
  // Every category present, first and last entry of each — nothing dropped.
  assert.ok(text.includes('allergen 0'), 'first allergy present');
  assert.ok(text.includes('allergen 5'), 'last allergy present');
  assert.ok(text.includes('preference 5'), 'last preference present');
  assert.ok(text.includes('wants to add 5kg'), 'goal present');
  assert.ok(text.includes('No gym check-ins'), 'attendance still present');

  state.sessions = [];
  state.memories = [];
});

test('the memory block is byte-identical when nothing about it changed', async () => {
  // The prompt prefix is cached by the provider, and cached tokens are half
  // price AND exempt from the rate limit. A block that reshuffles between turns
  // silently forfeits both — which is what ordering by updatedAt would do, since
  // restating a fact touches the row.
  state.memories = [
    { id: 3, key: 'preference', value: 'trains alone', updatedAt: '2026-09-01T00:00:00Z' },
    { id: 1, key: 'allergy', value: 'peanuts', updatedAt: '2026-09-01T00:00:00Z' },
    { id: 2, key: 'equipment', value: 'dumbbells only', updatedAt: '2026-09-01T00:00:00Z' },
  ];
  const first = (await buildUserContextService(1)).text;

  // Same rows, different arrival order, and one of them touched more recently.
  state.memories = [
    { id: 2, key: 'equipment', value: 'dumbbells only', updatedAt: '2026-09-19T00:00:00Z' },
    { id: 3, key: 'preference', value: 'trains alone', updatedAt: '2026-09-01T00:00:00Z' },
    { id: 1, key: 'allergy', value: 'peanuts', updatedAt: '2026-09-01T00:00:00Z' },
  ];
  const second = (await buildUserContextService(1)).text;

  assert.equal(first, second);
  state.memories = [];
});

test('no memories renders no memory headings at all', async () => {
  state.memories = [];
  const { text } = await buildUserContextService(1);
  assert.ok(!text.includes('Important —'));
  assert.ok(!text.includes('Things they have told the assistant'));
});

test('the audit still counts memories without copying them', async () => {
  state.memories = [mem('allergy', 'peanuts'), mem('goal', 'wants to squat 100kg')];
  const { audit } = await buildUserContextService(1);
  assert.equal(audit.memories, 2);
  assert.ok(!JSON.stringify(audit).includes('peanuts'));
});
