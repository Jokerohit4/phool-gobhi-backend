// Where each kind of memory lands in the prompt. Run with:
//   node --experimental-test-module-mocks --test
//
// The context block is truncated by slicing its tail at MAX_CONTEXT_CHARS, so
// position IS priority: whatever sits last is what disappears first. Memories
// used to sit last as one undifferentiated list, which meant a long workout
// history could silently cut an allergy out of the prompt. These tests pin the
// ordering that prevents it.
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

function mem(key, value) {
  return { key, value };
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

test('an allergy survives a context full enough to trigger truncation', async () => {
  // The whole point, built the way it would actually happen: a chatty user
  // accumulating preferences and equipment right up to the caps KEY_POLICY
  // allows, until the block overflows. Before tiering, the allergy sat in the
  // same undifferentiated list and was as likely to be cut as any of them.
  state.memories = [
    mem('allergy', 'peanuts'),
    ...Array.from({ length: 10 }, (_, i) =>
      mem('preference', `prefers training style number ${i} with a fairly wordy description`)
    ),
    ...Array.from({ length: 10 }, (_, i) =>
      mem('equipment', `owns a piece of equipment number ${i} described at some length`)
    ),
  ];
  state.sessions = Array.from({ length: 5 }, (_, i) => ({
    startedAt: new Date(`2026-09-0${i + 1}T07:00:00Z`),
    exercises: Array.from({ length: 4 }, () => ({
      exercise: { name: 'Barbell Back Squat' },
      sets: Array.from({ length: 5 }, () => ({})),
    })),
  }));

  const { text } = await buildUserContextService(1);

  assert.ok(text.length <= 1801, `context must stay capped, was ${text.length}`);
  assert.ok(text.includes('peanuts'), 'the allergy must survive truncation');
  // And what got cut is the tail of the tier-3 list, whose loss is harmless.
  assert.ok(!text.includes('equipment number 9'), 'the low-tier tail should be cut');
  // Attendance sits above tier 2/3 memories and must also survive.
  assert.ok(text.includes('No gym check-ins'));

  state.sessions = [];
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
