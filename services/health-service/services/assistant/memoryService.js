import { PrismaClient } from '@prisma/client';
import { getProvider } from './providers/index.js';

const prisma = new PrismaClient();

/// The only keys that may ever be written, and everything that differs between
/// them. The model proposes; this table disposes — anything it invents is
/// dropped rather than stored, so a hallucinated category cannot quietly
/// become permanent context.
///
/// Three properties, because a single uniform rule is wrong for at least one
/// key whichever rule you pick:
///
///   tier         What this is worth when space or storage runs out. 1 is
///                safety (getting it wrong can hurt someone), 2 is direction
///                (what the advice should aim at), 3 is colour (makes answers
///                better; losing one is harmless). Drives prompt ordering,
///                truncation and eviction — see buildUserContextService and
///                enforceCap below.
///
///   cardinality  'one' replaces on write, 'many' accumulates. A new goal
///                means the old goal is over — that is what changing your mind
///                is, and keeping both would have the coach serve two
///                contradictory targets. A new allergy means there are now two
///                allergies, and replacing would delete a fact that matters.
///
///   max          Per-key ceiling. Without one, a chatty user's memory list
///                grows until it crowds the rest of the context out of the
///                prompt.
///
/// Tier lives here rather than in a column on purpose: it is a property of the
/// key, not of the row. There is no such thing as a low-priority allergy, so a
/// per-row value could only ever drift out of agreement with itself, and
/// re-tiering a key would need a migration instead of this one line. A stored
/// column would earn its place if tiers varied per user or had to be retuned
/// without a deploy; neither is true.
///
/// Note what is NOT here: nothing that writes to PersonalisationProfile.
/// injuryZones has its own consent gate and drives real programming decisions
/// elsewhere, so an injury mentioned in chat lands in 'injury_mentioned' and
/// stays advisory until a human promotes it. That separation is a correctness
/// boundary, not a compliance one — a model-extracted injury silently changing
/// someone's training plan is a bug in any regime.
///   max          Per-key ceiling, and the reason no retrieval step is needed.
///                Every memory goes into every prompt, so the caps ARE the
///                budget: 25 rows at 80 characters is the entire worst case,
///                and it fits. Retrieval exists for unbounded corpora; this
///                one is bounded by construction.
export const KEY_POLICY = {
  allergy: { tier: 1, cardinality: 'many', max: 6 },
  injury_mentioned: { tier: 1, cardinality: 'many', max: 6 },
  goal: { tier: 2, cardinality: 'one', max: 1 },
  equipment: { tier: 3, cardinality: 'many', max: 6 },
  preference: { tier: 3, cardinality: 'many', max: 6 },
};

export const MEMORY_KEYS = Object.keys(KEY_POLICY);

/// Tier of a key, for callers that order or trim a memory list. Unknown keys
/// sort last rather than throwing — a key that somehow escaped validation
/// should lose its place in the prompt, not break the prompt.
export function tierOf(key) {
  return KEY_POLICY[key]?.tier ?? 9;
}

// A memory is a PHRASE, not a sentence and not a keyword.
//
// Enforced structurally rather than by asking the model nicely: the extraction
// prompt requests a short phrase, but nothing stopped it returning two
// sentences while this cap sat at 200 characters. 200 is a paragraph. At 80 a
// value that sprawls is rejected rather than stored, which also keeps the
// worst-case memory block (every key at its cap) inside the context budget.
const MAX_VALUE_CHARS = 80;
const MAX_MEMORIES_PER_TURN = 3;


// Cheap gate before spending a model call. Most turns in a coaching
// conversation are questions, acknowledgements or small talk and contain no
// durable fact at all — running an extraction on those would roughly double
// token usage to learn nothing, which matters a great deal on a plan where the
// binding limit is tokens per minute.
const MEMORABLE_PATTERNS = [
  /\bi(?:'m| am)\b/i,
  // Note "do" only ever appears negated. A bare "I do" is almost always part
  // of a question ("what should I do tomorrow?"), which is the single most
  // common message in a coaching chat and carries no durable fact at all.
  /\bi\s+(?:have|want|need|prefer|like|hate|can(?:'t|not)?|do(?:n't| not)|train|eat|work out|avoid)\b/i,
  /\bmy\s+(?:goal|knee|back|shoulder|wrist|hip|ankle|elbow|neck|diet|gym|target|plan|schedule)\b/i,
  /\ballergic\b/i,
  /\b(?:vegan|vegetarian|lactose|gluten)\b/i,
  /\b(?:dumbbell|barbell|kettlebell|home gym|resistance band|pull.?up bar|treadmill)\b/i,
  /\b(?:injur|surger|physio|pain)\w*/i,
];

/// Whether this message plausibly contains something worth remembering.
/// Deliberately generous: a false positive costs one small call, a false
/// negative loses a fact forever.
export function looksMemorable(text) {
  const t = (text || '').trim();
  if (t.length < 12) return false;
  // A single-clause question states nothing, however many first-person verbs
  // it contains ("what do I need to do first?"). A question with a clause
  // before it often does ("I'm allergic to peanuts, is that a problem?"), so
  // only the unbroken one is skipped.
  if (/\?$/.test(t) && !/[.,;]/.test(t.slice(0, -1))) return false;
  return MEMORABLE_PATTERNS.some((re) => re.test(t));
}

const EXTRACTION_PROMPT = [
  'Extract durable facts about the user from their message — things that would',
  'still be true next week and are worth remembering in future conversations.',
  '',
  `Reply with JSON only: {"memories":[{"key":"...","value":"..."}]}`,
  `Allowed keys: ${MEMORY_KEYS.join(', ')}.`,
  '',
  'Rules:',
  '- Only facts the user states about themselves. Never infer, never guess.',
  '- Ignore questions, one-off events ("I trained legs today") and small talk.',
  '- value: a short third-person phrase, e.g. "wants to add 5kg of muscle".',
  // A negation is a fact the user stated, so without this rule "I don't have
  // any allergies" becomes `allergy: none` — which then renders inside the
  // safety block as though it were an allergy, and occupies one of six slots.
  '- Skip negations. "I have no allergies" and "nothing hurts" are not facts to store.',
  // The single most likely way this store goes wrong: a passing complaint
  // becomes a permanent entry in the one tier that is never evicted or
  // truncated, and biases advice forever.
  '- Skip anything temporary. "my knee is sore today" is not an injury to remember;',
  '  "had knee surgery in 2023" is. If it might pass in a week, leave it out.',
  '- When a fact has a timeframe the user gave, keep it in the phrase ("since 2023").',
  `- Return {"memories":[]} when there is nothing durable. That is the common case.`,
].join('\n');

/// Parses and hard-validates the model's proposal. Exported because this, not
/// the network call, is where the risk lives: everything here is untrusted
/// model output heading for a durable store that is replayed into every
/// subsequent prompt.
export function parseMemories(raw) {
  if (typeof raw !== 'string') return [];
  // Models wrap JSON in prose or fences often enough that failing on it would
  // make extraction unreliable for no good reason.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!parsed || !Array.isArray(parsed.memories)) return [];

  const seen = new Set();
  const singularUsed = new Set();
  const out = [];
  for (const m of parsed.memories) {
    if (!m || typeof m.key !== 'string' || typeof m.value !== 'string') continue;
    const key = m.key.trim().toLowerCase();
    const value = normaliseValue(m.value);
    if (!MEMORY_KEYS.includes(key)) continue;
    if (!value || value.length > MAX_VALUE_CHARS) continue;
    // (userId, key, value) is unique in the schema, so the same fact twice in
    // one turn would race itself.
    const pair = `${key}\u0000${value}`;
    if (seen.has(pair)) continue;
    // A 'one' key can only take a single value, so two proposals for it in a
    // single message are a contradiction the model has handed us rather than a
    // pair of facts. Keep the first and drop the rest — guessing which of two
    // conflicting goals is current is not something to do silently.
    if (KEY_POLICY[key].cardinality === 'one') {
      if (singularUsed.has(key)) continue;
      singularUsed.add(key);
    }
    seen.add(pair);
    out.push({ key, value });
    if (out.length >= MAX_MEMORIES_PER_TURN) break;
  }
  return out;
}

/// One spelling per fact. Without this "Peanuts" and "peanuts " are two rows
/// that the unique index cannot tell apart, and the list fills with the same
/// thing written differently.
///
/// Lower-casing costs a little in the panel ("hiit" rather than "HIIT"); these
/// are short third-person phrases, so that is the cheaper side of the trade.
/// It does NOT solve near-duplicates — "peanuts" and "peanut allergy" are one
/// fact and will still be two rows, because no index can see meaning. The cap
/// below and the user's own delete button are the mitigation there.
function normaliseValue(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/// Learn durable facts from one user message and store them.
///
/// Fire-and-forget by contract: the caller does not await this, and it never
/// throws. A failed extraction costs a slightly less personal answer next
/// time, which is not worth failing a reply the user already has.
export async function extractMemoriesService(userId, text) {
  if (!looksMemorable(text)) return [];

  let result;
  try {
    result = await getProvider().generate({
      systemPrompt: EXTRACTION_PROMPT,
      messages: [{ role: 'user', content: text }],
      maxTokens: 200,
      // Tighter than a chat turn: this is a background call and nobody is
      // waiting on it, so it should give up rather than hold a connection.
      timeoutMs: 10000,
    });
  } catch {
    return [];
  }

  const memories = parseMemories(result?.content);
  if (!memories.length) return [];

  for (const m of memories) {
    await storeMemory(userId, m.key, m.value, 'extracted').catch(() => null);
  }

  return memories;
}

/// Write one fact, honouring its key's cardinality, then enforce its cap.
///
/// Sequential rather than parallel across a turn's memories: two writes to the
/// same key racing each other would both read the row count before either
/// inserted, and the cap would be enforced against a stale number.
async function storeMemory(userId, key, value, source) {
  const policy = KEY_POLICY[key];

  if (policy.cardinality === 'one') {
    // Replace rather than accumulate. Prisma has no "delete others and
    // upsert" primitive, so this is a transaction: a crash between the two
    // would otherwise leave the user with no goal at all.
    await prisma.$transaction([
      prisma.assistantMemory.deleteMany({ where: { userId, key, NOT: { value } } }),
      prisma.assistantMemory.upsert({
        where: { userId_key_value: { userId, key, value } },
        update: { source },
        create: { userId, key, value, source },
      }),
    ]);
    return;
  }

  await prisma.assistantMemory.upsert({
    where: { userId_key_value: { userId, key, value } },
    // Restating a fact is not new information, but it does mean they still
    // hold it — touch the row so the cap evicts genuinely stale entries.
    update: { source },
    create: { userId, key, value, source },
  });
  await enforceCap(userId, key, policy.max);
}

/// Keep a key within its ceiling, oldest first.
///
/// Only 'extracted' rows are ever evicted. A fact the user stated by hand must
/// not be pushed out by one a model inferred — that would let the coach
/// silently overrule its own user. If the cap is full of confirmed rows the
/// list simply stays at its size; confirmMemoryService refuses to add more and
/// says so, rather than deleting something the person chose to keep.
async function enforceCap(userId, key, max) {
  const total = await prisma.assistantMemory.count({ where: { userId, key } });
  if (total <= max) return;

  const evictable = await prisma.assistantMemory.findMany({
    where: { userId, key, source: 'extracted' },
    orderBy: { updatedAt: 'asc' },
    take: total - max,
    select: { id: true },
  });
  if (!evictable.length) return;
  await prisma.assistantMemory.deleteMany({
    where: { id: { in: evictable.map((r) => r.id) } },
  });
}

/// Promote a memory the user has explicitly confirmed, or correct one.
///
/// This is the path that sets source:'user_confirmed', which otherwise never
/// occurs — an extracted fact and a stated one carry different weight, and the
/// UI should be able to show which is which.
export async function confirmMemoryService(userId, key, value) {
  const cleanKey = String(key || '').trim().toLowerCase();
  if (!MEMORY_KEYS.includes(cleanKey)) {
    throw { status: 400, error: `key must be one of: ${MEMORY_KEYS.join(', ')}` };
  }
  const cleanValue = normaliseValue(value);
  if (!cleanValue) throw { status: 400, error: 'value cannot be empty' };
  if (cleanValue.length > MAX_VALUE_CHARS) {
    throw { status: 400, error: `value is too long (max ${MAX_VALUE_CHARS} characters)` };
  }

  const policy = KEY_POLICY[cleanKey];
  if (policy.cardinality === 'many') {
    // Refuse rather than evict. enforceCap only ever removes extracted rows,
    // so silently making room here would mean deleting something the user
    // deliberately kept in order to store something else they deliberately
    // kept. Telling them which one to drop is their decision to make.
    const existing = await prisma.assistantMemory.count({
      where: { userId, key: cleanKey, NOT: { value: cleanValue } },
    });
    if (existing >= policy.max) {
      throw {
        status: 409,
        error: `You can keep up to ${policy.max} of these — remove one first.`,
        code: 'MEMORY_LIMIT',
      };
    }
  }

  await storeMemory(userId, cleanKey, cleanValue, 'user_confirmed');
  return prisma.assistantMemory.findUnique({
    where: { userId_key_value: { userId, key: cleanKey, value: cleanValue } },
  });
}

/// Stable ordering: tier, then key, then id.
///
/// Used by BOTH the panel and the prompt, and it has to be byte-stable across
/// turns for the second of those. The prompt's prefix is cached by the
/// provider — cached tokens are half price AND exempt from the rate limit — so
/// a memory block that reshuffles between turns silently costs full price on
/// everything after it. Ordering by updatedAt would do exactly that, because
/// restating a fact touches the row.
///
/// Sorted here rather than in SQL because tier lives in KEY_POLICY, not in a
/// column — see the note there for why that is the right place for it.
export function orderMemories(rows) {
  return [...rows].sort(
    (a, b) =>
      tierOf(a.key) - tierOf(b.key) || a.key.localeCompare(b.key) || a.id - b.id
  );
}

export async function listMemoriesService(userId) {
  const rows = await prisma.assistantMemory.findMany({
    where: { userId },
    select: { id: true, key: true, value: true, source: true, updatedAt: true },
  });
  return orderMemories(rows);
}

/// Forgetting has to be as easy as remembering. Without this the only way to
/// remove a wrong fact the model inferred is to delete every conversation.
export async function forgetMemoryService(userId, id) {
  const row = await prisma.assistantMemory.findUnique({ where: { id } });
  if (!row || row.userId !== userId) throw { status: 404, error: 'Memory not found' };
  await prisma.assistantMemory.delete({ where: { id } });
  return { deleted: true };
}
