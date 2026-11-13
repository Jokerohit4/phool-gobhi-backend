// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The health profile reaches the coach in two lines: allergies at the very
// front with the safety memories, the lifestyle facts (including substance
// answers — the user's explicit choice) in the stable block after "how they
// train". Medicine NAMES never reach it; only that reminders exist.

let buildUserContextService;
const state = { profile: null, medCount: 0, memories: [] };

test('setup', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.workoutSession = { findMany: async () => [] };
          this.personalisationProfile = { findUnique: async () => null };
          this.assistantMemory = { findMany: async () => state.memories };
          this.weeklyGoal = { findUnique: async () => null };
          this.healthProfile = { findUnique: async () => state.profile };
          this.medicationReminder = {
            count: async () => state.medCount,
            findMany: async () => {
              throw new Error('the coach must never read medicine names');
            },
          };
        }
      },
      Prisma: {},
    },
  });
  t.mock.module('../utils/fetchAttendance.js', { exports: { fetchAttendanceSince: async () => [] } });
  t.mock.module('../utils/fetchUserProfile.js', { exports: { fetchUserProfileInternal: async () => null } });
  ({ buildUserContextService } = await import('../services/assistant/contextService.js'));
});

test('declared allergies come before attendance; lifestyle facts are present', async () => {
  state.profile = {
    allergyStatus: 'has',
    allergies: ['peanuts'],
    greens: 'weekly',
    whoCooks: 'family',
    medicationsStatus: 'has',
  };
  state.medCount = 1;
  const { text, audit } = await buildUserContextService(7);
  assert.ok(text.indexOf('peanuts') < text.indexOf('No gym check-ins'));
  assert.match(text, /Smokes cannabis about weekly/);
  assert.match(text, /Food is cooked by family/);
  assert.match(text, /Never advise on medicines/);
  assert.equal(audit.healthProfile, 2);
});

test('a missing profile costs nothing', async () => {
  state.profile = null;
  state.medCount = 0;
  const { text, audit } = await buildUserContextService(7);
  assert.doesNotMatch(text, /Health profile/);
  assert.equal(audit.healthProfile, 0);
});

test('worst-case profile plus worst-case memories still fits untruncated', async () => {
  const pad = (s, n) => s.padEnd(n, 'x').slice(0, n);
  state.profile = {
    allergyStatus: 'has',
    allergies: Array.from({ length: 12 }, (_, i) => pad(`allergen${i}`, 40)),
    drinking: 'occasionally', smoking: 'occasionally', greens: 'occasionally', otherSubstances: 'occasionally',
    broughtHere: ['get_fitter', 'lose_weight', 'build_muscle', 'stay_consistent', 'find_a_buddy', 'feel_better', 'doctor_suggested', 'just_curious'],
    mealsPerDay: 6, followsDiet: true, dietType: 'intermittent_fasting', whoCooks: 'outside',
    occupation: 'homemaker', workingHours: 'irregular', hometown: pad('Town', 60), medicationsStatus: 'has',
  };
  state.medCount = 3;
  state.memories = Array.from({ length: 25 }, (_, i) => ({
    id: i + 1, key: ['allergy', 'injury_mentioned', 'equipment', 'preference'][i % 4], value: pad(`m${i}`, 80),
  }));
  const { text } = await buildUserContextService(7);
  assert.ok(!text.endsWith('…'), `context was truncated at ${text.length} chars`);
});
