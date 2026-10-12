// W7 buddy safety: reports, auto-hold, suspend/reinstate, the one eligibility
// rule (deck + likes-by-id), the two-way filter, visibility and women-only.
// Covers every bullet of the W7 card's "Tests must cover" list in
// docs/phool-gobhi-build-plan.html.
//
// Prisma is the shared filter-aware fake (support/fakePrisma.js): the safety
// rules live in WHERE clauses, so the fake evaluates them for real. Geo is the
// real haversine, so distance is genuinely checked.
//
// Run with: node --experimental-test-module-mocks --test test/buddySafety.test.js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakePrisma } from './support/fakePrisma.js';

// ── In-memory tables ────────────────────────────────────────────────────────
const tables = {
  buddyProfile: new Map(), buddyPhoto: new Map(), buddyFilter: new Map(),
  swipe: new Map(), match: new Map(), chatMessage: new Map(),
  blockedUser: new Map(), report: new Map(),
};
const fake = createFakePrisma(tables);

// auth-service's view of each user, read by profile create/sync.
const authUsers = new Map();
const events = [];
let seq = 1;

function resetAll() {
  for (const t of Object.values(tables)) t.clear();
  authUsers.clear();
  events.length = 0;
  seq = 1;
}

// ── File-level module mocks (the service is imported lazily below) ─────────
mock.module('@prisma/client', {
  exports: { PrismaClient: class { constructor() { return fake; } }, Prisma: {} },
});
mock.module('../services/authClient.js', {
  exports: {
    getUserInternal: async (id) => authUsers.get(id) ?? { id, dateOfBirth: null },
    getUsersBatchInternal: async (ids) => ids.map((id) => ({ id, name: `Person${id} Surname`, profileImageUrl: '' })),
  },
});
mock.module('../utils/analytics.js', {
  exports: { track: (event, distinctId, props) => { events.push({ event, distinctId, props }); } },
});
mock.module('../utils/notifyMatch.js', { exports: { notifyMatch: async () => {} } });
mock.module('../utils/notifyMessage.js', { exports: { notifyMessage: async () => {} } });
mock.module('../utils/tier.js', { exports: { assertTierAllows: () => {} } });
mock.module('../utils/upload.js', {
  exports: { MAX_BUDDY_PHOTOS: 6, uploadBuddyPhotos: { array: () => (req, res, next) => next() } },
});
mock.module('../config/cloudinary.js', {
  exports: { default: { uploader: { upload: async () => ({ secure_url: 'u', public_id: 'p' }), destroy: async () => {} } } },
});

const svc = await import('../services/buddyService.js');
const ctrl = await import('../controllers/buddyController.js');

// ── Seeding helpers ─────────────────────────────────────────────────────────
const DAY = 24 * 60 * 60 * 1000;
const BASE = { lat: 28.46, lng: 77.03 }; // Gurugram
// ~1.1 km per 0.01° of latitude.
const kmNorth = (km) => ({ lat: BASE.lat + km / 111, lng: BASE.lng });

function dob(age) {
  const now = new Date();
  // Birthday 10 days ago, so ageFromDOB() is exactly `age`.
  return new Date(now.getFullYear() - age, now.getMonth(), now.getDate() - 10);
}

// A visible, active, adult profile with 3 photos, 30 days old, at BASE.
// `filter: undefined` = no filter row ("accepts anyone").
function seedUser(userId, {
  gender = 'male', age = 28, at = BASE, filter, photos = 3, createdDaysAgo = 30, ...over
} = {}) {
  const id = 1000 + userId;
  tables.buddyProfile.set(id, {
    id, userId, bio: null, socialMediaUrl: null, gender, dateOfBirth: age == null ? null : dob(age),
    fitnessGoals: [], lastSyncedAt: null, lat: at.lat, lng: at.lng,
    isDiscoverable: true, isActive: true,
    createdAt: new Date(Date.now() - createdDaysAgo * DAY), updatedAt: new Date(),
    moderationHoldAt: null, genderChangedAt: null, genderChangedTo: null,
    genderChangeClearedAt: null, womenOnlyBlocked: false,
    ...over,
  });
  for (let i = 0; i < photos; i++) {
    const pid = id * 10 + i;
    tables.buddyPhoto.set(pid, { id: pid, buddyProfileId: id, url: `https://img/${userId}/${i}`, publicId: null, order: i, createdAt: new Date() });
  }
  if (filter) {
    const fid = 5000 + userId;
    tables.buddyFilter.set(fid, {
      id: fid, userId, radiusKm: 25, minAge: 18, maxAge: 60, genders: [], fitnessGoals: [], womenOnly: false,
      createdAt: new Date(), updatedAt: new Date(), ...filter,
    });
  }
}

const profileOf = (userId) => [...tables.buddyProfile.values()].find((p) => p.userId === userId);
const filterOf = (userId) => [...tables.buddyFilter.values()].find((f) => f.userId === userId);

function seedSwipe(swiperId, swipeeId, action = 'like') {
  tables.swipe.set(`${swiperId}-${swipeeId}`, { id: seq++, swiperId, swipeeId, action, createdAt: new Date() });
}
function seedMatch(a, b, status = 'active') {
  const id = 9000 + seq++;
  const now = new Date();
  tables.match.set(id, {
    id, userLowId: Math.min(a, b), userHighId: Math.max(a, b), status,
    unmatchedBy: null, unmatchedAt: null, matchedAt: now, lastActivityAt: now,
  });
  return id;
}
function seedBlock(blockerId, blockedId) {
  tables.blockedUser.set(`${blockerId}-${blockedId}`, { id: seq++, blockerId, blockedId, reason: null, createdAt: new Date() });
}

async function feedIds(userId) {
  const { data } = await svc.getFeed(userId, { page: 1, limit: 50 });
  return data.map((c) => c.userId).sort((a, b) => a - b);
}

async function rejectsWith(fn, code) {
  await assert.rejects(fn, (err) => {
    assert.equal(err.code, code, `expected ${code}, got ${JSON.stringify(err)}`);
    return true;
  });
}

// Minimal Express req/res doubles for calling controllers directly.
function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
async function callCtrl(handler, { userId, body = {}, params = {}, query = {} } = {}) {
  const res = fakeRes();
  await handler({ userId, body, params, query, headers: {} }, res);
  return res;
}

// =============================================================================
// Reports
// =============================================================================

test('reports: every old app label and every enum value is accepted', async () => {
  resetAll();
  seedUser(500);
  const legacy = {
    'Inappropriate or offensive content': ['inappropriate_content', null],
    'Harassment or abuse': ['harassment', null],
    'Spam or scam': ['scam', null],
    'Sharing personal contact details': ['other', 'Shared contact details'],
    'Something else': ['other', null],
  };
  let reporter = 1;
  for (const [label, [reason, details]] of Object.entries(legacy)) {
    const res = await callCtrl(ctrl.reportUser, { userId: reporter++, body: { userId: 500, reason: label } });
    assert.equal(res.statusCode, 201, label);
    const row = tables.report.get(res.body.reportId);
    assert.equal(row.reason, reason, label);
    assert.equal(row.details, details, label);
  }
  for (const reason of ctrl.REPORT_REASONS) {
    const res = await callCtrl(ctrl.reportUser, { userId: reporter++, body: { userId: 500, reason } });
    assert.equal(res.statusCode, 201, reason);
    assert.equal(tables.report.get(res.body.reportId).reason, reason);
  }
  // New builds: "Shared contact details" is `other` + details.
  const res = await callCtrl(ctrl.reportUser, {
    userId: reporter++, body: { userId: 500, reason: 'other', details: 'Shared contact details' },
  });
  assert.equal(res.statusCode, 201);
  const bad = await callCtrl(ctrl.reportUser, { userId: reporter++, body: { userId: 500, reason: 'rude' } });
  assert.equal(bad.statusCode, 400);
  assert.ok(bad.body.code);
});

test('reports: a suspended reporter is rejected with the contract sentence', async () => {
  resetAll();
  seedUser(1, { isActive: false });
  seedUser(2);
  const res = await callCtrl(ctrl.reportUser, { userId: 1, body: { userId: 2, reason: 'harassment' } });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    error: 'Your gym buddy access is suspended. Contact hello@phoolgobhi.com.',
    code: 'BUDDY_SUSPENDED',
  });
  assert.equal(tables.report.size, 0);
});

test('reports: a held reporter is accepted but does not count toward a hold', async () => {
  resetAll();
  seedUser(99); // reported
  seedUser(1); // qualifying
  seedUser(2, { moderationHoldAt: new Date(Date.now() - DAY) }); // held, otherwise qualifying
  seedUser(3); // qualifying
  for (const r of [1, 2, 3]) seedMatch(r, 99, 'unmatched');

  await svc.reportUser(1, 99, 'harassment');
  const held = await callCtrl(ctrl.reportUser, { userId: 2, body: { userId: 99, reason: 'harassment' } });
  assert.equal(held.statusCode, 201, 'held users can still file reports');
  assert.equal(profileOf(99).moderationHoldAt, null, 'a held reporter must not tip the count to 2');

  // A second qualifying reporter does — proving reporter 1 counted and 2 didn't.
  await svc.reportUser(3, 99, 'harassment');
  assert.ok(profileOf(99).moderationHoldAt instanceof Date);
});

test('reports: severity is set at creation (threat/underage high) and the queue sorts severity, then newest', async () => {
  resetAll();
  const r1 = await svc.reportUser(1, 50, 'spam');        // oldest, normal
  const r2 = await svc.reportUser(2, 51, 'threat');      // high
  const r3 = await svc.reportUser(3, 52, 'harassment');  // normal
  const r4 = await svc.reportUser(4, 53, 'underage');    // newest, high
  assert.equal(tables.report.get(r1.reportId).severity, 'normal');
  assert.equal(tables.report.get(r2.reportId).severity, 'high');
  assert.equal(tables.report.get(r3.reportId).severity, 'normal');
  assert.equal(tables.report.get(r4.reportId).severity, 'high');

  const rows = await svc.listReports({});
  assert.deepEqual(rows.map((r) => r.id), [r4.reportId, r2.reportId, r3.reportId, r1.reportId]);
});

test('reports: listReports rows carry priorReportCount, genderChanged, and the reported user photos + bio', async () => {
  resetAll();
  seedUser(70, { bio: 'gym at 6am', genderChangedAt: new Date('2026-09-01'), genderChangedTo: 'female' });
  await svc.reportUser(1, 70, 'spam');
  await svc.reportUser(2, 70, 'harassment');
  const [row] = await svc.listReports({});
  assert.equal(row.priorReportCount, 1);
  assert.equal(row.genderChanged, true);
  assert.equal(row.reportedUser.bio, 'gym at 6am');
  assert.equal(row.reportedUser.photos.length, 3);
  assert.equal(row.reportedUser.photos[0].url, 'https://img/70/0');
});

test('reports: the migration backfills threat/underage to high, after adding the column, idempotently', () => {
  const sql = readFileSync(new URL('../prisma/migrations/20261015130000_buddy_safety/migration.sql', import.meta.url), 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.match(code.trimStart(), /^SET lock_timeout = '3s';/, 'lock_timeout must be the first statement');
  const enumAt = code.indexOf('CREATE TYPE "buddy"."ReportSeverity"');
  const columnAt = code.indexOf('ADD COLUMN IF NOT EXISTS "severity"');
  const backfillAt = code.search(/UPDATE "buddy"\."Report" SET "severity" = 'high'/);
  assert.ok(enumAt > 0 && columnAt > enumAt && backfillAt > columnAt, 'enum, then column, then backfill');
  assert.match(code.slice(backfillAt), /"reason" IN \('threat', 'underage'\)/);
  assert.match(code, /EXCEPTION WHEN duplicate_object THEN NULL/);
  // Every new column is guarded so a re-run is a no-op.
  for (const col of ['severity', 'moderationHoldAt', 'genderChangedAt', 'genderChangedTo', 'genderChangeClearedAt', 'womenOnlyBlocked', 'womenOnly']) {
    assert.match(code, new RegExp(`ADD COLUMN IF NOT EXISTS "${col}"`), col);
  }
});

test('reports: schema declares Report.severity and puts ReportSeverity in the buddy schema', () => {
  const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  assert.match(schema, /enum ReportSeverity \{[^}]*normal[^}]*high[^}]*@@schema\("buddy"\)[^}]*\}/);
  assert.match(schema, /model Report \{[^}]*severity\s+ReportSeverity\s+@default\(normal\)/);
  assert.match(schema, /model BuddyProfile \{[^}]*genderChangeClearedAt\s+DateTime\?/);
});

test('reports: suspending on a report whose subject erased returns 409 REPORTED_USER_ERASED', async () => {
  resetAll();
  const { reportId } = await svc.reportUser(1, 60, 'threat');
  tables.report.get(reportId).reportedUserId = null; // erasureService nulls the pointer
  const res = await callCtrl(ctrl.reviewReport, {
    userId: 7, params: { id: String(reportId) }, body: { status: 'actioned', suspend: true },
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: 'This user has deleted their account.', code: 'REPORTED_USER_ERASED' });
  assert.equal(tables.report.get(reportId).status, 'open', 'nothing is half-applied');
  // Plain review still works.
  const ok = await callCtrl(ctrl.reviewReport, { userId: 7, params: { id: String(reportId) }, body: { status: 'dismissed' } });
  assert.equal(ok.statusCode, 200);
});

test('reports: context returns the last 20 messages of the pair, and nothing for a deck report', async () => {
  resetAll();
  const matchId = seedMatch(1, 2);
  for (let i = 0; i < 25; i++) {
    tables.chatMessage.set(i + 1, { id: i + 1, matchId, senderId: i % 2 ? 1 : 2, body: `m${i}`, createdAt: new Date(), readAt: null });
  }
  const { reportId } = await svc.reportUser(1, 2, 'harassment');
  const { messages } = await svc.getReportContext(reportId);
  assert.equal(messages.length, 20);
  assert.equal(messages[0].body, 'm5');
  assert.equal(messages[19].body, 'm24');
  assert.deepEqual(Object.keys(messages[0]).sort(), ['body', 'createdAt', 'fromUserId']);

  const deck = await svc.reportUser(3, 4, 'spam');
  assert.deepEqual(await svc.getReportContext(deck.reportId), { messages: [] });
});

// =============================================================================
// Likes by id (recordSwipe) — the shared eligibility rule
// =============================================================================

async function likeIsBlocked(setup, { code = 'TARGET_NOT_AVAILABLE', liker = 1, target = 2 } = {}) {
  resetAll();
  setup();
  await rejectsWith(() => svc.recordSwipe(liker, target, 'like'), code);
  assert.equal(tables.swipe.has(`${liker}-${target}`), false, 'nothing may be written');
  assert.equal(tables.match.size, 0);
}

test('likes by id: blocked when the target is suspended', () => likeIsBlocked(() => {
  seedUser(1); seedUser(2, { isActive: false });
}));
test('likes by id: blocked when the target is held', () => likeIsBlocked(() => {
  seedUser(1); seedUser(2, { moderationHoldAt: new Date() });
}));
test('likes by id: blocked when the target is hidden', () => likeIsBlocked(() => {
  seedUser(1); seedUser(2, { isDiscoverable: false });
}));
test('likes by id: blocked when either side blocked the other', async () => {
  await likeIsBlocked(() => { seedUser(1); seedUser(2); seedBlock(1, 2); });
  await likeIsBlocked(() => { seedUser(1); seedUser(2); seedBlock(2, 1); });
});
test('likes by id: blocked when either side reported the other', async () => {
  await likeIsBlocked(() => {
    seedUser(1); seedUser(2);
    tables.report.set(1, { id: 1, reporterId: 1, reportedUserId: 2, reason: 'spam', status: 'open', severity: 'normal', createdAt: new Date() });
  });
  await likeIsBlocked(() => {
    seedUser(1); seedUser(2);
    tables.report.set(1, { id: 1, reporterId: 2, reportedUserId: 1, reason: 'spam', status: 'open', severity: 'normal', createdAt: new Date() });
  });
});
test('likes by id: blocked when filtered out, either way', async () => {
  // Target only wants women; liker is a man.
  await likeIsBlocked(() => { seedUser(1, { gender: 'male' }); seedUser(2, { gender: 'female', filter: { genders: ['female'] } }); });
  // Liker only wants men; target is a woman.
  await likeIsBlocked(() => { seedUser(1, { gender: 'male', filter: { genders: ['male'] } }); seedUser(2, { gender: 'female' }); });
  // Target's age range excludes the liker.
  await likeIsBlocked(() => { seedUser(1, { age: 45 }); seedUser(2, { filter: { minAge: 20, maxAge: 30 } }); });
});
test('likes by id: blocked when too far, by either radius', async () => {
  await likeIsBlocked(() => { seedUser(1, { filter: { radiusKm: 5 } }); seedUser(2, { at: kmNorth(10) }); });
  await likeIsBlocked(() => { seedUser(1); seedUser(2, { at: kmNorth(10), filter: { radiusKm: 5 } }); });
});
test('likes by id: blocked when the target is women-only and the liker is not female', async () => {
  await likeIsBlocked(() => {
    seedUser(1, { gender: 'male' });
    seedUser(2, { gender: 'female', filter: { womenOnly: true, genders: ['female'] } });
  });
  // Also when a stale row has womenOnly on but genders not yet forced.
  await likeIsBlocked(() => {
    seedUser(1, { gender: 'male' });
    seedUser(2, { gender: 'female', filter: { womenOnly: true, genders: [] } });
  });
});
test('likes by id: blocked when the liker is hidden or held', async () => {
  await likeIsBlocked(() => { seedUser(1, { isDiscoverable: false }); seedUser(2); }, { code: 'NOT_DISCOVERABLE' });
  await likeIsBlocked(() => { seedUser(1, { moderationHoldAt: new Date() }); seedUser(2); }, { code: 'BUDDY_UNDER_REVIEW' });
  await likeIsBlocked(() => { seedUser(1, { isActive: false }); seedUser(2); }, { code: 'BUDDY_SUSPENDED' });
});

test('likes by id: changing a pass into a like still works (and can match)', async () => {
  resetAll();
  seedUser(1); seedUser(2);
  assert.deepEqual(await svc.recordSwipe(1, 2, 'pass'), { matched: false });
  seedSwipe(2, 1, 'like');
  const result = await svc.recordSwipe(1, 2, 'like');
  assert.equal(result.matched, true);
  assert.equal(tables.swipe.get('1-2').action, 'like');
});

test('regression: liking an ineligible user by id never matches some other user', async () => {
  resetAll();
  seedUser(1);
  seedUser(2, { moderationHoldAt: new Date() }); // the ineligible target
  seedUser(3); // eligible, and has already liked the swiper
  seedSwipe(3, 1, 'like');
  seedSwipe(1, 4, 'pass'); // something for a notIn to carry
  seedBlock(5, 1);

  await rejectsWith(() => svc.recordSwipe(1, 2, 'like'), 'TARGET_NOT_AVAILABLE');
  assert.equal(tables.match.size, 0, 'no match with anyone');
  assert.equal(tables.swipe.has('1-2'), false);
  assert.equal(tables.swipe.has('1-3'), false, 'the other user must not have been liked instead');

  // The rule composed the RIGHT way returns nothing for the target; the WRONG
  // way (spreading a userId:{notIn} over the target id) would find user 3.
  const rightWay = await fake.buddyProfile.findFirst({
    where: { AND: [{ userId: 2 }, svc.targetEligibility({ ...profileOf(1), filter: null }, [1, 4, 5])] },
  });
  assert.equal(rightWay, null);
  const wrongWay = await fake.buddyProfile.findFirst({
    where: { userId: 2, ...{ isActive: true, moderationHoldAt: null, userId: { notIn: [1, 4, 5] } } },
  });
  assert.equal(wrongWay?.userId, 3, 'sanity: the fake really does reproduce the spread bug');
});

// =============================================================================
// Hold
// =============================================================================

test('hold: 2 qualifying reporters within 30 days hold the user and fire buddy_auto_held', async () => {
  resetAll();
  seedUser(99);
  seedUser(1); seedUser(2);
  seedMatch(1, 99, 'expired'); // a Match row of ANY status qualifies
  seedSwipe(99, 2, 'like'); // ... or having been liked BY the reported user

  await svc.reportUser(1, 99, 'harassment');
  assert.equal(profileOf(99).moderationHoldAt, null, 'one report never holds');
  await svc.reportUser(2, 99, 'scam');
  assert.ok(profileOf(99).moderationHoldAt instanceof Date);

  const held = events.filter((e) => e.event === 'buddy_auto_held');
  assert.equal(held.length, 1);
  assert.equal(held[0].distinctId, 99);
  assert.equal(held[0].props.reporter_count, 2);

  // Held: gone from decks, and can't browse or swipe.
  seedUser(3);
  assert.deepEqual(await feedIds(3), [1, 2]);
  await rejectsWith(() => svc.getFeed(99, {}), 'BUDDY_UNDER_REVIEW');
});

test('hold: no hold from 2 rejected likers (they liked him, he never liked them)', async () => {
  resetAll();
  seedUser(99); seedUser(1); seedUser(2);
  seedSwipe(1, 99, 'like'); seedSwipe(99, 1, 'pass');
  seedSwipe(2, 99, 'like'); seedSwipe(99, 2, 'pass');
  await svc.reportUser(1, 99, 'harassment');
  await svc.reportUser(2, 99, 'harassment');
  assert.equal(profileOf(99).moderationHoldAt, null);
  assert.equal(events.filter((e) => e.event === 'buddy_auto_held').length, 0);
});

test('hold: no hold from 2 accounts under 7 days old', async () => {
  resetAll();
  seedUser(99);
  seedUser(1, { createdDaysAgo: 3 }); seedUser(2, { createdDaysAgo: 6 });
  seedMatch(1, 99); seedMatch(2, 99);
  await svc.reportUser(1, 99, 'harassment');
  await svc.reportUser(2, 99, 'harassment');
  assert.equal(profileOf(99).moderationHoldAt, null);
});

test('hold: no hold from a single threat (it tops the queue instead)', async () => {
  resetAll();
  seedUser(99); seedUser(1);
  seedMatch(1, 99);
  const { reportId } = await svc.reportUser(1, 99, 'threat');
  assert.equal(profileOf(99).moderationHoldAt, null);
  assert.equal(tables.report.get(reportId).severity, 'high');
});

test('hold: reports older than 30 days do not count', async () => {
  resetAll();
  seedUser(99); seedUser(1); seedUser(2);
  seedMatch(1, 99); seedMatch(2, 99);
  tables.report.set(1, {
    id: 1, reporterId: 1, reportedUserId: 99, reason: 'spam', status: 'open', severity: 'normal',
    createdAt: new Date(Date.now() - 31 * DAY),
  });
  await svc.reportUser(2, 99, 'spam');
  assert.equal(profileOf(99).moderationHoldAt, null);
});

test('hold: PUT /profile cannot clear a hold or a suspension', async () => {
  resetAll();
  const heldAt = new Date('2026-10-01');
  seedUser(1, { moderationHoldAt: heldAt, isActive: false });
  const res = await callCtrl(ctrl.upsertProfile, {
    userId: 1, body: { bio: 'new bio', isActive: true, moderationHoldAt: null },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(profileOf(1).bio, 'new bio');
  assert.equal(profileOf(1).moderationHoldAt, heldAt);
  assert.equal(profileOf(1).isActive, false);
});

test('hold: a held user can still chat but cannot swipe or browse', async () => {
  resetAll();
  seedUser(1, { moderationHoldAt: new Date() }); seedUser(2); seedUser(3);
  const matchId = seedMatch(1, 2);

  const sent = await svc.sendMessage(1, matchId, 'still here');
  assert.equal(sent.body, 'still here');
  assert.equal((await svc.getMessages(2, matchId)).length, 1, 'the other side still reads it');
  assert.equal((await svc.getMatches(1)).length, 1);
  assert.equal((await svc.getMatches(2)).length, 1, 'a hold does not hide the match');

  await rejectsWith(() => svc.recordSwipe(1, 3, 'like'), 'BUDDY_UNDER_REVIEW');
  await rejectsWith(() => svc.getFeed(1, {}), 'BUDDY_UNDER_REVIEW');
  const res = await callCtrl(ctrl.swipe, { userId: 1, body: { targetUserId: 3, action: 'like' } });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Your profile is being reviewed. Your open chats still work.', code: 'BUDDY_UNDER_REVIEW' });
});

test('hold: release-hold clears moderationHoldAt only', async () => {
  resetAll();
  seedUser(1, { moderationHoldAt: new Date(), isActive: false });
  await svc.releaseHold(1);
  assert.equal(profileOf(1).moderationHoldAt, null);
  assert.equal(profileOf(1).isActive, false);
  await assert.rejects(() => svc.releaseHold(404), (e) => e.status === 404);
});

// =============================================================================
// Suspend and reinstate
// =============================================================================

test('suspend: ends every active match on both sides in one go, and nothing else', async () => {
  resetAll();
  seedUser(1); seedUser(50); seedUser(99);
  const low = seedMatch(1, 50);   // 50 is the HIGH side here
  const high = seedMatch(50, 99); // 50 is the LOW side here
  const unrelated = seedMatch(1, 99);
  const { reportId } = await svc.reportUser(1, 50, 'harassment');
  assert.equal(tables.match.get(low).status, 'unmatched', 'the report itself severs the reporter match');
  tables.match.get(low).status = 'active'; // put it back so suspension has two to end

  const res = await callCtrl(ctrl.reviewReport, {
    userId: 7, params: { id: String(reportId) }, body: { status: 'actioned', suspend: true, resolutionNote: 'threats' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.endedMatches, 2);
  assert.equal(profileOf(50).isActive, false);
  assert.equal(tables.match.get(low).status, 'unmatched');
  assert.equal(tables.match.get(high).status, 'unmatched');
  assert.equal(tables.match.get(unrelated).status, 'active');
  assert.equal(tables.report.get(reportId).status, 'actioned');

  // Suspension ends everything for them.
  await rejectsWith(() => svc.getFeed(50, {}), 'BUDDY_SUSPENDED');
  await rejectsWith(() => svc.getMatches(50), 'BUDDY_SUSPENDED');
  await rejectsWith(() => svc.reportUser(50, 1, 'spam'), 'BUDDY_SUSPENDED');
  assert.ok(!(await feedIds(99)).includes(50));
});

test('suspend: requires status actioned', async () => {
  resetAll();
  const { reportId } = await svc.reportUser(1, 2, 'spam');
  await assert.rejects(() => svc.reviewReport(reportId, { status: 'dismissed', suspend: true }, 7), (e) => e.status === 400);
});

test('suspend: matches whose other side is suspended are hidden and closed', async () => {
  resetAll();
  seedUser(1); seedUser(2, { isActive: false });
  const matchId = seedMatch(1, 2); // a straggler the suspension somehow missed
  assert.equal((await svc.getMatches(1)).length, 0);
  await assert.rejects(() => svc.getMessages(1, matchId), (e) => e.status === 410);
  await assert.rejects(() => svc.sendMessage(1, matchId, 'hi'), (e) => e.status === 409);
  await assert.rejects(() => svc.getMatchedProfile(1, matchId), (e) => e.status === 410);
});

test('reinstate: brings back the deck, not the old chats', async () => {
  resetAll();
  seedUser(1); seedUser(50); seedUser(3);
  const old = seedMatch(1, 50);
  const { reportId } = await svc.reportUser(3, 50, 'harassment');
  tables.match.get(old).status = 'active';
  await svc.reviewReport(reportId, { status: 'actioned', suspend: true }, 7);
  assert.equal(tables.match.get(old).status, 'unmatched');

  profileOf(50).moderationHoldAt = new Date();
  await svc.reinstateUser(50);
  assert.equal(profileOf(50).isActive, true);
  assert.equal(profileOf(50).moderationHoldAt, null);

  // Deck is back (1 is visible again; 3 reported them so stays excluded) ...
  assert.deepEqual(await feedIds(50), [1]);
  // ... but the old chat stays closed.
  assert.equal(tables.match.get(old).status, 'unmatched');
  await assert.rejects(() => svc.getMessages(1, old), (e) => e.status === 410);
  assert.equal((await svc.getMatches(50)).length, 0);
});

// =============================================================================
// Two-way filter
// =============================================================================

test('two-way filter: gender works both ways', async () => {
  resetAll();
  seedUser(1, { gender: 'male' });
  seedUser(2, { gender: 'female', filter: { genders: ['female'] } }); // wants women only
  seedUser(3, { gender: 'female', filter: { genders: ['male', 'female'] } });
  seedUser(4, { gender: 'female' }); // no filter row: accepts anyone
  assert.deepEqual(await feedIds(1), [3, 4]);

  seedUser(5, { gender: 'female' });
  assert.ok((await feedIds(5)).includes(2), 'a woman passes her [female] filter');
});

test('two-way filter: a viewer with no gender only sees people with no gender preference', async () => {
  resetAll();
  seedUser(1, { gender: null });
  seedUser(2, { filter: { genders: ['male'] } });
  seedUser(3, { filter: { genders: [] } });
  seedUser(4); // no filter row
  assert.deepEqual(await feedIds(1), [3, 4]);
});

test('two-way filter: age works both ways', async () => {
  resetAll();
  seedUser(1, { age: 40 });
  seedUser(2, { age: 35, filter: { minAge: 20, maxAge: 30 } }); // 40 is too old for them
  seedUser(3, { age: 35, filter: { minAge: 30, maxAge: 45 } });
  assert.deepEqual(await feedIds(1), [3]);

  // A 26-year-old who wants 30-50: sees 1 (40, no row) and 2 (35, wants
  // 20-30), but not 3 — 35 suits her, 26 doesn't suit 3 (wants 30-45).
  seedUser(4, { age: 26, filter: { minAge: 30, maxAge: 50 } });
  assert.deepEqual(await feedIds(4), [1, 2]);
});

test('two-way filter: over-60s are not dropped when the other side has no filter row', async () => {
  resetAll();
  seedUser(1, { age: 65 }); // no filter row
  seedUser(2, { age: 30 }); // no filter row: accepts anyone
  seedUser(3, { age: 30, filter: {} }); // explicit default row: 18-60
  assert.deepEqual(await feedIds(1), [2], 'a 65-year-old sees people without a filter row');
  assert.deepEqual(await feedIds(2), [1, 3], 'and is seen by them (no 18-60 default applied to a missing row)');
  assert.ok(!(await feedIds(3)).includes(1), 'an explicit 18-60 row still excludes 65');
});

test('two-way filter: distance is checked against both radii', async () => {
  resetAll();
  seedUser(1); // default 25 km
  seedUser(2, { at: kmNorth(10), filter: { radiusKm: 5 } }); // 1 is outside 2's radius
  seedUser(3, { at: kmNorth(10), filter: { radiusKm: 15 } });
  seedUser(4, { at: kmNorth(40) }); // outside 1's radius; no row on 4 (accepts any distance)
  assert.deepEqual(await feedIds(1), [3]);
  assert.ok((await feedIds(4)).length === 0, '4 has the default 25 km for their own deck');
});

test('two-way filter: no DOB → DOB_REQUIRED, hidden viewer → NOT_DISCOVERABLE (no lurking)', async () => {
  resetAll();
  seedUser(1, { age: null });
  seedUser(2, { isDiscoverable: false });
  const dobRes = await callCtrl(ctrl.getDiscoveryFeed, { userId: 1 });
  assert.equal(dobRes.statusCode, 403);
  assert.deepEqual(dobRes.body, { error: 'Add your date of birth to start browsing.', code: 'DOB_REQUIRED' });
  const hidden = await callCtrl(ctrl.getDiscoveryFeed, { userId: 2 });
  assert.equal(hidden.statusCode, 403);
  assert.deepEqual(hidden.body, {
    error: "Add 3 photos and turn on 'Show my profile' to start browsing.",
    code: 'NOT_DISCOVERABLE',
  });
});

test('two-way filter: the deck excludes self, swiped, blocked and reported users', async () => {
  resetAll();
  seedUser(1); seedUser(2); seedUser(3); seedUser(4); seedUser(5); seedUser(6);
  seedSwipe(1, 2, 'pass');
  seedBlock(3, 1);
  await svc.reportUser(4, 1, 'spam');
  assert.deepEqual(await feedIds(1), [5, 6]);
});

// =============================================================================
// Visibility
// =============================================================================

test('visibility: a new profile starts hidden even when the app sends isDiscoverable:true', async () => {
  resetAll();
  authUsers.set(1, { id: 1, gender: 'male', dateOfBirth: dob(30).toISOString(), fitnessGoals: [] });
  const res = await callCtrl(ctrl.upsertProfile, { userId: 1, body: { lat: 28.4, lng: 77.0, isDiscoverable: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.isDiscoverable, false);
  assert.equal(res.body.code, 'PHOTOS_REQUIRED');
  assert.equal(profileOf(1).isDiscoverable, false);
});

test('visibility: fewer than 3 photos stays hidden (200 PHOTOS_REQUIRED); a bio edit still saves', async () => {
  resetAll();
  seedUser(1, { photos: 2, isDiscoverable: false });
  const res = await callCtrl(ctrl.upsertProfile, { userId: 1, body: { isDiscoverable: true, bio: 'lifting at 7' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.code, 'PHOTOS_REQUIRED');
  assert.equal(res.body.message, 'Add 3 photos to be visible.');
  assert.equal(res.body.data.isDiscoverable, false);
  assert.equal(profileOf(1).bio, 'lifting at 7');

  const bioOnly = await callCtrl(ctrl.upsertProfile, { userId: 1, body: { bio: 'mornings' } });
  assert.equal(bioOnly.statusCode, 200);
  assert.equal(bioOnly.body.code, undefined);
  assert.equal(profileOf(1).bio, 'mornings');
});

test('visibility: with 3 photos the user can turn it on; adding photos alone never does', async () => {
  resetAll();
  seedUser(1, { photos: 2, isDiscoverable: false });
  await svc.addPhotos(1, [{ path: 'https://img/new', filename: 'p' }]);
  assert.equal(profileOf(1).isDiscoverable, false, 'consent: photos are not an opt-in');
  const res = await callCtrl(ctrl.upsertProfile, { userId: 1, body: { isDiscoverable: true } });
  assert.equal(res.body.code, undefined);
  assert.equal(profileOf(1).isDiscoverable, true);
});

test('visibility: deleting photos below 3 hides the profile again', async () => {
  resetAll();
  seedUser(1, { photos: 3 });
  const [firstPhoto] = [...tables.buddyPhoto.values()];
  const result = await svc.deletePhoto(1, firstPhoto.id);
  assert.equal(result.code, 'PHOTOS_REQUIRED');
  assert.equal(profileOf(1).isDiscoverable, false);
});

// =============================================================================
// Women-only
// =============================================================================

test('women-only: a non-female profile cannot turn it on (400)', async () => {
  resetAll();
  seedUser(1, { gender: 'male' });
  const res = await callCtrl(ctrl.updateFilters, { userId: 1, body: { womenOnly: true } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'WOMEN_ONLY_NOT_ALLOWED');
  assert.equal(filterOf(1), undefined);
});

test('women-only: a woman can turn it on; genders is forced to [female] and the response has womenOnly', async () => {
  resetAll();
  seedUser(1, { gender: 'female' });
  const res = await callCtrl(ctrl.updateFilters, { userId: 1, body: { womenOnly: true, genders: ['male'] } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.womenOnly, true);
  assert.deepEqual(res.body.data.genders, ['female']);

  seedUser(2, { gender: 'male' }); seedUser(3, { gender: 'female' });
  assert.deepEqual(await feedIds(1), [3]);
  assert.ok(!(await feedIds(2)).includes(1), 'and men never see her');

  const off = await callCtrl(ctrl.updateFilters, { userId: 1, body: { womenOnly: false, genders: [] } });
  assert.equal(off.body.data.womenOnly, false);
  assert.ok((await feedIds(2)).includes(1));
});

test('women-only: a male→female change made BEFORE the buddy profile existed is caught', async () => {
  resetAll();
  seedUser(10, { gender: 'female', filter: { womenOnly: true, genders: ['female'] } });
  authUsers.set(1, {
    id: 1, gender: 'female', dateOfBirth: dob(30).toISOString(), fitnessGoals: [],
    genderChangedAt: '2026-09-01T00:00:00.000Z', genderChangedTo: 'female',
  });
  await svc.createOrUpdateProfile(1, { lat: BASE.lat, lng: BASE.lng });
  assert.equal(profileOf(1).womenOnlyBlocked, true);
  // Make him visible to test the deck.
  for (let i = 0; i < 3; i++) tables.buddyPhoto.set(77_000 + i, { id: 77_000 + i, buddyProfileId: profileOf(1).id, url: 'x', order: i });
  profileOf(1).isDiscoverable = true;

  assert.ok(!(await feedIds(1)).includes(10), 'he does not see her');
  assert.ok(!(await feedIds(10)).includes(1), 'she does not see him');
  await rejectsWith(() => svc.recordSwipe(1, 10, 'like'), 'TARGET_NOT_AVAILABLE');
});

test('women-only: a change AFTER the buddy profile, then Clear restores him, then a later change blocks again', async () => {
  resetAll();
  seedUser(10, { gender: 'female', filter: { womenOnly: true, genders: ['female'] } });
  seedUser(1, { gender: 'male' });
  assert.equal(profileOf(1).womenOnlyBlocked, false);

  // He changes male → female in the app; auth fires profile-sync.
  authUsers.set(1, {
    id: 1, gender: 'female', dateOfBirth: dob(28).toISOString(), fitnessGoals: [],
    genderChangedAt: new Date(Date.now() - DAY).toISOString(), genderChangedTo: 'female',
  });
  await svc.syncProfileFromAuth(1);
  assert.equal(profileOf(1).womenOnlyBlocked, true);
  assert.equal(profileOf(1).genderChangeClearedAt, null, 'sync never writes the clear');
  assert.ok(!(await feedIds(10)).includes(1));
  await rejectsWith(() => svc.recordSwipe(1, 10, 'like'), 'TARGET_NOT_AVAILABLE');

  // Admin sees him in the gender-change list ...
  const list = await svc.listGenderChanges();
  assert.deepEqual(list.map((r) => [r.userId, r.firstName, r.genderChangedTo]), [[1, 'Person1', 'female']]);

  // ... and clears him.
  await svc.clearGenderChange(1);
  assert.equal(profileOf(1).womenOnlyBlocked, false);
  assert.ok(profileOf(1).genderChangeClearedAt instanceof Date);
  assert.ok((await feedIds(10)).includes(1), 'Clear restores him');
  assert.equal((await svc.listGenderChanges()).length, 0);

  // A re-sync of the SAME change keeps him cleared ...
  await svc.syncProfileFromAuth(1);
  assert.equal(profileOf(1).womenOnlyBlocked, false);

  // ... but a later real change (female → male → female) blocks him again.
  authUsers.set(1, { ...authUsers.get(1), genderChangedAt: new Date(Date.now() + 1000).toISOString() });
  await svc.syncProfileFromAuth(1);
  assert.equal(profileOf(1).womenOnlyBlocked, true);
  assert.ok(!(await feedIds(10)).includes(1));
});

test('women-only: a plain [female] filter is covered by the guard too', async () => {
  resetAll();
  seedUser(10, { gender: 'female', filter: { genders: ['female'] } }); // not women-only mode
  seedUser(11, { gender: 'female' }); // no preference: the guard does not apply
  seedUser(1, {
    gender: 'female', genderChangedAt: new Date('2026-09-01'), genderChangedTo: 'female', womenOnlyBlocked: true,
  });
  assert.deepEqual(await feedIds(1), [11]);
  assert.ok(!(await feedIds(10)).includes(1));
  assert.ok((await feedIds(11)).includes(1));
});

test('women-only: existing matches are kept when the guard or the mode kicks in', async () => {
  resetAll();
  seedUser(10, { gender: 'female' });
  seedUser(1, { gender: 'male' });
  const matchId = seedMatch(1, 10);
  await callCtrl(ctrl.updateFilters, { userId: 10, body: { womenOnly: true } });
  authUsers.set(1, {
    id: 1, gender: 'female', dateOfBirth: dob(28).toISOString(), fitnessGoals: [],
    genderChangedAt: new Date().toISOString(), genderChangedTo: 'female',
  });
  await svc.syncProfileFromAuth(1);
  assert.equal(profileOf(1).womenOnlyBlocked, true);
  assert.equal(tables.match.get(matchId).status, 'active');
  assert.equal((await svc.getMatches(10)).length, 1);
  await svc.sendMessage(1, matchId, 'hi');
});

test('women-only: turns off when her synced gender changes away from female', async () => {
  resetAll();
  seedUser(10, { gender: 'female', filter: { womenOnly: true, genders: ['female'] } });
  authUsers.set(10, { id: 10, gender: 'male', dateOfBirth: dob(28).toISOString(), fitnessGoals: [],
    genderChangedAt: new Date().toISOString(), genderChangedTo: 'male' });
  await svc.syncProfileFromAuth(10);
  assert.equal(filterOf(10).womenOnly, false);
  assert.equal(profileOf(10).womenOnlyBlocked, false, 'only a change TO female is guarded');
});

test('sync: auth fields are optional (an older auth-service without W5)', async () => {
  resetAll();
  seedUser(1, { gender: 'male' });
  authUsers.set(1, { id: 1, gender: 'male', dateOfBirth: dob(30).toISOString(), fitnessGoals: [] });
  await svc.syncProfileFromAuth(1);
  assert.equal(profileOf(1).genderChangedAt, null);
  assert.equal(profileOf(1).genderChangedTo, null);
  assert.equal(profileOf(1).womenOnlyBlocked, false);
});

test('computeWomenOnlyBlocked follows the contract formula', () => {
  const t1 = new Date('2026-09-01'); const t2 = new Date('2026-09-10');
  assert.equal(svc.computeWomenOnlyBlocked({ genderChangedTo: 'female', genderChangedAt: t1, genderChangeClearedAt: null }), true);
  assert.equal(svc.computeWomenOnlyBlocked({ genderChangedTo: 'female', genderChangedAt: t1, genderChangeClearedAt: t2 }), false);
  assert.equal(svc.computeWomenOnlyBlocked({ genderChangedTo: 'female', genderChangedAt: t2, genderChangeClearedAt: t1 }), true);
  assert.equal(svc.computeWomenOnlyBlocked({ genderChangedTo: 'male', genderChangedAt: t2, genderChangeClearedAt: null }), false);
  assert.equal(svc.computeWomenOnlyBlocked({ genderChangedTo: null, genderChangedAt: null, genderChangeClearedAt: null }), false);
});
