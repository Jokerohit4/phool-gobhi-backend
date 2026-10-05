// Photo food logging: propose, then let the user confirm.
//
// The flow is deliberately two calls, not one. A single "photograph your meal
// and it is logged" would put a model's guess into somebody's health record with
// no way for them to see it first - and the enum this feature was designed
// around is called `photo_confirmed`, not `photo`, which is the schema author
// already having made that decision. So:
//
//   recognize  upload the image, ask the model what it sees, MATCH every answer
//              to the real food catalogue, and hand back candidates. Nothing is
//              written to the food log.
//   confirm    the user accepts, corrects or drops each candidate, and only then
//              are FoodLog rows written, carrying what the model proposed.
//
// Two rules run through the whole file:
//
//  1. THE MODEL NEVER SUPPLIES A NUMBER. It proposes NAMES, and every gram of
//     nutrition comes from the FoodItem the name matched. If the model said
//     "dal" and we have Dal Tadka, the log says Dal Tadka and the nutrients are
//     ours. A vision model is good at naming a plate and has no idea what any
//     of it weighs in iron, and a feature that let it answer would be inventing
//     micronutrients - the exact numbers this ledger is built to be honest
//     about.
//
//  2. UNMATCHED NAMES ARE REPORTED, NOT DROPPED. "We think this is a plate of
//     upma, which is not in your catalogue" is information: it tells the user
//     what the model saw, and a high unmatched rate is the signal that our
//     catalogue is the bottleneck rather than the model. Silently discarding
//     them would make the feature look like it under-performs for no reason.
import * as nutritionService from './nutritionService.js';
import * as foodPhotoStorage from './foodPhotoStorage.js';
import { matchToCatalogue } from './foodMatch.js';
import { getRecognizer, isRecognizerConfigured } from './providers/index.js';
import { isProviderError } from '../../utils/providerError.js';

// Per user, per hour. This is a paid API call made from a phone, so the limit
// exists to bound spend rather than to stop abuse - 20 photos an hour is far
// beyond honest use, and low enough that a loop cannot run up a bill.
const REQUESTS_PER_HOUR = 20;

// How long a stored-but-unconfirmed photo survives before the sweeper reclaims
// it. Long enough that a user can photograph a meal, get distracted, and come
// back to it; short enough that a photo nobody wanted does not sit in a bucket
// indefinitely.
export const UNCONFIRMED_TTL_HOURS = 24;

// A model asked about one plate will occasionally return a very long list. Left
// uncapped it becomes an unbounded catalogue search and an unbounded insert on
// confirm.
const MAX_ITEMS = 12;

function badRequest(message, code) {
  return Object.assign(new Error(message), { status: 400, code });
}

function forbidden(message, code) {
  return Object.assign(new Error(message), { status: 403, code });
}

function notFound(message, code) {
  return Object.assign(new Error(message), { status: 404, code });
}

// matchToCatalogue, and the ranking behind it, live in foodMatch.js - shared
// with the food picker so a name typed by hand and a name proposed by the
// vision model resolve to the same row.

async function assertWithinRateLimit(prisma, userId, now) {
  const since = new Date(now.getTime() - 60 * 60 * 1000);
  const used = await prisma.foodPhotoRequestLog.count({
    where: { userId, requestedAt: { gte: since } },
  });
  if (used >= REQUESTS_PER_HOUR) {
    throw Object.assign(new Error('Too many photos in the last hour. Try again shortly.'), {
      status: 429,
      code: 'RATE_LIMITED',
    });
  }
}

/**
 * Upload, recognise, match. Writes no FoodLog.
 *
 * The photo is stored before the model is called, and that ordering is not
 * incidental: the model needs bytes, the bytes have to exist somewhere durable
 * for the confirm step to attach, and storing them first means a provider
 * failure still leaves a sweepable object rather than a photo that was paid for
 * and thrown away. sweepUnconfirmedPhotos reclaims it if the user walks away.
 */
export async function recognizePhoto(
  prisma,
  { userId, buffer, mimeType, now = new Date(), deps = {} },
) {
  const { storage, getRecognizer: recognizerFor, isRecognizerConfigured: configured } = resolve(deps);

  if (!configured()) {
    // 503, not 400 or 500: the feature flag can be on while no provider key is
    // deployed, and that is a configuration state the app should be able to
    // distinguish from "your photo was too big".
    throw Object.assign(new Error('Photo logging is not available right now'), {
      status: 503,
      code: 'PROVIDER_NOT_CONFIGURED',
    });
  }
  if (!buffer || !buffer.length) throw badRequest('No photo received', 'NO_PHOTO');
  if (!storage.isAllowedMimeType(mimeType)) {
    throw badRequest('That image type is not accepted', 'UNSUPPORTED_IMAGE');
  }

  await assertWithinRateLimit(prisma, userId, now);

  const photoPath = await storage.savePhoto({ buffer, mimeType, userId });
  const startedAt = Date.now();

  let proposal;
  try {
    proposal = await recognizerFor().recognizeFood({
      imageBase64: buffer.toString('base64'),
      mimeType,
    });
  } catch (err) {
    await recordRequest(prisma, {
      userId,
      requestedAt: now,
      outcome: 'provider_error',
      latencyMs: Date.now() - startedAt,
      photoPath,
    });
    // A provider failure is re-thrown as a 502 rather than passed through raw:
    // the caller must not learn, or be able to log, a provider's error text.
    if (isProviderError(err)) {
      console.error('[foodPhoto] provider failed', err.code, err.message);
      throw Object.assign(new Error('Could not read that photo. Try again.'), {
        status: 502,
        code: 'PROVIDER_FAILED',
      });
    }
    throw err;
  }

  const latencyMs = Date.now() - startedAt;

  if (!proposal.isFood || !proposal.items.length) {
    await recordRequest(prisma, {
      userId,
      requestedAt: now,
      outcome: 'no_food',
      latencyMs,
      photoPath,
      model: proposal.model,
      tokensIn: proposal.tokensIn,
      tokensOut: proposal.tokensOut,
    });
    // Still a 200. "There is no food in this photo" is a successful answer to
    // what the user asked, and a non-2xx would make the app show an error toast
    // over a photo of what is, say, a desk.
    return {
      photoPath,
      photoUrl: await storage.signedPhotoUrl(photoPath),
      isFood: false,
      items: [],
      unmatched: [],
      note: proposal.note,
      model: proposal.model,
    };
  }

  // Dedupe by matched row before searching per name, so a plate of three
  // identical rotis costs one catalogue query rather than three.
  const names = [];
  const seenName = new Set();
  for (const item of proposal.items.slice(0, MAX_ITEMS)) {
    const key = item.name.trim().toLowerCase();
    if (!key || seenName.has(key)) continue;
    seenName.add(key);
    names.push(item);
  }

  const candidates = [];
  const unmatched = [];
  for (const item of names) {
    const rows = await nutritionService.searchFoods(prisma, userId, {
      query: item.name,
      // The seeded catalogue is all `verified: false` (prisma/seed/foods.seed.js),
      // and the Flutter food picker already passes includeUnverified so logging
      // works at all. Refusing to match unverified rows here would mean the
      // photo feature silently recognises nothing on a fresh database.
      includeUnverified: true,
    });
    // The ranking is now the service's job, not this file's, so the whole
    // matching candidate set comes back and the best one is chosen from it. The
    // previous `limit: 8` was a workaround for the unordered `take`, and it
    // actively lost matches: eight rows in arbitrary order, of which the right
    // one might not be among them.
    const food = matchToCatalogue(rows, item.name);
    if (!food) {
      unmatched.push({ name: item.name, confidence: item.confidence });
      continue;
    }
    candidates.push({
      foodItemId: food.id,
      name: food.name,
      proposedName: item.name,
      grams: item.grams,
      confidence: item.confidence,
      nonVeg: item.nonVeg,
      servings: food.servings ?? null,
    });
  }

  await recordRequest(prisma, {
    userId,
    requestedAt: now,
    outcome: 'ok',
    latencyMs,
    photoPath,
    model: proposal.model,
    tokensIn: proposal.tokensIn,
    tokensOut: proposal.tokensOut,
    unmatchedCount: unmatched.length,
  });

  return {
    photoPath,
    photoUrl: await storage.signedPhotoUrl(photoPath),
    isFood: true,
    items: candidates,
    unmatched,
    note: proposal.note,
    model: proposal.model,
  };
}

async function recordRequest(prisma, row) {
  return prisma.foodPhotoRequestLog.create({
    data: {
      userId: row.userId,
      requestedAt: row.requestedAt,
      outcome: row.outcome ?? null,
      latencyMs: row.latencyMs ?? null,
      photoPath: row.photoPath ?? null,
      model: row.model ?? null,
      tokensIn: row.tokensIn ?? null,
      tokensOut: row.tokensOut ?? null,
      unmatchedCount: row.unmatchedCount ?? 0,
    },
  });
}

/**
 * Writes the FoodLog rows the user confirmed.
 *
 * The photo is only accepted if this user's own request log claims it. Prefix
 * matching alone would not be enough: the path shape `food/{userId}/{uuid}.jpg`
 * is guessable in structure but a user who could name any uuid could otherwise
 * attach someone else's meal to their own diary, and a photo in a health ledger
 * is not something to hand over on a hunch.
 */
export async function confirmPhotoLog(prisma, { userId, photoPath, localDate, slot, lines }) {
  if (!photoPath) throw badRequest('No photo to attach', 'NO_PHOTO_PATH');
  if (!Array.isArray(lines) || !lines.length) {
    throw badRequest('Nothing was selected to log', 'NO_LINES');
  }

  const claim = await prisma.foodPhotoRequestLog.findFirst({
    where: { userId, photoPath, abandonedAt: null },
    // `model` is read off the claim rather than trusted from the request body:
    // it is the model this service actually called, and a client echoing a
    // different value would let the per-model accuracy numbers be written by
    // whoever asks. The client never has to send it, and cannot influence it.
    select: { id: true, model: true },
  });
  if (!claim) throw forbidden('That photo is not yours to log', 'PHOTO_NOT_CLAIMED');

  const created = [];
  const rejected = [];
  let corrections = 0;

  for (const line of lines.slice(0, MAX_ITEMS)) {
    // One line failing must not lose the rest: the user corrected a plate, and
    // silently dropping the line they did not touch would be worse than telling
    // them which one went wrong.
    try {
      const log = await nutritionService.logFood(prisma, {
        userId,
        localDate,
        slot,
        foodItemId: line.foodItemId,
        grams: line.grams,
        servingLabel: line.servingLabel,
        source: 'photo_confirmed',
        photoCorrections: line.corrected ? 1 : 0,
        photo: {
          path: photoPath,
          proposedName: line.proposedName,
          confidence: line.confidence,
          model: claim.model,
        },
      });
      if (line.corrected) corrections += 1;
      created.push(log);
    } catch (err) {
      rejected.push({ name: line.proposedName || null, reason: err.message });
    }
  }

  if (!created.length) {
    throw Object.assign(new Error('None of those foods could be logged'), {
      status: 422,
      code: 'NOTHING_LOGGED',
      rejected,
    });
  }

  return {
    logged: created.length,
    corrections,
    // The launch metric, computed where it is actually knowable. More than half
    // the lines corrected means the model is not earning its per-photo cost, and
    // this is the number that says so.
    correctionRate: created.length ? round4(corrections / created.length) : 0,
    rejected,
    slot,
    localDate,
  };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * Resolves the two collaborators, allowing both to be replaced.
 *
 * Same reasoning as the `prisma` parameter every function here already takes:
 * the caller supplies the database, so the caller can also supply a storage
 * client and a recogniser. That is what makes the matching, the ordering and the
 * ownership rule testable without a GCS bucket or an API key, and it is
 * available for the same reason it is not a module-level setter - ESM namespaces
 * are frozen, so the alternative would have been an untestable module.
 */
function resolve(deps = {}) {
  return {
    storage: deps.storage ?? foodPhotoStorage,
    getRecognizer: deps.getRecognizer ?? getRecognizer,
    isRecognizerConfigured: deps.isRecognizerConfigured ?? isRecognizerConfigured,
  };
}

/**
 * A signed link to the photo behind one of the user's own food logs.
 *
 * Scoped to the caller like every read in this file, and the storage path is
 * never returned - a path is a capability, and the whole point of minting per
 * read is that there is nothing durable to leak.
 */
export async function getPhotoLink(prisma, { userId, logId, deps = {} }) {
  const { storage } = resolve(deps);
  const log = await prisma.foodLog.findFirst({
    where: { id: Number(logId), userId },
    select: { photoPath: true },
  });
  if (!log) throw notFound('No such food log', 'NO_SUCH_LOG');
  if (!log.photoPath) throw notFound('That food log has no photo', 'NO_PHOTO');
  return { url: await storage.signedPhotoUrl(log.photoPath) };
}

/**
 * Best-effort cleanup when a log is deleted.
 *
 * Called by the controller after a FoodLog is removed. Deletes the object ONLY
 * when no other log still points at it - one photo produces several logs, so
 * removing the last line is what makes the object unreachable, and deleting on
 * the first line would break the photo on the others.
 */
export async function releasePhotoIfUnreferenced(prisma, { photoPath, deps = {} }) {
  if (!photoPath) return { deleted: 0, failed: [] };
  const { storage } = resolve(deps);
  const stillUsed = await prisma.foodLog.count({ where: { photoPath } });
  if (stillUsed > 0) return { deleted: 0, failed: [] };
  return storage.deletePhotos([photoPath]);
}

export { sweepUnconfirmedPhotos } from './foodPhotoStorage.js';
