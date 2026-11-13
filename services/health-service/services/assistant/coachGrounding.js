// What Gobhi is told on top of the normal user context, when the
// coachAssistant flag is on (B16).
//
//   plan       the person's own plan: workout slots, steps, sleep, water,
//              food budget, and which journey layers are open. Fixed phrases
//              and numbers only — nothing the user typed.
//   supplements a COUNT of active supplement schedules, never the names. Same
//              rule contextService already applies to medicines: what someone
//              puts in their body is not sent to a model provider, and the
//              coach has no use for the names because it may never advise on
//              them anyway.
//   notes      up to 3 approved coaching notes (exercise instructions or
//              articles) whose words match the question, in the person's
//              language when an approved translation exists. Approved rows
//              only, via contentService — the same review gate the app reads.
//
// Placed AFTER the user context in the system prompt: it changes with every
// message, and everything before it stays byte-identical so the provider's
// prompt cache keeps working.
//
// Every read is best-effort. A failed read costs the coach a line, never the
// answer.

import { getExerciseContent, getArticle } from '../contentService.js';

const MAX_NOTES = 3;
const MAX_NOTE_CHARS = 700;
export const MAX_GROUNDING_CHARS = 2600;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LAYER_NAMES = {
  workout: 'workout days',
  water: 'water',
  food: 'food',
  steps: 'steps',
  sleep: 'sleep',
  supplements: 'supplement ticks',
  health: 'health reports',
};

const STOPWORDS = new Set([
  'what', 'when', 'where', 'which', 'with', 'this', 'that', 'should', 'would', 'could', 'about', 'there',
  'their', 'have', 'from', 'your', 'mera', 'meri', 'kaise', 'karna', 'karu', 'chahiye', 'hota', 'hoti',
  'does', 'doing', 'today', 'tomorrow', 'gobhi', 'please', 'help', 'want', 'need', 'like', 'just',
]);

/// Words worth matching: 4+ letters (Latin or Devanagari), lowercased,
/// minus filler. Exported for the tests.
export function keywords(text) {
  const words = String(text || '').toLowerCase().match(/[a-z]{4,}|[ऀ-ॿ]{3,}/g) || [];
  return [...new Set(words.filter((w) => !STOPWORDS.has(w)))];
}

/// The plan as one short block. Exported for the tests.
export function summarisePlan({ prescription, unlockedLayerKeys, steadyWeeks }) {
  const lines = [];
  const slots = Array.isArray(prescription?.workoutSlots) ? prescription.workoutSlots : [];
  if (slots.length) {
    const days = [...slots]
      .sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7))
      .map((s) => `${DAY_NAMES[s.weekday] ?? '?'} ${String(s.title || 'workout').slice(0, 40)}`);
    lines.push(`Workout days: ${days.join(', ')}.`);
  }
  if (prescription) {
    const bits = [];
    if (prescription.stepsPerDay) bits.push(`${prescription.stepsPerDay} steps`);
    if (prescription.sleepMinutes) bits.push(`${Math.round((prescription.sleepMinutes / 60) * 10) / 10} h sleep`);
    if (prescription.kcal) bits.push(`about ${prescription.kcal} kcal of food`);
    if (bits.length) lines.push(`Daily targets: ${bits.join(', ')}.`);
  }
  if (Array.isArray(unlockedLayerKeys) && unlockedLayerKeys.length) {
    const open = unlockedLayerKeys.map((k) => LAYER_NAMES[k]).filter(Boolean);
    const locked = Object.keys(LAYER_NAMES).filter((k) => !unlockedLayerKeys.includes(k)).map((k) => LAYER_NAMES[k]);
    lines.push(`Open in their plan: ${open.join(', ')}.${locked.length ? ` Not open yet: ${locked.join(', ')}.` : ''}`);
  }
  if (Number.isInteger(steadyWeeks)) lines.push(`Steady weeks so far: ${steadyWeeks}.`);
  if (!lines.length) return null;
  return `Their plan from Gobhi:\n${lines.join('\n')}`;
}

function cap(text, max) {
  const t = String(text || '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/// Pick up to MAX_NOTES approved notes that match the question.
async function relevantNotes(prisma, message, lang) {
  const words = keywords(message);
  if (!words.length) return [];
  const hits = (text) => words.filter((w) => String(text || '').toLowerCase().includes(w)).length;

  const scored = [];
  const approvedExercises = await prisma.exerciseContent.findMany({
    where: { lang: 'en', reviewStatus: 'approved' },
    select: { exerciseId: true },
    take: 500,
  });
  const ids = [...new Set(approvedExercises.map((r) => r.exerciseId))];
  if (ids.length) {
    const exercises = await prisma.exercise.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    for (const ex of exercises) {
      const score = hits(ex.name);
      if (score > 0) scored.push({ score: score + 1, kind: 'exercise', id: ex.id, name: ex.name });
    }
  }
  const articles = await prisma.coachArticle.findMany({
    where: { lang: 'en', reviewStatus: 'approved' },
    select: { slug: true, title: true, body: true },
    take: 200,
  });
  for (const a of articles) {
    const score = hits(a.title) * 2 + hits(a.body);
    if (score > 0) scored.push({ score, kind: 'article', slug: a.slug });
  }

  scored.sort((a, b) => b.score - a.score);
  const notes = [];
  for (const s of scored.slice(0, MAX_NOTES)) {
    if (s.kind === 'exercise') {
      const c = await getExerciseContent(prisma, s.id, lang);
      if (!c) continue;
      notes.push(cap(
        `${s.name} — how to: ${c.steps.join(' ')} Feel it: ${c.feelCues.join(' ')} Avoid: ${c.mistakes.join(' ')}`,
        MAX_NOTE_CHARS,
      ));
    } else {
      const a = await getArticle(prisma, s.slug, lang);
      if (a) notes.push(cap(`${a.title} — ${a.body.replace(/\s+/g, ' ')}`, MAX_NOTE_CHARS));
    }
  }
  return notes;
}

/// Builds the grounding block. `deps` carries the journey reads so the tests
/// can stand in for them; production passes the real journey service.
export async function buildCoachGrounding(prisma, { userId, message, lang }, deps) {
  const safe = (p) => Promise.resolve().then(() => p).catch(() => null);
  const [prescription, unlockedLayerKeys, steadyWeeks, supplementCount, notes] = await Promise.all([
    safe(prisma.prescription.findUnique({ where: { userId } })),
    safe(deps.getUnlockedLayerKeys(userId)),
    safe(deps.getSteadyWeeks(userId)),
    safe(prisma.supplementSchedule.count({ where: { userId, active: true } })),
    safe(relevantNotes(prisma, message, lang)),
  ]);

  const parts = [];
  const plan = summarisePlan({ prescription, unlockedLayerKeys, steadyWeeks });
  if (plan) parts.push(plan);
  if (supplementCount) {
    parts.push(`They log ${supplementCount} supplement${supplementCount === 1 ? '' : 's'} they already take (names withheld). Never advise on them.`);
  }
  if (notes?.length) {
    parts.push(`Approved coaching notes (founder-reviewed; answer from these when they cover the question):\n${notes.map((n) => `- ${n}`).join('\n')}`);
  }

  let text = parts.join('\n');
  if (text.length > MAX_GROUNDING_CHARS) text = `${text.slice(0, MAX_GROUNDING_CHARS - 1)}…`;
  return {
    text,
    audit: {
      plan: plan ? 1 : 0,
      supplementCount: supplementCount || 0,
      notes: notes?.length || 0,
      groundingChars: text.length,
    },
  };
}
