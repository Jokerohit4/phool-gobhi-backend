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

const DEFAULT_FILTER = { radiusKm: 25, minAge: 18, maxAge: 60, genders: [], fitnessGoals: [], womenOnly: false };

// A visible profile needs at least this many photos (W7: consent before
// anyone is visible — photos AND an explicit "Show my profile").
export const MIN_VISIBLE_PHOTOS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
// Auto-hold window and the minimum buddy-profile age for a reporter to count.
const HOLD_WINDOW_DAYS = 30;
const QUALIFYING_PROFILE_AGE_DAYS = 7;
const HOLD_REPORTER_THRESHOLD = 2;

// Error contract (build plan, Buddy safety → Error codes): every error is
// { error: <readable sentence>, code }. Old app builds show `error` as-is via
// readable_error.dart, so the sentence has to tell the user what to do.
export const BUDDY_ERRORS = {
  BUDDY_SUSPENDED: { status: 403, error: 'Your gym buddy access is suspended. Contact hello@phoolgobhi.com.' },
  BUDDY_UNDER_REVIEW: { status: 403, error: 'Your profile is being reviewed. Your open chats still work.' },
  NOT_DISCOVERABLE: { status: 403, error: "Add 3 photos and turn on 'Show my profile' to start browsing." },
  DOB_REQUIRED: { status: 403, error: 'Add your date of birth to start browsing.' },
  PHOTOS_REQUIRED: { status: 200, error: 'Add 3 photos to be visible.' },
  REPORTED_USER_ERASED: { status: 409, error: 'This user has deleted their account.' },
  // Not in the contract table, but every error carries a code. Deliberately
  // vague: telling a liker *why* (e.g. "she is in women-only mode") would leak
  // the target's settings.
  TARGET_NOT_AVAILABLE: { status: 403, error: "This person isn't available right now. Keep browsing." },
  WOMEN_ONLY_NOT_ALLOWED: { status: 400, error: 'Women-only mode is only for profiles whose gender is female. Update your gender in your profile first.' },
};

function buddyError(code) {
  const { status, error } = BUDDY_ERRORS[code];
  return { status, error, code };
}

// Real reasons → severity (build plan, Report reasons). Threats and "seems
// under 18" jump the admin queue; nothing else does. Severity never causes a
// hold on its own — see reportUser.
const HIGH_SEVERITY_REASONS = new Set(['threat', 'underage']);
export function severityForReason(reason) {
  return HIGH_SEVERITY_REASONS.has(reason) ? 'high' : 'normal';
}

function ageFromDOB(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const monthDiff = now.getMonth() - d.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

// womenOnlyBlocked, per contract: a male→female change that an admin hasn't
// cleared (or that happened again after the last clear). Computed at every
// profile sync and at clear time; never written from anywhere else.
export function computeWomenOnlyBlocked({ genderChangedTo, genderChangedAt, genderChangeClearedAt }) {
  if (genderChangedTo !== 'female') return false;
  if (genderChangeClearedAt == null) return true;
  if (genderChangedAt == null) return false;
  return new Date(genderChangedAt) > new Date(genderChangeClearedAt);
}

// A woman whose own deck is women-only, or explicitly [female] only. These are
// the people a womenOnlyBlocked user is kept away from, both ways.
function isFemaleOnlyFilter(filter) {
  if (!filter) return false;
  if (filter.womenOnly) return true;
  return Array.isArray(filter.genders) && filter.genders.length === 1 && filter.genders[0] === 'female';
}

// The viewer's own gender preference. Women-only mode forces [female].
function effectiveGenders(filter) {
  if (!filter) return [];
  return filter.womenOnly ? ['female'] : (filter.genders || []);
}

// The ONE eligibility rule for "may this viewer see / like this target",
// shared by getFeed and recordSwipe so the deck and likes-by-id can never
// disagree. Returns a single Prisma where-clause; callers must AND it with any
// target id rather than spreading it:
//
//   RIGHT: findFirst({ where: { AND: [{ userId: swipeeId }, targetEligibility(viewer, ids)] } })
//
// Everything that can be expressed in SQL is here, so it runs before the
// 300-row cap. Distance (both radii) is the one rule left to JS — see
// distanceAcceptsBothWays.
//
// `viewer` is the viewer's BuddyProfile with `filter` included. A missing
// filter row means "accepts anyone" — on either side. In particular the 18–60
// defaults are NOT applied to a missing row, or everyone over 60 disappears.
// `excludedIds`: blocked/reported both ways, plus (feed only) self and
// already-swiped.
export function targetEligibility(viewer, excludedIds = []) {
  const viewerFilter = viewer.filter || null;
  const viewerAge = ageFromDOB(viewer.dateOfBirth);
  const now = new Date();
  const and = [
    // Active, discoverable and not held.
    { isActive: true },
    { isDiscoverable: true },
    { moderationHoldAt: null },
    // Every visible profile has a DOB; one that lost it in a sync can't be
    // age-checked, so it isn't shown.
    { dateOfBirth: { not: null } },
  ];
  if (excludedIds.length) and.push({ userId: { notIn: excludedIds } });

  // ---- The viewer's preferences, applied to the target ----
  const genders = effectiveGenders(viewerFilter);
  if (genders.length) and.push({ gender: { in: genders } });
  if (viewerFilter) {
    // Older DOB = older age, so the min-age bound is the *later* cutoff date
    // and the max-age bound is the *earlier* one. minDob is exactly maxAge+1
    // years back — `gt`, not `gte`, since someone born exactly on that date
    // has already turned maxAge+1 (matches ageFromDOB's reckoning).
    const maxDob = new Date(now.getFullYear() - viewerFilter.minAge, now.getMonth(), now.getDate());
    const minDob = new Date(now.getFullYear() - viewerFilter.maxAge - 1, now.getMonth(), now.getDate());
    and.push({ dateOfBirth: { gt: minDob, lte: maxDob } });
    if (viewerFilter.fitnessGoals?.length) and.push({ fitnessGoals: { hasSome: viewerFilter.fitnessGoals } });
  }

  // ---- Two-way: the target's filter must accept the viewer ----
  and.push({
    OR: [
      { filter: { is: null } },
      { filter: { is: { genders: { isEmpty: true }, womenOnly: false } } },
      // A viewer with no gender only passes targets with no gender preference.
      // A womenOnlyBlocked viewer never passes a women-only target, even
      // though their synced gender is female.
      ...(viewer.gender
        ? [{ filter: { is: { genders: { has: viewer.gender }, womenOnly: false } } }]
        : []),
      ...(viewer.gender === 'female' && !viewer.womenOnlyBlocked
        ? [{ filter: { is: { womenOnly: true } } }]
        : []),
    ],
  });
  and.push({
    OR: [
      { filter: { is: null } },
      { filter: { is: { minAge: { lte: viewerAge }, maxAge: { gte: viewerAge } } } },
    ],
  });

  // ---- womenOnlyBlocked, both ways ----
  if (viewer.womenOnlyBlocked) {
    // Kept out of every woman whose filter is women-only or [female].
    and.push({
      OR: [
        { gender: null },
        { gender: { not: 'female' } },
        { filter: { is: null } },
        { filter: { is: { womenOnly: false, NOT: { genders: { equals: ['female'] } } } } },
      ],
    });
  }
  if (viewer.gender === 'female' && isFemaleOnlyFilter(viewerFilter)) {
    and.push({ womenOnlyBlocked: false });
  }

  return { AND: and };
}

// Distance stays in JS (haversine), checked both ways: the target must be
// inside the viewer's radius AND the viewer inside the target's. The viewer
// always has a radius (default 25 km, needed for the bounding box); a target
// with no filter row accepts any distance.
function distanceAcceptsBothWays(viewer, target, distanceKm) {
  const viewerRadius = viewer.filter?.radiusKm ?? DEFAULT_FILTER.radiusKm;
  if (distanceKm > viewerRadius) return false;
  if (target.filter && distanceKm > target.filter.radiusKm) return false;
  return true;
}

// Ids hidden from a user in BOTH directions: blocks and reports either way.
// Unlike "already swiped" and "self", these apply to likes-by-id too.
async function safetyExcludedIds(userId) {
  const [blockedByMe, blockedMe, reportedByMe, reportedMe] = await Promise.all([
    prisma.blockedUser.findMany({ where: { blockerId: userId }, select: { blockedId: true } }),
    prisma.blockedUser.findMany({ where: { blockedId: userId }, select: { blockerId: true } }),
    prisma.report.findMany({ where: { reporterId: userId }, select: { reportedUserId: true } }),
    prisma.report.findMany({ where: { reportedUserId: userId }, select: { reporterId: true } }),
  ]);
  return [...new Set([
    ...blockedByMe.map((b) => b.blockedId),
    ...blockedMe.map((b) => b.blockerId),
    ...reportedByMe.map((r) => r.reportedUserId).filter((id) => id != null),
    ...reportedMe.map((r) => r.reporterId),
  ])];
}

// Gate for anyone browsing or swiping: active, not held, visible (no lurking),
// and with a DOB (the two-way age rule needs the viewer's age).
function assertCanBrowse(profile) {
  if (profile.isActive === false) throw buddyError('BUDDY_SUSPENDED');
  if (profile.moderationHoldAt != null) throw buddyError('BUDDY_UNDER_REVIEW');
  if (!profile.isDiscoverable) throw buddyError('NOT_DISCOVERABLE');
  if (!profile.dateOfBirth) throw buddyError('DOB_REQUIRED');
}

// Never includes lat/lng or an exact distance — only a bucketed range (see
// utils/geo.js#bucketDistanceKm). This is the single seam all discovery/
// match responses go through so that guarantee can't be bypassed by a
// call site forgetting to strip coordinates.
function toPublicCandidate(profile, display) {
  return {
    userId: profile.userId,
    publicCode: profile.publicCode,
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

// Returns { profile, code? }. `code` is 'PHOTOS_REQUIRED' when the save asked
// to become visible without enough photos: the save still succeeds (bio edits
// must never fail), the profile just stays hidden. The controller turns that
// into a 200 carrying the code.
//
// Only these fields are ever written from the client. isActive and
// moderationHoldAt are moderation state and are deliberately not accepted, so
// PUT /profile can't lift a suspension or a hold.
export async function createOrUpdateProfile(userId, { bio, lat, lng, isDiscoverable, socialMediaUrl }) {
  const existing = await prisma.buddyProfile.findUnique({ where: { userId }, include: { photos: true } });

  if (existing) {
    const data = {};
    let code;
    if (bio !== undefined) data.bio = bio;
    if (lat !== undefined) data.lat = lat;
    if (lng !== undefined) data.lng = lng;
    if (socialMediaUrl !== undefined) data.socialMediaUrl = socialMediaUrl || null;
    if (isDiscoverable === false) data.isDiscoverable = false;
    if (isDiscoverable === true && !existing.isDiscoverable) {
      // Hidden → visible needs 3 photos.
      if ((existing.photos?.length ?? 0) >= MIN_VISIBLE_PHOTOS) data.isDiscoverable = true;
      else code = 'PHOTOS_REQUIRED';
    }
    const profile = await prisma.buddyProfile.update({ where: { userId }, data });
    return { profile, code };
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

  // Gender-change history is copied at creation too, so a change made BEFORE
  // the buddy profile existed is caught exactly like one made after. Both
  // fields are optional on the auth side (missing = null).
  const genderChange = {
    genderChangedAt: authUser.genderChangedAt ? new Date(authUser.genderChangedAt) : null,
    genderChangedTo: authUser.genderChangedTo ?? null,
  };

  // A new profile always starts hidden, whatever the app sends: nobody is
  // visible until they have 3 photos and have turned on "Show my profile".
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
      isDiscoverable: false,
      ...genderChange,
      womenOnlyBlocked: computeWomenOnlyBlocked({ ...genderChange, genderChangeClearedAt: null }),
    },
  });
  track('buddy_profile_created', userId, {});
  return { profile: created, code: isDiscoverable === true ? 'PHOTOS_REQUIRED' : undefined };
}

// Re-pulls gender/dateOfBirth/fitnessGoals from auth-service. Called by
// POST /internal/profile-sync/:userId (fired by auth-service after a
// profile edit) and by the manual POST /api/buddy/profile/refresh fallback.
// No-ops (returns null) if the user has no buddy profile yet — there's
// nothing to sync.
//
// Also copies genderChangedAt/genderChangedTo (optional on the auth side —
// missing = null) and recomputes womenOnlyBlocked against the admin's
// genderChangeClearedAt, which sync never writes.
export async function syncProfileFromAuth(userId) {
  const existing = await prisma.buddyProfile.findUnique({ where: { userId }, include: { filter: true } });
  if (!existing) return null;

  const authUser = await getUserInternal(userId);
  const age = authUser.dateOfBirth ? ageFromDOB(authUser.dateOfBirth) : null;
  if (age != null && age < MIN_AGE) {
    // DOB was edited downward below 18 post-creation — pause discoverability
    // rather than deleting the profile outright.
    await prisma.buddyProfile.update({ where: { userId }, data: { isDiscoverable: false } });
    throw { status: 403, error: 'You must be 18 or older to use buddy matching' };
  }

  const gender = authUser.gender || null;
  const genderChange = {
    genderChangedAt: authUser.genderChangedAt ? new Date(authUser.genderChangedAt) : null,
    genderChangedTo: authUser.genderChangedTo ?? null,
  };
  const womenOnlyBlocked = computeWomenOnlyBlocked({
    ...genderChange,
    genderChangeClearedAt: existing.genderChangeClearedAt ?? null,
  });

  // Women-only mode is only for a profile whose synced gender is female; if
  // it changes away, the mode turns off. Existing matches are untouched.
  if (gender !== 'female' && existing.filter?.womenOnly) {
    await prisma.buddyFilter.update({ where: { userId }, data: { womenOnly: false } });
  }

  return prisma.buddyProfile.update({
    where: { userId },
    data: {
      gender,
      dateOfBirth: authUser.dateOfBirth ? new Date(authUser.dateOfBirth) : null,
      fitnessGoals: authUser.fitnessGoals || [],
      lastSyncedAt: new Date(),
      ...genderChange,
      womenOnlyBlocked,
    },
  });
}

export async function refreshProfileFromAuth(userId) {
  const result = await syncProfileFromAuth(userId);
  if (!result) throw { status: 404, error: 'Buddy profile not found' };
  return result;
}

// ---- Photos -------------------------------------------------------------

// Adding photos never makes a profile visible on its own — that takes the
// user's own "Show my profile" (see createOrUpdateProfile).
export async function addPhotos(userId, files) {
  // Advisory-lock + in-transaction re-check: the count and order must be
  // read after the lock, not before it. The old code read the profile
  // outside any transaction, so two concurrent uploads racing at 5/6
  // photos both passed the cap check and stored 7-8 rows with duplicate
  // `order` values. 913_001 is this table's lock namespace (buddy-service
  // has no other advisory locks; wallet-service's namespaces live in a
  // different database).
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(913001::int, ${userId}::int)`;

    const profile = await tx.buddyProfile.findUnique({ where: { userId }, include: { photos: true } });
    if (!profile) throw { status: 400, error: 'Create your buddy profile first' };
    if (profile.photos.length + files.length > MAX_BUDDY_PHOTOS) {
      throw { status: 409, error: `A buddy profile can have at most ${MAX_BUDDY_PHOTOS} photos` };
    }

    let nextOrder = Math.max(-1, ...profile.photos.map((photo) => photo.order ?? -1)) + 1;
    const created = [];
    for (const f of files) {
      created.push(
        await tx.buddyPhoto.create({
          data: { buddyProfileId: profile.id, url: f.path, publicId: f.filename, order: nextOrder++ },
        })
      );
    }
    return created;
  });
}

// One-way "use my main profile photo" shortcut — buddy and account photos
// stay on independent pipelines/models by design, this just clones the
// current account avatar in as one more buddy photo via Cloudinary's
// fetch-by-URL upload rather than requiring the client to download+re-upload
// the bytes itself.
export async function addPhotoFromUrl(userId, sourceUrl) {
  // Upload outside the transaction (a network call must not hold a DB
  // connection / the interactive-tx timeout), then the same advisory-locked
  // count check as addPhotos. If the check rejects — or the insert fails —
  // the just-uploaded Cloudinary asset is destroyed rather than orphaned.
  const uploaded = await cloudinary.uploader.upload(sourceUrl, {
    folder: 'phool-gobhi/buddy-profiles',
    transformation: [{ width: 1080, height: 1350, crop: 'limit', quality: 'auto' }],
  });
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(913_001, ${userId})`;

      const profile = await tx.buddyProfile.findUnique({ where: { userId }, include: { photos: true } });
      if (!profile) throw { status: 400, error: 'Create your buddy profile first' };
      if (profile.photos.length + 1 > MAX_BUDDY_PHOTOS) {
        throw { status: 409, error: `A buddy profile can have at most ${MAX_BUDDY_PHOTOS} photos` };
      }
      return tx.buddyPhoto.create({
        data: {
          buddyProfileId: profile.id,
          url: uploaded.secure_url,
          publicId: uploaded.public_id,
          order: profile.photos.length,
        },
      });
    });
  } catch (err) {
    await cloudinary.uploader.destroy(uploaded.public_id).catch(() => {});
    throw err;
  }
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

  // Dropping below 3 photos hides the profile again; the client shows the
  // same "Add 3 photos to be visible" notice it shows on save.
  const profile = await prisma.buddyProfile.findUnique({ where: { userId }, include: { photos: true } });
  if (profile && profile.photos.length < MIN_VISIBLE_PHOTOS && profile.isDiscoverable) {
    await prisma.buddyProfile.update({ where: { userId }, data: { isDiscoverable: false } });
    return {
      message: 'Photo deleted',
      isDiscoverable: false,
      code: 'PHOTOS_REQUIRED',
      notice: BUDDY_ERRORS.PHOTOS_REQUIRED.error,
    };
  }

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

  const { radiusKm, minAge, maxAge, genders, fitnessGoals, womenOnly } = data;

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
  if (womenOnly !== undefined && typeof womenOnly !== 'boolean') {
    throw { status: 400, error: 'womenOnly must be true or false' };
  }
  // Women-only is a safety mode, not a premium filter, so it is not
  // tier-gated. Only a profile whose synced gender is female can turn it on.
  const isFemale = profile.gender === 'female';
  if (womenOnly === true && !isFemale) throw buddyError('WOMEN_ONLY_NOT_ALLOWED');

  const existing = await prisma.buddyFilter.findUnique({ where: { userId } });
  // A stale womenOnly=true on a profile that is no longer female is dropped
  // here too, not only by sync.
  const nextWomenOnly = isFemale ? (womenOnly ?? existing?.womenOnly ?? DEFAULT_FILTER.womenOnly) : false;
  const payload = {
    radiusKm: radiusKm ?? existing?.radiusKm ?? DEFAULT_FILTER.radiusKm,
    minAge: minAge ?? existing?.minAge ?? DEFAULT_FILTER.minAge,
    maxAge: maxAge ?? existing?.maxAge ?? DEFAULT_FILTER.maxAge,
    // While women-only is on, an explicitly-passed genders is forced to
    // [female] (and shown as such). With no explicit genders the stored
    // preference is left untouched — effectiveGenders() forces [female]
    // at query time anyway, so the deck behaves identically while the
    // user's real preference survives for when they turn the mode off.
    // (Previously the forced value was also written to the DB, so turning
    // womenOnly off resurrected ['female'] and permanently destroyed the
    // original preference.)
    genders: nextWomenOnly
      ? (genders !== undefined ? ['female'] : (existing?.genders ?? DEFAULT_FILTER.genders))
      : (genders ?? existing?.genders ?? DEFAULT_FILTER.genders),
    fitnessGoals: fitnessGoals ?? existing?.fitnessGoals ?? DEFAULT_FILTER.fitnessGoals,
    womenOnly: nextWomenOnly,
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

  const me = await prisma.buddyProfile.findUnique({ where: { userId }, include: { filter: true } });
  if (!me) throw { status: 400, error: 'Create your buddy profile first' };
  assertCanBrowse(me);

  const radiusKm = me.filter?.radiusKm ?? DEFAULT_FILTER.radiusKm;

  // "Self" and "already swiped" are feed-only exclusions; blocks and reports
  // (either way) apply to likes-by-id as well, via safetyExcludedIds.
  const [swiped, safetyIds] = await Promise.all([
    prisma.swipe.findMany({ where: { swiperId: userId }, select: { swipeeId: true } }),
    safetyExcludedIds(userId),
  ]);
  const excludeIds = [...new Set([userId, ...swiped.map((s) => s.swipeeId), ...safetyIds])];

  const box = boundingBox(me.lat, me.lng, radiusKm);

  // Hard cap per query as a worst-case bound — see prisma/schema.prisma's
  // note on the bounding-box+haversine strategy vs. real geo indexing. Every
  // gender/age rule (both ways) is in the WHERE, so it runs before the cap.
  const candidates = await prisma.buddyProfile.findMany({
    where: {
      AND: [
        targetEligibility(me, excludeIds),
        { lat: { gte: box.minLat, lte: box.maxLat } },
        { lng: { gte: box.minLng, lte: box.maxLng } },
      ],
    },
    include: { photos: { orderBy: { order: 'asc' }, take: MAX_BUDDY_PHOTOS }, filter: true },
    take: 300,
  });

  const withDistance = candidates
    .map((c) => ({ ...c, distanceKm: haversineKm(me.lat, me.lng, c.lat, c.lng) }))
    // The bounding box over-includes near its corners — this trims to the
    // exact circle, and applies the candidate's own radius the other way.
    .filter((c) => distanceAcceptsBothWays(me, c, c.distanceKm))
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const pageSlice = withDistance.slice((page - 1) * limit, page * limit);
  const displayInfo = await getUsersBatchInternal(pageSlice.map((c) => c.userId)).catch(() => []);
  const displayMap = new Map(displayInfo.map((u) => [u.id, u]));

  const data = pageSlice.map((c) => toPublicCandidate(c, displayMap.get(c.userId)));
  return { data, page, hasMore: page * limit < withDistance.length };
}

// ---- Swipes & matches ----------------------------------------------------

// Order matters (W7): load the swiper, require them to be able to browse, run
// the shared target rule, check distance, and only then write. A like by id
// must be held to exactly the deck's rules, or anyone can bypass the deck by
// posting ids.
export async function recordSwipe(swiperId, swipeeId, action) {
  if (!Number.isInteger(swipeeId)) throw { status: 400, error: 'targetUserId must be a number' };
  if (swiperId === swipeeId) throw { status: 400, error: 'Cannot swipe on yourself' };
  if (!['like', 'pass'].includes(action)) throw { status: 400, error: 'action must be "like" or "pass"' };

  // 1. The swiper's profile and filter.
  const swiper = await prisma.buddyProfile.findUnique({ where: { userId: swiperId }, include: { filter: true } });
  if (!swiper) throw { status: 400, error: 'Create your buddy profile first' };

  // 2. Active, not held, visible.
  assertCanBrowse(swiper);

  // 3. The target check. AND, never spread: the eligibility rules carry their
  // own `userId: { notIn }`, which would overwrite a spread-in target id and
  // let findFirst return some OTHER eligible user.
  const excluded = await safetyExcludedIds(swiperId);
  const target = await prisma.buddyProfile.findFirst({
    where: { AND: [{ userId: swipeeId }, targetEligibility(swiper, excluded)] },
    include: { filter: true },
  });
  if (!target || target.userId !== swipeeId) throw buddyError('TARGET_NOT_AVAILABLE');

  // 4. Distance, both ways.
  const distanceKm = haversineKm(swiper.lat, swiper.lng, target.lat, target.lng);
  if (!distanceAcceptsBothWays(swiper, target, distanceKm)) throw buddyError('TARGET_NOT_AVAILABLE');

  // 5. Only then write. Idempotent: upsert instead of insert-and-catch, so a
  // double-tap of the same action is a no-op and changing your mind
  // (pass -> like) just overwrites the row rather than erroring.
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
  await assertNotSuspended(userId);
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
  // Hide matches whose other side is suspended. Suspension already ends their
  // matches; this keeps any straggler out of the list. A hold does NOT hide a
  // match: a hold isn't a verdict, and open chats keep working.
  const suspendedIds = new Set(buddyProfiles.filter((p) => p.isActive === false).map((p) => p.userId));

  return matches.filter((m) => !suspendedIds.has(m.userLowId === userId ? m.userHighId : m.userLowId)).map((m) => {
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

  await prisma.buddyFollow.deleteMany({ where: { OR: [
    { followerId: userId, targetId: targetUserId }, { followerId: targetUserId, targetId: userId }
  ] } });
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

// Suspension ends everything for the suspended user. A missing profile is not
// a suspension (it is checked where a profile is actually required).
async function assertNotSuspended(userId) {
  const me = await prisma.buddyProfile.findUnique({ where: { userId }, select: { isActive: true } });
  if (me && me.isActive === false) throw buddyError('BUDDY_SUSPENDED');
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
  // Chat, the match list and profile view need BOTH sides active. A hold is
  // not checked here on purpose: held users keep their open chats.
  const otherUserId = match.userLowId === userId ? match.userHighId : match.userLowId;
  const profiles = await prisma.buddyProfile.findMany({
    where: { userId: { in: [userId, otherUserId] } },
    select: { userId: true, isActive: true },
  });
  const inactive = new Set(profiles.filter((p) => p.isActive === false).map((p) => p.userId));
  if (inactive.has(userId)) throw buddyError('BUDDY_SUSPENDED');
  if (inactive.has(otherUserId)) {
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
// explicit choice. Discovery between the two is cut both ways, though: a
// report in either direction is an exclusion in targetEligibility.
//
// Only a suspended reporter is refused. A held reporter can still report, but
// that report never counts toward a hold (see evaluateAutoHold).
export async function reportUser(userId, reportedUserId, reason, details) {
  if (userId === reportedUserId) throw { status: 400, error: 'Cannot report yourself' };

  const reporter = await prisma.buddyProfile.findUnique({ where: { userId }, select: { isActive: true } });
  if (reporter && reporter.isActive === false) throw buddyError('BUDDY_SUSPENDED');

  const severity = severityForReason(reason);
  const report = await prisma.report.create({
    data: { reporterId: userId, reportedUserId, reason, details: details?.slice(0, 1000) ?? null, severity },
  });
  track('buddy_reported', userId, { reportedUserId, reason, severity });

  await evaluateAutoHold(reportedUserId, reason);

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

  return { reportId: report.id, status: report.status, severity: report.severity, severedMatchId };
}

// Auto-hold: 2+ distinct QUALIFYING reporters within 30 days. A reporter
// qualifies only if, at the time they reported:
//   - they had a Match row (any status) with the reported user, or were
//     liked BY the reported user — a man she rejected doesn't qualify just
//     because he liked her;
//   - their buddy profile was more than 7 days old;
//   - they weren't held or suspended. Suspended users can't report at all, so
//     every stored report was filed while active; "held at the time" is a
//     moderationHoldAt at or before the report.
// A single report never holds anyone, whatever its severity: threats go to the
// top of the admin queue instead.
async function evaluateAutoHold(reportedUserId, reason) {
  const since = new Date(Date.now() - HOLD_WINDOW_DAYS * DAY_MS);
  const recent = await prisma.report.findMany({
    where: { reportedUserId, createdAt: { gte: since } },
    select: { reporterId: true, createdAt: true },
  });
  // Earliest report per reporter in the window (the unique constraint makes
  // this one row per reporter today; the Map keeps it correct regardless).
  const firstReportAt = new Map();
  for (const r of recent) {
    const prev = firstReportAt.get(r.reporterId);
    if (!prev || new Date(r.createdAt) < prev) firstReportAt.set(r.reporterId, new Date(r.createdAt));
  }
  if (firstReportAt.size < HOLD_REPORTER_THRESHOLD) return false;

  const reporterIds = [...firstReportAt.keys()];
  const [reporterProfiles, pairMatches, likesFromReported] = await Promise.all([
    prisma.buddyProfile.findMany({
      where: { userId: { in: reporterIds } },
      select: { userId: true, createdAt: true, moderationHoldAt: true },
    }),
    prisma.match.findMany({
      where: {
        OR: reporterIds.map((id) => ({
          userLowId: Math.min(id, reportedUserId),
          userHighId: Math.max(id, reportedUserId),
        })),
      },
      select: { userLowId: true, userHighId: true },
    }),
    prisma.swipe.findMany({
      where: { swiperId: reportedUserId, swipeeId: { in: reporterIds }, action: 'like' },
      select: { swipeeId: true },
    }),
  ]);
  const profileById = new Map(reporterProfiles.map((p) => [p.userId, p]));
  const matchedIds = new Set(pairMatches.map((m) => (m.userLowId === reportedUserId ? m.userHighId : m.userLowId)));
  const likedByReported = new Set(likesFromReported.map((s) => s.swipeeId));

  let qualifying = 0;
  for (const [reporterId, reportedAt] of firstReportAt) {
    const p = profileById.get(reporterId);
    if (!p) continue;
    if (reportedAt.getTime() - new Date(p.createdAt).getTime() <= QUALIFYING_PROFILE_AGE_DAYS * DAY_MS) continue;
    if (p.moderationHoldAt && new Date(p.moderationHoldAt) <= reportedAt) continue;
    if (!matchedIds.has(reporterId) && !likedByReported.has(reporterId)) continue;
    qualifying++;
  }
  if (qualifying < HOLD_REPORTER_THRESHOLD) return false;

  // Conditional on not already held, so the event fires once per hold.
  const { count } = await prisma.buddyProfile.updateMany({
    where: { userId: reportedUserId, moderationHoldAt: null },
    data: { moderationHoldAt: new Date() },
  });
  if (count > 0) {
    track('buddy_auto_held', reportedUserId, { reporter_count: qualifying, reason });
    return true;
  }
  return false;
}

// Triage queue. Gobhi-only at the route layer; this function does no auth of
// its own, matching how listBlocked/getMatches are shaped.
export async function listReports({ status = 'open', limit = 50 } = {}) {
  const rows = await prisma.report.findMany({
    where: status === 'all' ? {} : { status },
    // Severity first, in SQL: Postgres orders an enum by declaration order
    // (normal < high), so desc puts high on top. Then newest. id as a final
    // key, not cosmetics: createdAt has millisecond resolution, so two reports
    // can share a timestamp, and without a tie-break a report at a page
    // boundary can be shown twice or skipped.
    orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(Math.max(1, parseInt(limit) || 50), 200),
  });
  // Resolve display names best-effort: a report must still be triageable when
  // auth-service is unreachable, so a failed lookup degrades to the raw id
  // rather than throwing and losing the queue.
  const ids = [...new Set(rows.flatMap((r) => [r.reporterId, r.reportedUserId]).filter(Boolean))];
  const infos = await getUsersBatchInternal(ids).catch(() => []);
  const nameMap = new Map(infos.map((u) => [u.id, u.name]));

  // "How many reports has this person ever had?" in ONE query, not one per row.
  // It is the number a triager weighs against the report in front of them.
  // Null reportedUserId (an erased subject) is excluded from the lookup.
  const reportedIds = [...new Set(rows.map((r) => r.reportedUserId).filter((v) => v !== null && v !== undefined))];
  const priorCounts = new Map();
  const profileMap = new Map();
  if (reportedIds.length) {
    const [priorRows, profiles] = await Promise.all([
      prisma.report.findMany({ where: { reportedUserId: { in: reportedIds } }, select: { reportedUserId: true } }),
      prisma.buddyProfile.findMany({
        where: { userId: { in: reportedIds } },
        include: { photos: { orderBy: { order: 'asc' } } },
      }),
    ]);
    for (const r of priorRows) {
      priorCounts.set(r.reportedUserId, (priorCounts.get(r.reportedUserId) ?? 0) + 1);
    }
    for (const p of profiles) profileMap.set(p.userId, p);
  }

  return rows.map((r) => {
    const erased = r.reportedUserId === null || r.reportedUserId === undefined;
    // minus one: the row itself is in priorRows, and "3 prior reports" must not
    // include the report being triaged.
    const prior = erased ? 0 : Math.max(0, (priorCounts.get(r.reportedUserId) ?? 0) - 1);
    const profile = erased ? null : profileMap.get(r.reportedUserId);
    return {
      id: r.id,
      reason: r.reason,
      details: r.details,
      status: r.status,
      severity: r.severity,
      createdAt: r.createdAt,
      reviewedAt: r.reviewedAt,
      resolutionNote: r.resolutionNote,
      reporter: { userId: r.reporterId, name: nameMap.get(r.reporterId) ?? null },
      // reportedUserId is nullable by design — it is null once the reported user
      // has erased their account. The report survives; the pointer does not.
      reportedUser: erased
        ? { userId: null, name: null, erased: true, bio: null, photos: [] }
        : {
          userId: r.reportedUserId,
          name: nameMap.get(r.reportedUserId) ?? null,
          erased: false,
          bio: profile?.bio ?? null,
          photos: (profile?.photos ?? []).map((ph) => ({ id: ph.id, url: ph.url, order: ph.order })),
          isActive: profile ? profile.isActive !== false : null,
          moderationHoldAt: profile?.moderationHoldAt ?? null,
        },
      priorReportCount: prior,
      // Any real gender change ever recorded for the reported user.
      genderChanged: Boolean(profile?.genderChangedAt),
    };
  });
}

// PATCH /reports/:id. `suspend: true` (only with `actioned`) suspends the
// reported user: isActive=false and every active match on either side ends in
// ONE updateMany. Suspending on a report whose subject erased → 409.
export async function reviewReport(reportId, { status, resolutionNote, suspend }, reviewedBy) {
  if (!['dismissed', 'actioned'].includes(status)) {
    throw { status: 400, error: 'status must be dismissed or actioned' };
  }
  if (suspend !== undefined && typeof suspend !== 'boolean') {
    throw { status: 400, error: 'suspend must be true or false' };
  }
  if (suspend && status !== 'actioned') {
    throw { status: 400, error: 'Suspending a user needs status actioned' };
  }
  const existing = await prisma.report.findUnique({ where: { id: Number(reportId) } });
  if (!existing) throw { status: 404, error: 'Report not found' };
  if (suspend && existing.reportedUserId == null) throw buddyError('REPORTED_USER_ERASED');

  const updated = await prisma.report.update({
    where: { id: Number(reportId) },
    data: { status, resolutionNote: resolutionNote?.slice(0, 500) ?? null, reviewedBy, reviewedAt: new Date() },
  });
  if (suspend) {
    const ended = await suspendUser(existing.reportedUserId);
    return { ...updated, suspended: true, endedMatches: ended };
  }
  return updated;
}

async function suspendUser(userId) {
  const now = new Date();
  const [, ended] = await prisma.$transaction([
    prisma.buddyProfile.updateMany({ where: { userId }, data: { isActive: false } }),
    prisma.match.updateMany({
      where: { status: 'active', OR: [{ userLowId: userId }, { userHighId: userId }] },
      data: { status: 'unmatched', unmatchedBy: userId, unmatchedAt: now },
    }),
  ]);
  return ended.count;
}

// GET /reports/:id/context: the last 20 messages of the match between the two
// users, found by user pair (any status — a report usually severs the match).
// Empty for a report filed from the deck (no match) or about an erased user.
export async function getReportContext(reportId) {
  const report = await prisma.report.findUnique({ where: { id: Number(reportId) } });
  if (!report) throw { status: 404, error: 'Report not found' };
  if (report.reportedUserId == null) return { messages: [] };
  const userLowId = Math.min(report.reporterId, report.reportedUserId);
  const userHighId = Math.max(report.reporterId, report.reportedUserId);
  const match = await prisma.match.findUnique({ where: { userLowId_userHighId: { userLowId, userHighId } } });
  if (!match) return { messages: [] };
  const rows = await prisma.chatMessage.findMany({
    where: { matchId: match.id },
    orderBy: { id: 'desc' },
    take: 20,
  });
  return {
    messages: rows.reverse().map((m) => ({ fromUserId: m.senderId, body: m.body, createdAt: m.createdAt })),
  };
}

async function requireProfileForModeration(userId) {
  if (!Number.isInteger(userId)) throw { status: 400, error: 'A numeric userId is required' };
  const profile = await prisma.buddyProfile.findUnique({ where: { userId } });
  if (!profile) throw { status: 404, error: 'Buddy profile not found' };
  return profile;
}

// Clears moderationHoldAt only.
export async function releaseHold(userId) {
  await requireProfileForModeration(userId);
  return prisma.buddyProfile.update({ where: { userId }, data: { moderationHoldAt: null } });
}

// isActive=true and the hold cleared. Brings back the deck only: matches the
// suspension ended stay ended.
export async function reinstateUser(userId) {
  await requireProfileForModeration(userId);
  return prisma.buddyProfile.update({ where: { userId }, data: { isActive: true, moderationHoldAt: null } });
}

// ---- Gender-change moderation (women-only guard) ---------------------------

export async function listGenderChanges() {
  const rows = await prisma.buddyProfile.findMany({
    where: { womenOnlyBlocked: true },
    select: { userId: true, genderChangedAt: true, genderChangedTo: true, genderChangeClearedAt: true },
    orderBy: { genderChangedAt: 'desc' },
  });
  const infos = await getUsersBatchInternal(rows.map((r) => r.userId)).catch(() => []);
  const nameMap = new Map(infos.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    userId: r.userId,
    firstName: nameMap.get(r.userId)?.trim().split(/\s+/)[0] || null,
    genderChangedAt: r.genderChangedAt,
    genderChangedTo: r.genderChangedTo,
    genderChangeClearedAt: r.genderChangeClearedAt,
  }));
}

// Admin "Clear": sets genderChangeClearedAt=now and recomputes
// womenOnlyBlocked in the same update. A later real change (genderChangedAt
// after this) blocks again at the next sync.
export async function clearGenderChange(userId) {
  const profile = await requireProfileForModeration(userId);
  const genderChangeClearedAt = new Date();
  return prisma.buddyProfile.update({
    where: { userId },
    data: {
      genderChangeClearedAt,
      womenOnlyBlocked: computeWomenOnlyBlocked({ ...profile, genderChangeClearedAt }),
    },
  });
}
