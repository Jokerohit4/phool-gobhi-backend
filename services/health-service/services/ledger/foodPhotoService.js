import { cachedRecognition, experimentConfig } from './photoExperiments.js';
import { candidates as providerCandidates } from './providers/index.js';
import { normaliseFoodEstimate } from './foodPhotoCatalogue.js';
import { measuredCall } from './photoMeasurement.js';
import { compositionForFood, dietaryTypeOf, isGenericFoodName } from './foodComposition.js';
// Photo recognition returns ordinary catalogue foods for the review and confirm
// flow. Missing foods are added with validated AI estimates, never marked as
// verified. Existing catalogue nutrition always takes precedence. Recognition
// does not write a diary entry; confirm still records the user's reviewed meal.
import { ensurePhotoFood } from './foodPhotoCatalogue.js';
import * as nutritionService from './nutritionService.js';
import * as foodPhotoStorage from './foodPhotoStorage.js';
import * as foodRequestService from './foodRequestService.js';
import { matchToCatalogue } from './foodMatch.js';
import { recognizeFood, isRecognizerConfigured } from './providers/index.js';
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

// The model's own confidence floor for trusting its `catalogue` assertion.
// A grounded-prompt model has an anchor bias: it will pick a row from the list
// even when it is guessing, and we refuse that by only trusting the assertion
// when it is not low-confidence. A missing confidence (null) is trusted - the
// model has not contradicted its own catalogue pick.
const MIN_TRUSTED_CATALOGUE_CONFIDENCE = 0.5;

// How much of the catalogue is sent to the model. Grounding grows input tokens
// linearly with catalogue size; a cap keeps a growing catalogue from growing
// the per-photo bill without limit. Rows past the cap simply stop being named
// candidates and fall back to free-text matching.
export const CATALOGUE_TEXT_MAX_CHARS = 8000;

/**
 * The catalogue, flattened to the one-line-per-name shape the grounded prompt
 * asks for. Capped in characters, truncated from the front of the list so the
 * model always sees the same deterministic slice for a given catalogue.
 */
export function buildCatalogueText(rows) {
  const lines = [];
  let chars = 0;
  for (const row of rows) {
    if (isGenericFoodName(row.name)) continue;
    const line = row.name + ((row.aliases || []).length ? ` — ${row.aliases.join(', ')}` : '');
    if (chars + line.length > CATALOGUE_TEXT_MAX_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
  }
  return lines.join('\n');
}

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
 * One provider call per request — no hidden retry here.
 *
 * The retry loop for this feature is the person holding the phone: a failed
 * recognition comes back fast as a 502, the app offers a Retry button, and the
 * next attempt carries a higher attempt number that providers/index.js rotates
 * to a different key and model (measured during a demand spike: gemini-3.5-flash
 * 503'd on roughly half the calls, so re-asking the same vendor is not a retry,
 * it is the same coin flip). A loop inside this call would defeat that in two
 * ways: it delays the error screen the rotation depends on, and it turns one
 * billable attempt into several.
 *
 * Non-provider errors and non-retryable ProviderErrors (a bad request, an
 * unconfigured key) surface on the first call for the same reason: retrying
 * those spends money to fail identically.
 */

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
  { userId, buffer, mimeType, attempt = 1, now = new Date(), deps = {} },
) {
  const { storage, recognize, isRecognizerConfigured: configured } =
    resolve(deps);

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

  // The curated catalogue is fetched once per photo and folded into the prompt,
  // so the model can name the EXACT row it means. Only rows the platform owns
  // are offered - a user's custom food is their data and does not belong in a
  // prompt that leaves the phone - and the same list is what the catalogue
  // resolution below trusts.
  const catalogueRows = await prisma.foodItem.findMany({
    where: { createdByUserId: null },
    select: { id: true, name: true, aliases: true, nonVeg: true, veg: true, dietaryType: true },
    orderBy: { name: 'asc' },
  });
  const config = experimentConfig();
  const promptRows = await shortlistRows(prisma, { userId, catalogueRows, now, enabled: config.shortlist });
  const catalogueText = buildCatalogueText(promptRows);
  const byCatalogueName = new Map(
    catalogueRows.filter((r) => !isGenericFoodName(r.name)).map((r) => [String(r.name).trim().toLowerCase(), r]),
  );

  // One catalogue search per distinct proposed name, shared by the enrichment
  // pass inside the cached call and the matching loop below.
  const searches = new Map();
  const findRow = async (item) => {
    const grounded = resolveCatalogueRow(item, byCatalogueName);
    if (grounded && sameDiet(item, grounded)) return grounded;
    const key = item.name.trim().toLowerCase();
    if (!searches.has(key)) {
      searches.set(key, await nutritionService.searchFoods(prisma, userId, {
        query: item.name,
        // The seeded catalogue is all `verified: false` (prisma/seed/foods.seed.js),
        // and the Flutter food picker already passes includeUnverified so logging
        // works at all. Refusing to match unverified rows here would mean the
        // photo feature silently recognises nothing on a fresh database.
        includeUnverified: true,
      }));
    }
    // The ranking is the service's job, so the whole matching candidate set
    // comes back and the best one is chosen from it.
    return matchToCatalogue(searches.get(key).filter((f) => sameDiet(item, f)), item.name);
  };

  let proposal;
  try {
    const configuration = {
      ...config, mimeType, attempt, catalogueText,
      providers: providerCandidates().map((c) => ({
        provider: c.provider, model: c.config.model || process.env.FOOD_PHOTO_PROVIDER_MODEL, baseUrl: c.config.baseUrl,
      })),
      defaultBaseUrl: process.env.FOOD_PHOTO_PROVIDER_BASE_URL,
      assistantModel: process.env.ASSISTANT_PROVIDER_MODEL,
    };
    proposal = await cachedRecognition(prisma, { userId, buffer, now, configuration }, async () => {
      const result = await measuredCall(prisma, userId, 'recognition',
        () => recognize({ imageBase64: buffer.toString('base64'), mimeType, catalogueText }, { attempt }));
      // Every new food needs nutrition before it can become a loggable row.
      // A proposal still missing some is a retryable failure, thrown here so
      // it is never cached: the retry gets a fresh call instead of the same gap.
      for (const item of (result.items || []).slice(0, MAX_ITEMS)) {
        if (isGenericFoodName(item.name) || await findRow(item)) continue;
        if (!normaliseFoodEstimate(item.nutrition) && config.mode !== 'baseline') {
          await enrichItem(item, { prisma, userId, recognize, attempt });
        }
        if (!normaliseFoodEstimate(item.nutrition)) {
          throw Object.assign(new Error('Could not read all food details. Try again.'), {
            status: 502, code: 'PROVIDER_FAILED',
          });
        }
      }
      return result;
    });
    if (proposal.cacheHit) {
      await prisma.foodPhotoUsage.create({ data: {
        userId, stage: 'recognition', outcome: 'cache_hit', latencyMs: Date.now() - startedAt,
        model: proposal.model, tokensIn: 0, tokensOut: 0, thinkingTokens: 0, totalTokens: 0, cachedTokens: 0,
      } });
    }
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
      console.error('[foodPhoto] provider failed', err.code);
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
    // First: the model's own grounded answer. When it names OUR row (a
    // `catalogue` value we sent it) with non-trivial confidence, that row is
    // exactly what it is pointing at, and it has already done the dialect ->
    // canonical work that free-text matching is worst at ("kuttu ki chilla" is
    // never going to reach "Buckwheat flour chilla" through prefix tiers).
    // Only an exact name match is honoured, and only against names we actually
    // sent - a model that invents "Paneer & greens" gets nothing for it, and
    // the name falls through to the ordinary matcher below.
    if (isGenericFoodName(item.name)) {
      unmatched.push({ name: item.name, confidence: item.confidence, reason: 'choose_variant', grams: item.grams });
      continue;
    }
    let food = await findRow(item);
    if (!food) {
      try {
        food = await ensurePhotoFood(prisma, item, { model: proposal.model });
      } catch (error) {
        await recordRequest(prisma, {
          userId, requestedAt: now, outcome: 'provider_error', photoPath,
          latencyMs: Date.now() - startedAt, model: proposal.model,
          tokensIn: proposal.tokensIn, tokensOut: proposal.tokensOut,
        });
        throw error;
      }
    }
    candidates.push({
      foodItemId: food.id,
      name: food.name,
      proposedName: item.name,
      grams: item.grams,
      confidence: item.confidence,
      nonVeg: food.nonVeg ?? item.nonVeg,
      servings: food.servings ?? null,
    });
  }

  // Per-100 g numbers for every matched row, in one read, so the review screen
  // can show what each line is worth before the user confirms it. The grounded
  // branch above only has the slim prompt rows, which carry no nutrients (and
  // no servings either, which this also fills in).
  const ids = [...new Set(candidates.map((c) => c.foodItemId))];
  if (ids.length) {
    const nutrientRows = await prisma.foodItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, kcal: true, proteinG: true, carbsG: true, fatG: true,
        fibreG: true, ironMg: true, magnesiumMg: true, calciumMg: true, zincMg: true,
        verified: true, servings: true, name: true, dietaryType: true, ingredients: true, ingredientsEstimated: true, nonVeg: true, veg: true },
    });
    const byId = new Map(nutrientRows.map((r) => [r.id, r]));
    for (const c of candidates) {
      const r = byId.get(c.foodItemId);
      if (!r) continue;
      c.per100g = {
        kcal: Number(r.kcal),
        proteinG: Number(r.proteinG),
        carbsG: Number(r.carbsG),
        fatG: Number(r.fatG),
        fibreG: r.fibreG == null ? null : Number(r.fibreG),
        ironMg: r.ironMg == null ? null : Number(r.ironMg),
        magnesiumMg: r.magnesiumMg == null ? null : Number(r.magnesiumMg),
        calciumMg: r.calciumMg == null ? null : Number(r.calciumMg),
        zincMg: r.zincMg == null ? null : Number(r.zincMg),

      };
      Object.assign(c, compositionForFood(r));
      c.nutritionVerified = r.verified === true;
      if (c.servings == null) c.servings = r.servings ?? null;
    }
  }

  await recordRequest(prisma, {
    userId,
    requestedAt: now,
    outcome: 'ok',
    latencyMs: Date.now() - startedAt,
    photoPath,
    model: proposal.model,
    // A cache hit cost nothing; its stored proposal still carries the original
    // call's token counts, which would double-count that spend.
    tokensIn: proposal.cacheHit ? 0 : proposal.tokensIn,
    tokensOut: proposal.cacheHit ? 0 : proposal.tokensOut,
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

/**
 * Store and claim a photo WITHOUT calling the vision model.
 *
 * The cheaper half of the on-device matcher (see foodEmbeddingService.js): the
 * phone embeds the plate locally and only reaches the paid cloud call when it
 * cannot name what it sees. A photo that IS matched on-device still has to be
 * stored and claimed, because confirm attaches the object the same way it does
 * for recognize - so this is recognizePhoto minus the provider. The difference
 * is the whole point: no `configured()` gate and no vision call, which is what
 * makes an on-device match cost nothing but storage.
 *
 * Recorded with outcome `on_device_upload` so the sweeper and the admin counts
 * can tell an on-device claim from a recognized one - and rule 1 of this file
 * holds: the model never supplied any number here, because there was no model.
 * The default grams the app proposes on an on-device line come from the
 * catalogue row / user, exactly as they would after a recognition.
 */
export async function uploadPhotoOnly(
  prisma,
  { userId, buffer, mimeType, now = new Date(), deps = {} },
) {
  const { storage } = resolve(deps);

  if (!buffer || !buffer.length) throw badRequest('No photo received', 'NO_PHOTO');
  if (!storage.isAllowedMimeType(mimeType)) {
    throw badRequest('That image type is not accepted', 'UNSUPPORTED_IMAGE');
  }

  // The hourly cap applies to uploads as well as recognitions: a short-circuit
  // must not become a cheaper way to fill the bucket, and the limit is a spend
  // bound either way (storage is per-photo churn that the sweeper must reclaim).
  await assertWithinRateLimit(prisma, userId, now);

  const photoPath = await storage.savePhoto({ buffer, mimeType, userId });
  await recordRequest(prisma, {
    userId,
    requestedAt: now,
    outcome: 'on_device_upload',
    photoPath,
  });

  return { photoPath, photoUrl: await storage.signedPhotoUrl(photoPath) };
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
  let pending = 0;

  for (const line of lines.slice(0, MAX_ITEMS)) {
    // One line failing must not lose the rest: the user corrected a plate, and
    // silently dropping the line they did not touch would be worse than telling
    // them which one went wrong.
    try {
      // A line the catalogue does not cover is not dropped once the user says
      // it was on the plate - it is logged as KNOWN-UNKNOWN (rule 3): present
      // in the day, named, but with no fabricated numbers. The same name raises
      // a missing-food request so the queue sees the dish. This write is the
      // user's own decision to log it, so it must not be blocked by the shared
      // request queue's rate cap - see autoRecordPhotoRequest.
      if (line.unknown === true || line.foodItemId == null) {
        const log = await nutritionService.logUnknownFood(prisma, {
          userId,
          localDate,
          slot,
          grams: line.grams,
          name: line.name || line.proposedName,
          servingLabel: line.servingLabel,
          nonVeg: line.nonVeg,
          photoCorrections: line.corrected ? 1 : 0,
          photo: {
            path: photoPath,
            proposedName: line.proposedName || null,
            confidence: line.confidence,
            model: claim.model,
          },
        });
        if (line.corrected) corrections += 1;
        pending += 1;
        created.push(log);

        // The demand signal, best-effort and never fatal: if the request queue
        // refuses (rate cap), the pending FoodLog above still stands - logging
        // what you ate must not depend on the queue accepting a new row.
        if (log.name) {
          await foodRequestService
            .autoRecordPhotoRequest(prisma, { userId, name: log.name })
            .catch((err) => console.error('[foodPhoto] photo request failed:', err.message));
        }
        continue;
      }

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
      rejected.push({ name: line.proposedName || line.name || null, reason: err.message });
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
    pending,
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
 * Resolves the model's grounded `catalogue` assertion to a real row, or null.
 *
 * Only an exact match against the names we sent is trusted, and only when the
 * model was not low-confidence about it (see MIN_TRUSTED_CATALOGUE_CONFIDENCE).
 * An assertion about a name we never sent, or a low-confidence one, is worth
 * nothing and the caller falls back to free-text matching.
 */
function resolveCatalogueRow(item, byCatalogueName) {
  const name = String(item?.catalogue || '').trim().toLowerCase();
  if (!name) return null;

  const confidence = item?.confidence;
  if (
    confidence != null &&
    Number.isFinite(Number(confidence)) &&
    Number(confidence) < MIN_TRUSTED_CATALOGUE_CONFIDENCE
  ) {
    return null;
  }

  return byCatalogueName.get(name) || null;
}

// A row is only a match when it agrees with the model on veg / egg / non-veg.
// An item the model could not classify ('unknown' or absent) matches any row.
function sameDiet(item, row) {
  return !item.dietaryType || item.dietaryType === 'unknown' || dietaryTypeOf(row) === item.dietaryType;
}

/**
 * Fills in nutrition for one unfamiliar food with a text-only call.
 *
 * The enrichment prompt asks for exactly one food, so its first item IS the
 * answer: requiring the model to echo the name back character for character
 * turned any rewording ("Aloo tikki burger" for "Aloo burger") into a failed
 * photo. Never throws on a bad answer - the caller decides what a food without
 * nutrition means.
 */
async function enrichItem(item, { prisma, userId, recognize, attempt }) {
  try {
    const enriched = await measuredCall(prisma, userId, 'enrichment',
      () => recognize({ enrichmentName: item.name, catalogueText: '' }, { attempt }));
    const estimate = enriched.items?.[0];
    if (!estimate || !normaliseFoodEstimate(estimate.nutrition)) return;
    Object.assign(item, {
      nutrition: estimate.nutrition,
      ...(estimate.ingredients?.length ? { ingredients: estimate.ingredients } : {}),
      ...(estimate.dietaryType ? { dietaryType: estimate.dietaryType } : {}),
    });
  } catch (err) {
    if (!isProviderError(err)) throw err;
  }
}

// Meal slot from the IST hour, matching the slots the diary itself uses.
export function mealSlotFor(now) {
  const hour = new Date(now.getTime() + 330 * 60 * 1000).getUTCHours();
  if (hour >= 4 && hour < 11) return 'breakfast';
  if (hour >= 11 && hour < 16) return 'lunch';
  if (hour >= 16 && hour < 19) return 'snack';
  return 'dinner';
}

const SHORTLIST_PERSONAL = 30;
const SHORTLIST_SLOT = 20;
const SHORTLIST_POPULAR = 20;

/**
 * The catalogue names offered to the model as hints.
 *
 * There is no image signal before the call, so the shortlist is built from
 * what we already know: this person's frequent foods, what people log in this
 * meal slot, and what is logged most overall. It is a hint, never a limit -
 * the model may name anything, and every proposed name still goes through the
 * full-catalogue search in findRow. Off (the default) sends the whole catalogue.
 */
export async function shortlistRows(prisma, { userId, catalogueRows, now = new Date(), enabled = false }) {
  if (!enabled) return catalogueRows;
  const top = (where, take) => prisma.foodLog.groupBy({
    by: ['foodItemId'], where: { foodItemId: { not: null }, ...where },
    _count: { foodItemId: true }, orderBy: { _count: { foodItemId: 'desc' } }, take,
  });
  const [personal, slot, popular] = await Promise.all([
    top({ userId }, SHORTLIST_PERSONAL),
    top({ slot: mealSlotFor(now) }, SHORTLIST_SLOT),
    top({}, SHORTLIST_POPULAR),
  ]);
  const ids = new Set([...personal, ...slot, ...popular].map((r) => r.foodItemId));
  const rows = catalogueRows.filter((r) => ids.has(r.id));
  return rows.length ? rows : catalogueRows;
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
    // One call, on the candidate the attempt number is owed — see
    // providers/index.js for the rotation and recognizePhoto for why the
    // service itself never retries.
    recognize: deps.recognize ?? recognizeFood,
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
