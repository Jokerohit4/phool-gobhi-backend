// The text half of the on-device photo matcher.
//
// Cost structure: recognizing a photo is a PAID VISION CALL, every photo, and
// the catalogue growing never changes that. The only way a photo gets cheap is
// to not make the paid call at all for the items a phone can match locally.
// That needs three things - an on-device model that can embed a photograph, a
// catalogue the phone can compare against, and a shared embedding space. This
// module is the second of the three and the seam for the first: it computes
// and caches a vector per catalogue food, once, so the app downloads the
// vectors and never pays for the vision call on items it can already name.
//
// This is deliberately a CACHE, not a new database. The vector is derived from
// the text of the row, so a row change invalidates its vectors and a refresh
// recomputes them. FoodEmbedding is created only here, never by hand, and the
// model id is kept so a model upgrade writes fresh rows instead of pretending
// an old space is a new one.

const EMBED_BASE_URL_DEFAULT = 'https://generativelanguage.googleapis.com/v1beta';
const EMBED_MODEL_DEFAULT = 'text-embedding-004';

function embedBaseUrl() {
  return (process.env.FOOD_PHOTO_PROVIDER_BASE_URL || EMBED_BASE_URL_DEFAULT).trim().replace(/\/+$/, '');
}

function embedApiKey() {
  return (process.env.FOOD_PHOTO_PROVIDER_API_KEY || '').trim();
}

function embedModel(override) {
  return (override || process.env.FOOD_EMBEDDING_MODEL || EMBED_MODEL_DEFAULT).trim();
}

// Batch size per request. The provider accepts an array of texts, and a bigger
// batch is fewer round trips for the same number of vectors.
const BATCH_SIZE = 64;

function displayName(food) {
  return [String(food.name || ''), ...(food.aliases || [])]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function providerError(message, code, status = 502) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * The vectors, shaped for the app's matcher.
 *
 * Empty until a refresh has run: `{ model: null, count: 0, foods: [] }` is a
 * valid first answer, and the app treats it as "no pre-match yet". `embedding`
 * is the raw float array as stored - the app applies its own normalisation,
 * so the bytes here are deliberately untouched.
 */
export async function getForMatcher(prisma) {
  const rows = await prisma.foodEmbedding.findMany({
    orderBy: [{ foodItemId: 'asc' }],
  });
  if (!rows.length) return { model: null, count: 0, foods: [] };

  const foods = await prisma.foodItem.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.foodItemId))] } },
    select: { id: true, name: true, aliases: true },
  });
  const byId = new Map(foods.map((f) => [f.id, f]));

  return {
    model: rows[0].model || null,
    count: rows.length,
    foods: rows
      .map((row) => {
        const food = byId.get(row.foodItemId);
        if (!food || !Array.isArray(row.embedding)) return null;
        return {
          id: food.id,
          name: food.name,
          aliases: food.aliases,
          embedding: row.embedding,
        };
      })
      .filter(Boolean),
  };
}

/**
 * Recompute the vector for every curated food.
 *
 * The provider call is injected so the batch logic is testable without a key;
 * the default speaks to the same Gemini key used for photo recognition and
 * covers the curated catalogue only (a user's custom food is their data and
 * leaves no copy).
 *
 * Recommended run cadence: after any seed change. It is a single batched
 * request, not per-photo spend, so refreshing eagerly is cheap.
 */
export async function refreshAll(prisma, { fetchBatch = defaultFetchBatch, model = null, now = new Date() } = {}) {
  const resolvedModel = embedModel(model);
  if (!embedApiKey() || !resolvedModel) {
    throw providerError('The food embedding provider is not configured', 'PROVIDER_NOT_CONFIGURED', 503);
  }

  const items = await prisma.foodItem.findMany({
    where: { createdByUserId: null },
    select: { id: true, name: true, aliases: true },
    orderBy: [{ name: 'asc' }],
  });
  if (!items.length) return { model: resolvedModel, computed: 0 };

  const vectors = await fetchBatch(items.map(displayName));
  if (!Array.isArray(vectors) || vectors.length !== items.length) {
    throw providerError('The embedding provider returned a partial set', 'PROVIDER_BAD_SHAPE');
  }

  let computed = 0;
  for (let i = 0; i < items.length; i += 1) {
    const embedding = vectors[i];
    if (!Array.isArray(embedding) || !embedding.length) continue;
    await prisma.foodEmbedding.upsert({
      where: { foodItemId_model: { foodItemId: items[i].id, model: resolvedModel } },
      create: { foodItemId: items[i].id, model: resolvedModel, embedding },
      update: { embedding, model: resolvedModel },
    });
    computed += 1;
  }

  return { model: resolvedModel, computed };
}

export async function defaultFetchBatch(texts) {
  const key = embedApiKey();
  const model = embedModel();
  const url = `${embedBaseUrl()}/models/${encodeURIComponent(model)}:batchEmbedContents`;
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const slice = texts.slice(i, i + BATCH_SIZE);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        body: JSON.stringify({
          requests: slice.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
          })),
        }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      throw providerError('The embedding provider is unreachable', 'PROVIDER_UNREACHABLE');
    }
    if (!res.ok) {
      throw providerError(`The embedding provider returned ${res.status}`, 'PROVIDER_REJECTED');
    }
    const body = await res.json();
    out.push(...((body?.embeddings || []).map((e) => e?.values)));
  }
  return out;
}