// GET /me reads the User row through a narrow `select`. The response must stay
// byte-identical to the old full-row read: this pins it against a snapshot of
// the previous mapper, applied to a deliberately wide fixture row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePersona } from '../services/personaService.js';
import { bucketFor } from '../services/experimentService.js';

// Copy of the getMe response mapper from before the narrow select, plus the
// fields added since (each marked below).
function legacyMe(user, gymLinkSource, gymLinkStatus = null) {
  return {
    id: user.id, phone: user.phone, name: user.name, email: user.email, role: user.role, type: user.type,
    gender: user.gender, dateOfBirth: user.dateOfBirth, fitnessGoals: user.fitnessGoals,
    sportsPlayed: user.sportsPlayed ?? [], referralCode: user.referralCode, linkedGymId: user.linkedGymId,
    // gymLinkStatus (added with gym-side approval): whether the gym has confirmed the link.
    gymLinkSource, gymLinkStatus, trainerGymId: user.trainerGymId, leaderboardOptIn: user.leaderboardOptIn,
    experienceLevel: user.experienceLevel ?? null,
    // trainingTenure (added with the "how long?" follow-up): how long they have trained.
    trainingTenure: user.trainingTenure ?? null, homeUnclaimedGymId: user.homeUnclaimedGymId ?? null,
    pendingGymPromptGymId: user.pendingGymPromptGymId ?? null, gymLinkNotice: user.gymLinkNotice ?? null,
    firstVisitBadgeConsent: user.firstVisitBadgeConsent ?? false, currentlyWorksOut: user.currentlyWorksOut ?? null,
    workoutIntent: user.workoutIntent || null, wellnessFocuses: user.wellnessFocuses || [],
    wellnessDayPattern: user.wellnessDayPattern || null, wellnessSleepPattern: user.wellnessSleepPattern || null,
    wellnessSetupCompleted: user.wellnessSetupCompleted === true, trainingLocationPref: user.trainingLocationPref,
    trainingLocationOther: user.trainingLocationOther, appMode: user.appMode, persona: resolvePersona(user),
    freeTimeWindow: user.freeTimeWindow, gymSubscriptionEndDate: user.gymSubscriptionEndDate || null, experiments: bucketFor(user.id), recommendedEquipment: user.recommendedEquipment ?? null,
    // Added after the snapshot: the avatar the app reads from /me.
    profileImageUrl: user.profileImageUrl || '',
  };
}

function wideRow(overrides = {}) {
  return {
    id: 42, phone: '+919999999999', name: 'Asha', email: 'a@x.in', role: 'customer', type: 'general',
    gender: 'female', dateOfBirth: new Date('1995-05-05T00:00:00.000Z'), fitnessGoals: ['strength'],
    sportsPlayed: ['tennis'], referralCode: 'ASHA42', linkedGymId: null, trainerGymId: null, leaderboardOptIn: true,
    experienceLevel: 'beginner', trainingTenure: 'one_to_3_years', homeUnclaimedGymId: null, pendingGymPromptGymId: null, gymLinkNotice: null,
    firstVisitBadgeConsent: false, currentlyWorksOut: true, workoutIntent: 'strength', wellnessFocuses: [],
    wellnessDayPattern: null, wellnessSleepPattern: null, wellnessSetupCompleted: false,
    trainingLocationPref: 'home', trainingLocationOther: null, appMode: 'home_track', persona: null,
    freeTimeWindow: 'evening', recommendedEquipment: { items: ['mat'] },
    profileImageUrl: 'https://img.example/me.jpg',
    // Columns /me must NOT depend on:
    passwordHash: 'secret', fcmToken: 'tok', bankNote: 'x', createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

let stored; let linkRow; let selectSeen; let getMe; let ME_SELECT;

test('setup', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.user = { findUnique: async ({ select }) => {
            selectSeen = select;
            if (!stored) return null;
            if (!select) return { ...stored };
            return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, stored[k]]));
          } };
          this.gymLink = { findFirst: async () => linkRow };
        }
      },
      Prisma: {},
    },
  });
  ({ getMe, ME_SELECT } = await import('../controllers/authController.js'));
});

async function call() {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await getMe({ user: { id: 42 } }, res);
  return res;
}

test('unlinked user: /me is byte-identical to the legacy full-row mapper', async () => {
  stored = wideRow(); linkRow = null;
  const res = await call();
  assert.equal(JSON.stringify(res.body), JSON.stringify(legacyMe(stored, null)));
  assert.ok(selectSeen && !('passwordHash' in selectSeen));
});

test('linked user: gymLinkSource and persona are byte-identical too', async () => {
  stored = wideRow({ linkedGymId: 7, trainingLocationPref: 'gym', persona: null }); linkRow = { source: 'qr' };
  const res = await call();
  // Not a self link, so the gym's own doing: approved from the start.
  assert.equal(JSON.stringify(res.body), JSON.stringify(legacyMe(stored, 'qr', 'approved')));
  assert.equal(res.body.persona, 'linked_gym');
  stored = wideRow({ linkedGymId: 7, persona: 'wellness', wellnessFocuses: ['sleep'] }); linkRow = null;
  assert.equal(JSON.stringify((await call()).body), JSON.stringify(legacyMe(stored, null)));
});

test('missing user still 404s; select keeps resolvePersona inputs', async () => {
  stored = null;
  assert.equal((await call()).statusCode, 404);
  // resolvePersona() inputs must stay selectable.
  for (const k of ['persona', 'linkedGymId', 'homeUnclaimedGymId', 'appMode']) assert.ok(ME_SELECT[k], k);
});

test('gymLinkStatus: a self link nobody at the gym has answered is pending', async () => {
  stored = wideRow({ linkedGymId: 7, trainingLocationPref: 'gym' });
  linkRow = { source: 'self', approvedAt: null, firstVerifiedCheckinAt: null };
  const res = await call();
  assert.equal(res.body.gymLinkSource, 'self');
  assert.equal(res.body.gymLinkStatus, 'pending');
});

test('gymLinkStatus: approval or a verified check-in makes a self link approved', async () => {
  stored = wideRow({ linkedGymId: 7, trainingLocationPref: 'gym' });
  linkRow = { source: 'self', approvedAt: new Date(), firstVerifiedCheckinAt: null };
  assert.equal((await call()).body.gymLinkStatus, 'approved');
  linkRow = { source: 'self', approvedAt: null, firstVerifiedCheckinAt: new Date() };
  assert.equal((await call()).body.gymLinkStatus, 'approved');
});

test('gymLinkStatus: null with no gym, and with a pointer but no live link row', async () => {
  stored = wideRow(); linkRow = null;
  assert.equal((await call()).body.gymLinkStatus, null);
  stored = wideRow({ linkedGymId: 7 }); linkRow = null;
  assert.equal((await call()).body.gymLinkStatus, null);
});
