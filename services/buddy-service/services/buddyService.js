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
  if (match.userLowId !== userId && match.userHighId !== userId) return { matched: false };
  const otherUserId = match.userLowId === userId ? match.userHighId : match.userLowId;
  return { matched: true, otherUserId };
}

export async function getMatches(userId) {
  const matches = await prisma.match.findMany({
    where: { status: 'active', OR: [{ userLowId: userId }, { userHighId: userId }] },
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
  const match = await assertParticipant(matchId, userId);
  if (match.status !== 'active') throw { status: 410, error: 'This match is no longer active' };
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
  await assertParticipant(matchId, userId);
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

  const match = await assertParticipant(matchId, userId);
  if (match.status !== 'active') throw { status: 409, error: 'This match is no longer active' };

  const message = await prisma.chatMessage.create({
    data: { matchId, senderId: userId, body: body.slice(0, 1000) },
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
