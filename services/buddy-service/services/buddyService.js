import { PrismaClient } from '@prisma/client';
import cloudinary from '../config/cloudinary.js';
import { track } from '../utils/analytics.js';
import { haversineKm, boundingBox, bucketDistanceKm } from '../utils/geo.js';
import { assertTierAllows } from '../utils/tier.js';
import { getUserInternal, getUsersBatchInternal } from './authClient.js';
import { notifyMatch } from '../utils/notifyMatch.js';
import { notifyMessage } from '../utils/notifyMessage.js';
import { MAX_BUDDY_PHOTOS } from '../utils/upload.js';

const prisma = new PrismaClient();

// Stranger-matching by physical proximity — this can't rest solely on
// auth-service's own validation holding forever, so buddy-service enforces
// its own floor at profile create time and on every demographic re-sync.
const MIN_AGE = 18;

const DEFAULT_FILTER = { radiusKm: 25, minAge: 18, maxAge: 60, genders: [], fitnessGoals: [] };

function ageFromDOB(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const monthDiff = now.getMonth() - d.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

// Never includes lat/lng or an exact distance — only a bucketed range (see
// utils/geo.js#bucketDistanceKm). This is the single seam all discovery/
// match responses go through so that guarantee can't be bypassed by a
// call site forgetting to strip coordinates.
function toPublicCandidate(profile, display) {
  return {
    userId: profile.userId,
    name: display?.name ?? 'Buddy',
    // Prefer the buddy profile's own curated photo over the account avatar
    // — every buddy profile has at least one (photos are required to save
    // one), while the account avatar is optional and often unset, which
    // otherwise leaves this summary field blank for no reason.
    profileImageUrl: profile.photos[0]?.url || display?.profileImageUrl || '',
    ageYears: ageFromDOB(profile.dateOfBirth),
    gender: profile.gender,
    bio: profile.bio || '',
    socialMediaUrl: profile.socialMediaUrl || null,
    fitnessGoals: profile.fitnessGoals,
    photos: profile.photos.map((p) => ({ id: p.id, url: p.url, order: p.order })),
    distanceRange: bucketDistanceKm(profile.distanceKm),
  };
}

// ---- Profile ----------------------------------------------------------

export async function getMyProfile(userId) {
  const profile = await prisma.buddyProfile.findUnique({
    where: { userId },
    include: { photos: { orderBy: { order: 'asc' } }, filter: true },
  });
  if (!profile) throw { status: 404, error: 'Buddy profile not found' };
  return profile;
}

export async function createOrUpdateProfile(userId, { bio, lat, lng, isDiscoverable, socialMediaUrl }) {
  const existing = await prisma.buddyProfile.findUnique({ where: { userId } });

  if (existing) {
    const data = {};
    if (bio !== undefined) data.bio = bio;
    if (lat !== undefined) data.lat = lat;
    if (lng !== undefined) data.lng = lng;
    if (isDiscoverable !== undefined) data.isDiscoverable = isDiscoverable;
    if (socialMediaUrl !== undefined) data.socialMediaUrl = socialMediaUrl || null;
    return prisma.buddyProfile.update({ where: { userId }, data });
  }

  if (lat == null || lng == null) {
    throw { status: 400, error: 'lat and lng are required to create a buddy profile' };
  }

  // First-time creation pulls demographic fields from auth-service (the
  // source of truth) — see services/authClient.js — and hard-gates on age
  // here as defense-in-depth.
  const authUser = await getUserInternal(userId);
  if (!authUser.dateOfBirth) {
    throw { status: 400, error: 'Set your date of birth in your account profile before creating a buddy profile' };
  }
  const age = ageFromDOB(authUser.dateOfBirth);
  if (age < MIN_AGE) {
    throw { status: 403, error: 'You must be 18 or older to use buddy matching' };
  }

  const created = await prisma.buddyProfile.create({
    data: {
      userId,
      bio: bio || null,
      socialMediaUrl: socialMediaUrl || null,
      lat,
      lng,
      gender: authUser.gender || null,
      dateOfBirth: new Date(authUser.dateOfBirth),
      fitnessGoals: authUser.fitnessGoals || [],
      lastSyncedAt: new Date(),
    },
  });
  track('buddy_profile_created', userId, {});
  return created;
}

// Re-pulls gender/dateOfBirth/fitnessGoals from auth-service. Called by
// POST /internal/profile-sync/:userId (fired by auth-service after a
// profile edit) and by the manual POST /api/buddy/profile/refresh fallback.
// No-ops (returns null) if the user has no buddy profile yet — there's
// nothing to sync.
export async function syncProfileFromAuth(userId) {
  const existing = await prisma.buddyProfile.findUnique({ where: { userId } });
  if (!existing) return null;

  const authUser = await getUserInternal(userId);
  const age = authUser.dateOfBirth ? ageFromDOB(authUser.dateOfBirth) : null;
  if (age != null && age < MIN_AGE) {
    // DOB was edited downward below 18 post-creation — pause discoverability
    // rather than deleting the profile outright.
    await prisma.buddyProfile.update({ where: { userId }, data: { isDiscoverable: false } });
    throw { status: 403, error: 'You must be 18 or older to use buddy matching' };
  }

  return prisma.buddyProfile.update({
    where: { userId },
    data: {
      gender: authUser.gender || null,
      dateOfBirth: authUser.dateOfBirth ? new Date(authUser.dateOfBirth) : null,
      fitnessGoals: authUser.fitnessGoals || [],
      lastSyncedAt: new Date(),
    },
  });
}

export async function refreshProfileFromAuth(userId) {
  const result = await syncProfileFromAuth(userId);
  if (!result) throw { status: 404, error: 'Buddy profile not found' };
  return result;
}

// ---- Photos -------------------------------------------------------------

export async function addPhotos(userId, files) {
  const profile = await prisma.buddyProfile.findUnique({ where: { userId }, include: { photos: true } });
  if (!profile) throw { status: 400, error: 'Create your buddy profile first' };
  if (profile.photos.length + files.length > MAX_BUDDY_PHOTOS) {
    throw { status: 409, error: `A buddy profile can have at most ${MAX_BUDDY_PHOTOS} photos` };
  }

  let nextOrder = profile.photos.length;
  const created = await prisma.$transaction(
    files.map((f) =>
      prisma.buddyPhoto.create({
        data: { buddyProfileId: profile.id, url: f.path, publicId: f.filename, order: nextOrder++ },
      })
    )
  );
  return created;
}

// One-way "use my main profile photo" shortcut — buddy and account photos
// stay on independent pipelines/models by design, this just clones the
// current account avatar in as one more buddy photo via Cloudinary's
// fetch-by-URL upload rather than requiring the client to download+re-upload
// the bytes itself.
export async function addPhotoFromUrl(userId, sourceUrl) {
  const profile = await prisma.buddyProfile.findUnique({ where: { userId }, include: { photos: true } });
  if (!profile) throw { status: 400, error: 'Create your buddy profile first' };
  if (profile.photos.length + 1 > MAX_BUDDY_PHOTOS) {
    throw { status: 409, error: `A buddy profile can have at most ${MAX_BUDDY_PHOTOS} photos` };
  }

  const uploaded = await cloudinary.uploader.upload(sourceUrl, {
    folder: 'phool-gobhi/buddy-profiles',
    transformation: [{ width: 1080, height: 1350, crop: 'limit', quality: 'auto' }],
  });
  return prisma.buddyPhoto.create({
    data: {
      buddyProfileId: profile.id,
      url: uploaded.secure_url,
      publicId: uploaded.public_id,
      order: profile.photos.length,
    },
  });
}

export async function reorderPhotos(userId, order) {
  const profile = await prisma.buddyProfile.findUnique({ where: { userId }, include: { photos: true } });
  if (!profile) throw { status: 404, error: 'Buddy profile not found' };

  const ownedIds = new Set(profile.photos.map((p) => p.id));
  if (order.length !== profile.photos.length || !order.every((id) => ownedIds.has(id))) {
    throw { status: 400, error: "order must include exactly this profile's photo ids" };
  }

  await prisma.$transaction(
    order.map((id, idx) => prisma.buddyPhoto.update({ where: { id }, data: { order: idx } }))
  );
  return prisma.buddyPhoto.findMany({ where: { buddyProfileId: profile.id }, orderBy: { order: 'asc' } });
}

export async function deletePhoto(userId, photoId) {
  const photo = await prisma.buddyPhoto.findUnique({ where: { id: photoId }, include: { buddyProfile: true } });
  if (!photo) throw { status: 404, error: 'Photo not found' };
  if (photo.buddyProfile.userId !== userId) throw { status: 403, error: 'Forbidden' };

  if (photo.publicId) {
    try {
      await cloudinary.uploader.destroy(photo.publicId);
    } catch (err) {
      console.error('Error deleting buddy photo from Cloudinary:', err.message);
    }
  }

  await prisma.buddyPhoto.delete({ where: { id: photoId } });
  return { message: 'Photo deleted' };
}

// ---- Filters --------------------------------------------------------------

export async function getFilters(userId) {
  const filter = await prisma.buddyFilter.findUnique({ where: { userId } });
  return filter || { userId, ...DEFAULT_FILTER };
}

export async function upsertFilters(userId, data, userType) {
  const profile = await prisma.buddyProfile.findUnique({ where: { userId } });
  if (!profile) throw { status: 400, error: 'Create your buddy profile first' };

  const { radiusKm, minAge, maxAge, genders, fitnessGoals } = data;

  if (radiusKm !== undefined) {
    assertTierAllows(userType, 'radiusKm');
    if (!Number.isInteger(radiusKm) || radiusKm < 1 || radiusKm > 100) {
      throw { status: 400, error: 'radiusKm must be an integer between 1 and 100' };
    }
  }
  if (genders !== undefined) assertTierAllows(userType, 'genders');
  if (fitnessGoals !== undefined) assertTierAllows(userType, 'fitnessGoals');
  if (minAge !== undefined || maxAge !== undefined) {
    assertTierAllows(userType, 'ageRange');
    if (minAge !== undefined && minAge < 18) throw { status: 400, error: 'minAge must be at least 18' };
    if (minAge !== undefined && maxAge !== undefined && minAge > maxAge) {
      throw { status: 400, error: 'minAge must be less than or equal to maxAge' };
    }
  }

  const existing = await prisma.buddyFilter.findUnique({ where: { userId } });
  const payload = {
    radiusKm: radiusKm ?? existing?.radiusKm ?? DEFAULT_FILTER.radiusKm,
    minAge: minAge ?? existing?.minAge ?? DEFAULT_FILTER.minAge,
    maxAge: maxAge ?? existing?.maxAge ?? DEFAULT_FILTER.maxAge,
    genders: genders ?? existing?.genders ?? DEFAULT_FILTER.genders,
    fitnessGoals: fitnessGoals ?? existing?.fitnessGoals ?? DEFAULT_FILTER.fitnessGoals,
  };

  return prisma.buddyFilter.upsert({
    where: { userId },
    update: payload,
    create: { userId, ...payload },
  });
}

// ---- Discovery --------------------------------------------------------------

export async function getFeed(userId, { page = 1, limit = 20 }) {
  page = Math.max(1, page);
  limit = Math.min(Math.max(1, limit), 50);

  const me = await prisma.buddyProfile.findUnique({ where: { userId } });
  if (!me) throw { status: 400, error: 'Create your buddy profile first' };

  const filter = (await prisma.buddyFilter.findUnique({ where: { userId } })) || DEFAULT_FILTER;

  const [swiped, blockedByMe, blockedMe] = await Promise.all([
    prisma.swipe.findMany({ where: { swiperId: userId }, select: { swipeeId: true } }),
    prisma.blockedUser.findMany({ where: { blockerId: userId }, select: { blockedId: true } }),
    prisma.blockedUser.findMany({ where: { blockedId: userId }, select: { blockerId: true } }),
  ]);
  const excludeIds = [
    userId,
    ...swiped.map((s) => s.swipeeId),
    ...blockedByMe.map((b) => b.blockedId),
    ...blockedMe.map((b) => b.blockerId),
  ];

  const box = boundingBox(me.lat, me.lng, filter.radiusKm);
  const now = new Date();
  // Older DOB = older age, so the min-age bound is the *later* cutoff date
  // and the max-age bound is the *earlier* one.
  const maxDob = new Date(now.getFullYear() - filter.minAge, now.getMonth(), now.getDate());
  const minDob = new Date(now.getFullYear() - filter.maxAge - 1, now.getMonth(), now.getDate());

  const where = {
    isActive: true,
    isDiscoverable: true,
    userId: { notIn: excludeIds },
    lat: { gte: box.minLat, lte: box.maxLat },
    lng: { gte: box.minLng, lte: box.maxLng },
    // minDob is exactly maxAge+1 years back — `gt`, not `gte`, since a
    // candidate born exactly on that date has already turned maxAge+1
    // (matches ageFromDOB's own reckoning, used to render their displayed
    // age elsewhere in this same response) and should be excluded.
    dateOfBirth: { gt: minDob, lte: maxDob },
  };
  if (filter.genders.length) where.gender = { in: filter.genders };
  if (filter.fitnessGoals.length) where.fitnessGoals = { hasSome: filter.fitnessGoals };

  // Hard cap per query as a worst-case bound — see prisma/schema.prisma's
  // note on the bounding-box+haversine strategy vs. real geo indexing.
  const candidates = await prisma.buddyProfile.findMany({
    where,
    include: { photos: { orderBy: { order: 'asc' }, take: MAX_BUDDY_PHOTOS } },
    take: 300,
  });

  const withDistance = candidates
    .map((c) => ({ ...c, distanceKm: haversineKm(me.lat, me.lng, c.lat, c.lng) }))
    // The bounding box over-includes near its corners — this trims to the
    // exact circle.
    .filter((c) => c.distanceKm <= filter.radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const pageSlice = withDistance.slice((page - 1) * limit, page * limit);
  const displayInfo = await getUsersBatchInternal(pageSlice.map((c) => c.userId)).catch(() => []);
  const displayMap = new Map(displayInfo.map((u) => [u.id, u]));

  const data = pageSlice.map((c) => toPublicCandidate(c, displayMap.get(c.userId)));
  return { data, page, hasMore: page * limit < withDistance.length };
}

// ---- Swipes & matches ----------------------------------------------------

export async function recordSwipe(swiperId, swipeeId, action) {
  if (swiperId === swipeeId) throw { status: 400, error: 'Cannot swipe on yourself' };
  if (!['like', 'pass'].includes(action)) throw { status: 400, error: 'action must be "like" or "pass"' };

  const [blockedByMe, blockedMe] = await Promise.all([
    prisma.blockedUser.findUnique({ where: { blockerId_blockedId: { blockerId: swiperId, blockedId: swipeeId } } }),
    prisma.blockedUser.findUnique({ where: { blockerId_blockedId: { blockerId: swipeeId, blockedId: swiperId } } }),
  ]);
  if (blockedByMe || blockedMe) throw { status: 403, error: 'Cannot swipe on a blocked user' };

  // Idempotent: upsert instead of insert-and-catch, so a double-tap of the
  // same action is a no-op and changing your mind (pass -> like) just
  // overwrites the row rather than erroring.
  await prisma.swipe.upsert({
    where: { swiperId_swipeeId: { swiperId, swipeeId } },
    update: { action },
    create: { swiperId, swipeeId, action },
  });
  track('buddy_swiped', swiperId, { action });

  if (action !== 'like') return { matched: false };

  const reverseLike = await prisma.swipe.findUnique({
    where: { swiperId_swipeeId: { swiperId: swipeeId, swipeeId: swiperId } },
  });
  if (!reverseLike || reverseLike.action !== 'like') return { matched: false };

  const userLowId = Math.min(swiperId, swipeeId);
  const userHighId = Math.max(swiperId, swipeeId);

  let match;
  try {
    match = await prisma.match.create({ data: { userLowId, userHighId } });
  } catch (err) {
    if (err.code === 'P2002') {
      // The other side's near-simultaneous swipe already created this
      // match — read it back instead of erroring, so both requests
      // converge on the same matchId.
      match = await prisma.match.findUnique({ where: { userLowId_userHighId: { userLowId, userHighId } } });
    } else {
      throw err;
    }
  }

  track('buddy_matched', swiperId, { matchId: match.id, otherUserId: swipeeId });

  const infos = await getUsersBatchInternal([swiperId, swipeeId]).catch(() => []);
  const nameById = new Map(infos.map((u) => [u.id, u.name]));
  notifyMatch(swiperId, nameById.get(swipeeId) || 'your buddy');
  notifyMatch(swipeeId, nameById.get(swiperId) || 'your buddy');

  return { matched: true, matchId: match.id };
}

async function assertParticipant(matchId, userId) {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) throw { status: 404, error: 'Match not found' };
  if (match.userLowId !== userId && match.userHighId !== userId) throw { status: 403, error: 'Forbidden' };
  return match;
}

// Used by challenge-service (internal) to authorize a paired-streak opt-in —
// a customer only ever sends a matchId they already saw in their own
// matches list, never an arbitrary otherUserId, so this is what turns that
// matchId into a verified, mutual otherUserId rather than trusting the
// client's word for it.
export async function verifyActiveMatchMembership(matchId, userId) {
  const match = await prisma.match.findUnique({ where: { id: Number(matchId) } });
  if (!match || match.status !== 'active') return { matched: false };
  // Expiry applies here too, without the write: this is an internal
  // authorization check, and a match nobody has touched in 30 days is not a
  // live pairing. No need to persist `expired` on a read-only verification.
  const lastActivityAt = match.lastActivityAt ? new Date(match.lastActivityAt) : new Date(match.matchedAt);
  if (lastActivityAt < matchExpiryCutoff()) return { matched: false };
  if (match.userLowId !== userId && match.userHighId !== userId) return { matched: false };
  const otherUserId = match.userLowId === userId ? match.userHighId : match.userLowId;
  return { matched: true, otherUserId };
}

export async function getMatches(userId) {
  const matches = await prisma.match.findMany({
    where: {
      status: 'active',
      OR: [{ userLowId: userId }, { userHighId: userId }],
      // Lazy expiry, read side. Filtering here rather than writing first keeps
      // the list cheap and idempotent; assertActiveParticipant is what
      // eventually persists `expired` when a stale match is opened directly.
      lastActivityAt: { gte: matchExpiryCutoff() },
    },
    include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    orderBy: { matchedAt: 'desc' },
  });

  const otherIds = matches.map((m) => (m.userLowId === userId ? m.userHighId : m.userLowId));
  const [infos, buddyProfiles] = await Promise.all([
    getUsersBatchInternal(otherIds).catch(() => []),
    prisma.buddyProfile.findMany({
      where: { userId: { in: otherIds } },
      include: { photos: { orderBy: { order: 'asc' }, take: 1 } },
    }),
  ]);
  const infoMap = new Map(infos.map((u) => [u.id, u]));
  const primaryPhotoMap = new Map(buddyProfiles.map((p) => [p.userId, p.photos[0]?.url]));

  return matches.map((m) => {
    const otherUserId = m.userLowId === userId ? m.userHighId : m.userLowId;
    const other = infoMap.get(otherUserId);
    const lastMessage = m.messages[0];
    return {
      matchId: m.id,
      otherUser: {
        userId: otherUserId,
        name: other?.name ?? 'Buddy',
        // Same buddy-photo-over-account-avatar preference as toPublicCandidate.
        profileImageUrl: primaryPhotoMap.get(otherUserId) || other?.profileImageUrl || '',
      },
      lastMessage: lastMessage?.body ?? null,
      lastMessageAt: lastMessage?.createdAt ?? null,
      matchedAt: m.matchedAt,
    };
  });
}

// Full profile (photos + bio) of the other person in an active match — the
// only place besides discovery a profile is ever exposed, and only to a
// confirmed match, not a stranger. Same toPublicCandidate DTO as discovery
// so the bucketed-distance privacy guarantee applies here too.
export async function getMatchedProfile(userId, matchId) {
  const match = await assertActiveParticipant(matchId, userId);
  const otherUserId = match.userLowId === userId ? match.userHighId : match.userLowId;

  const [me, other] = await Promise.all([
    prisma.buddyProfile.findUnique({ where: { userId } }),
    prisma.buddyProfile.findUnique({
      where: { userId: otherUserId },
      include: { photos: { orderBy: { order: 'asc' } } },
    }),
  ]);
  if (!other) throw { status: 404, error: 'Buddy profile not found' };

  const distanceKm = me ? haversineKm(me.lat, me.lng, other.lat, other.lng) : null;
  const infos = await getUsersBatchInternal([otherUserId]).catch(() => []);
  return toPublicCandidate({ ...other, distanceKm }, infos[0]);
}

export async function unmatch(userId, matchId) {
  const match = await assertParticipant(matchId, userId);
  // Idempotent no-op if already inactive (block auto-unmatches too) —
  // otherwise a repeat call (e.g. a double-tap) overwrites unmatchedBy/At
  // with whoever called it last and double-fires the analytics event.
  if (match.status !== 'active') return match;
  const updated = await prisma.match.update({
    where: { id: matchId },
    data: { status: 'unmatched', unmatchedBy: userId, unmatchedAt: new Date() },
  });
  track('buddy_unmatched', userId, { matchId });
  return updated;
}

// ---- Chat -------------------------------------------------------------

// `after` (id > cursor, ascending) is for polling — the client's chat screen
// calls this every ~3s with its last-seen message id to pick up only what's
// new. `before` (id < cursor, descending then reversed) is for the initial
// load / scrolling up into older history. The two are mutually exclusive;
// `after` wins if both are somehow passed.
export async function getMessages(userId, matchId, { before, after, limit = 30 } = {}) {
  // Without this guard, a block does not actually end the conversation:
  // blockUser flips the match to `unmatched`, which hides it from getMatches and
  // 410s getMatchedProfile — but this reader only ever checked participation, so
  // the blocker could keep paging the full history by matchId for as long as they
  // held the id.
  await assertActiveParticipant(matchId, userId);
  const take = Math.min(Math.max(1, parseInt(limit) || 30), 100);
  const where = { matchId };

  if (after) {
    where.id = { gt: parseInt(after) };
    return prisma.chatMessage.findMany({ where, orderBy: { id: 'asc' }, take });
  }

  if (before) where.id = { lt: parseInt(before) };
  const messages = await prisma.chatMessage.findMany({ where, orderBy: { id: 'desc' }, take });
  return messages.reverse(); // oldest-first, so the client can append directly
}

export async function sendMessage(userId, matchId, body) {
  if (!body || !body.trim()) throw { status: 400, error: 'Message body is required' };

  const match = await assertActiveParticipant(matchId, userId, { inactiveStatus: 409 });

  const message = await prisma.chatMessage.create({
    data: { matchId, senderId: userId, body: body.slice(0, 1000) },
  });
  // Activity in either direction keeps the match alive; see Match.lastActivityAt.
  await prisma.match.update({
    where: { id: matchId },
    data: { lastActivityAt: new Date() },
  });
  track('buddy_message_sent', userId, { matchId });

  const recipientId = match.userLowId === userId ? match.userHighId : match.userLowId;
  const infos = await getUsersBatchInternal([userId]).catch(() => []);
  const senderName = infos[0]?.name ?? 'Someone';
  notifyMessage(recipientId, { senderName, preview: message.body.slice(0, 120), matchId });

  return message;
}

// ---- Blocks (v1 safety) ----------------------------------------------------

export async function blockUser(userId, targetUserId, reason) {
  if (userId === targetUserId) throw { status: 400, error: 'Cannot block yourself' };

  await prisma.blockedUser.upsert({
    where: { blockerId_blockedId: { blockerId: userId, blockedId: targetUserId } },
    update: { reason: reason ?? undefined },
    create: { blockerId: userId, blockedId: targetUserId, reason },
  });

  // Auto-unmatch: a block should sever any existing conversation, not just
  // hide the user from future discovery.
  const userLowId = Math.min(userId, targetUserId);
  const userHighId = Math.max(userId, targetUserId);
  const match = await prisma.match.findUnique({ where: { userLowId_userHighId: { userLowId, userHighId } } });
  if (match && match.status === 'active') {
    await prisma.match.update({
      where: { id: match.id },
      data: { status: 'unmatched', unmatchedBy: userId, unmatchedAt: new Date() },
    });
  }

  track('buddy_blocked', userId, { targetUserId });
  return { message: 'User blocked' };
}

export async function unblockUser(userId, targetUserId) {
  await prisma.blockedUser.deleteMany({ where: { blockerId: userId, blockedId: targetUserId } });
  return { message: 'User unblocked' };
}

export async function listBlocked(userId) {
  const rows = await prisma.blockedUser.findMany({ where: { blockerId: userId } });
  return rows.map((r) => r.blockedId);
}

// ---- Match expiry ---------------------------------------------------------

// How long a match can sit with no messages before it is considered dead.
// 30 days: long enough that a holiday or an injury pause does not lose the
// conversation, short enough that the match list is not a graveyard. Matches
// that never got a message still age out 30 days after matching, which is the
// intended behaviour for the "matched and then nothing" case.
export const MATCH_EXPIRY_DAYS = 30;

const matchExpiryCutoff = () =>
  new Date(Date.now() - MATCH_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

// Expiry is applied lazily, on read, rather than by a cron.
//
// A sweeper would need a schedule, a Cloud Run Job or a new route in three
// environments, and would still only be as timely as its own interval. Deciding
// staleness where the data is already being read means an expired match can
// never be served by the read that would have noticed it, with no new moving
// part and nothing to keep running.
//
// List queries filter on lastActivityAt and never write. Only this by-id guard
// writes, and only because it is already returning the row.
//
// `inactiveStatus` exists because the codebase already disagrees with itself
// here and the clients depend on that: sendMessage has always answered 409 for
// a dead match, getMatchedProfile answers 410. Unifying them would be tidier and
// would be a silent client-facing contract change, so each call site keeps the
// code its own client already handles.
async function assertActiveParticipant(matchId, userId, { inactiveStatus = 410 } = {}) {
  const match = await assertParticipant(matchId, userId);
  if (match.status !== 'active') {
    throw { status: inactiveStatus, error: 'This match is no longer active' };
  }
  // Defensive: `lastActivityAt` is NOT NULL with a default, but a row written
  // before the column existed would read back null. Treat that as stale rather
  // than as infinitely fresh, so the migration cannot leave old matches
  // un-expirable.
  const lastActivityAt = match.lastActivityAt ? new Date(match.lastActivityAt) : new Date(match.matchedAt);
  if (lastActivityAt < matchExpiryCutoff()) {
    await prisma.match.update({
      where: { id: match.id },
      data: { status: 'expired', unmatchedAt: new Date() },
    });
    track('buddy_match_expired', userId, { matchId: match.id });
    throw { status: inactiveStatus, error: `This match expired after ${MATCH_EXPIRY_DAYS} days of inactivity` };
  }
  return match;
}

// ---- Reports --------------------------------------------------------------

// Filing a report severs an active match with the reported user, same as a
// block. Rationale: a report is filed *because* someone is making the reporter
// uncomfortable, and "we have logged your report but you are still matched with
// them" is not relief. It does NOT create a block — that stays the user's own
// explicit choice, because a block also removes them from the other person's
// view and they may not want that. So: the conversation is severed for them,
// and discovery is untouched in both directions unless they also block.
export async function reportUser(userId, reportedUserId, reason, details) {
  if (userId === reportedUserId) throw { status: 400, error: 'Cannot report yourself' };

  const report = await prisma.report.create({
    data: { reporterId: userId, reportedUserId, reason, details: details?.slice(0, 1000) ?? null },
  });
  track('buddy_reported', userId, { reportedUserId, reason });

  const userLowId = Math.min(userId, reportedUserId);
  const userHighId = Math.max(userId, reportedUserId);
  const match = await prisma.match.findUnique({
    where: { userLowId_userHighId: { userLowId, userHighId } },
    select: { id: true, status: true },
  });
  let severedMatchId = null;
  if (match && match.status === 'active') {
    await prisma.match.update({
      where: { id: match.id },
      data: { status: 'unmatched', unmatchedBy: userId, unmatchedAt: new Date() },
    });
    severedMatchId = match.id;
  }

  return { reportId: report.id, status: report.status, severedMatchId };
}

// Triage queue. Gobhi-only at the route layer; this function does no auth of
// its own, matching how listBlocked/getMatches are shaped.
export async function listReports({ status = 'open', limit = 50 } = {}) {
  const rows = await prisma.report.findMany({
    where: status === 'all' ? {} : { status },
    // id as a secondary key, not just cosmetics: createdAt has millisecond
    // resolution, so two reports can genuinely share a timestamp, and without a
    // tie-break their relative order is undefined. In a paginated queue that
    // means a report at a page boundary can be shown twice or skipped entirely.
    // id is monotonic, so this makes the ordering total and the paging stable.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(Math.max(1, parseInt(limit) || 50), 200),
  });
  // Resolve display names best-effort: a report must still be triageable when
  // auth-service is unreachable, so a failed lookup degrades to the raw id
  // rather than throwing and losing the queue.
  const ids = [...new Set(rows.flatMap((r) => [r.reporterId, r.reportedUserId]).filter(Boolean))];
  const infos = await getUsersBatchInternal(ids).catch(() => []);
  const nameMap = new Map(infos.map((u) => [u.id, u.name]));

  // "How many reports has this person ever had?" in ONE query, not one per row.
  // It is the number a triager weighs against the report in front of them, and
  // a 50-row queue turning into 50 count() round-trips is the kind of thing
  // that makes a moderation queue too slow to open. Null reportedUserId (an
  // erased subject) is excluded from the lookup entirely.
  const reportedIds = [...new Set(rows.map((r) => r.reportedUserId).filter((v) => v !== null && v !== undefined))];
  const priorCounts = new Map();
  if (reportedIds.length) {
    const priorRows = await prisma.report.findMany({
      where: { reportedUserId: { in: reportedIds } },
    });
    for (const r of priorRows) {
      priorCounts.set(r.reportedUserId, (priorCounts.get(r.reportedUserId) ?? 0) + 1);
    }
  }

  return rows.map((r) => {
    // minus one: the row itself is in priorRows, and "3 prior reports" must not
    // include the report being triaged.
    const prior = r.reportedUserId === null
      ? 0
      : Math.max(0, (priorCounts.get(r.reportedUserId) ?? 0) - 1);
    return {
      id: r.id,
      reason: r.reason,
      details: r.details,
      status: r.status,
      createdAt: r.createdAt,
      reviewedAt: r.reviewedAt,
      resolutionNote: r.resolutionNote,
      reporter: { userId: r.reporterId, name: nameMap.get(r.reporterId) ?? null },
      // reportedUserId is nullable by design — it is null once the reported user
      // has erased their account. The report survives; the pointer does not.
      reportedUser: r.reportedUserId === null
        ? { userId: null, name: null, erased: true }
        : { userId: r.reportedUserId, name: nameMap.get(r.reportedUserId) ?? null, erased: false },
      priorReportsAboutReportedUser: prior,
    };
  });
}

export async function reviewReport(reportId, { status, resolutionNote }, reviewedBy) {
  if (!['dismissed', 'actioned'].includes(status)) {
    throw { status: 400, error: 'status must be dismissed or actioned' };
  }
  const existing = await prisma.report.findUnique({ where: { id: Number(reportId) } });
  if (!existing) throw { status: 404, error: 'Report not found' };
  return prisma.report.update({
    where: { id: Number(reportId) },
    data: { status, resolutionNote: resolutionNote?.slice(0, 500) ?? null, reviewedBy, reviewedAt: new Date() },
  });
}
