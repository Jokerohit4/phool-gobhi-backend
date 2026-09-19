import { PrismaClient } from '@prisma/client';
import { getProvider } from './providers/index.js';

const prisma = new PrismaClient();

/// The only keys that may ever be written. The model proposes; this list
/// disposes. Anything else it invents is dropped rather than stored, so a
/// hallucinated category cannot quietly become permanent context.
///
/// Note what is NOT here: nothing that writes to PersonalisationProfile.
/// injuryZones has its own consent gate and drives real programming decisions
/// elsewhere, so an injury mentioned in chat lands in 'injury_mentioned' and
/// stays advisory until a human promotes it. That separation is a correctness
/// boundary, not a compliance one — a model-extracted injury silently changing
/// someone's training plan is a bug in any regime.
export const MEMORY_KEYS = ['goal', 'injury_mentioned', 'allergy', 'equipment', 'preference'];

const MAX_VALUE_CHARS = 200;
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
  const out = [];
  for (const m of parsed.memories) {
    if (!m || typeof m.key !== 'string' || typeof m.value !== 'string') continue;
    const key = m.key.trim().toLowerCase();
    const value = m.value.trim().replace(/\s+/g, ' ');
    if (!MEMORY_KEYS.includes(key)) continue;
    if (!value || value.length > MAX_VALUE_CHARS) continue;
    // (userId, key) is unique in the schema, so two proposals for one key in a
    // single turn would race each other; keep the first.
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, value });
    if (out.length >= MAX_MEMORIES_PER_TURN) break;
  }
  return out;
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

  await Promise.all(
    memories.map((m) =>
      prisma.assistantMemory
        .upsert({
          where: { userId_key: { userId, key: m.key } },
          // Last statement wins: someone who says "actually my goal is
          // strength now" has changed their mind, and keeping the older value
          // would make the coach argue with them.
          update: { value: m.value, source: 'extracted' },
          create: { userId, key: m.key, value: m.value, source: 'extracted' },
        })
        .catch(() => null)
    )
  );

  return memories;
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
  const cleanValue = String(value || '').trim().replace(/\s+/g, ' ');
  if (!cleanValue) throw { status: 400, error: 'value cannot be empty' };
  if (cleanValue.length > MAX_VALUE_CHARS) {
    throw { status: 400, error: `value is too long (max ${MAX_VALUE_CHARS} characters)` };
  }

  return prisma.assistantMemory.upsert({
    where: { userId_key: { userId, key: cleanKey } },
    update: { value: cleanValue, source: 'user_confirmed' },
    create: { userId, key: cleanKey, value: cleanValue, source: 'user_confirmed' },
  });
}

export async function listMemoriesService(userId) {
  return prisma.assistantMemory.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, key: true, value: true, source: true, updatedAt: true },
  });
}

/// Forgetting has to be as easy as remembering. Without this the only way to
/// remove a wrong fact the model inferred is to delete every conversation.
export async function forgetMemoryService(userId, id) {
  const row = await prisma.assistantMemory.findUnique({ where: { id } });
  if (!row || row.userId !== userId) throw { status: 404, error: 'Memory not found' };
  await prisma.assistantMemory.delete({ where: { id } });
  return { deleted: true };
}
