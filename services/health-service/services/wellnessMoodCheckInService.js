import { hourIST, isoDayIST } from '../utils/sessionDay.js';
import { isIsoDay } from './ledger/isoDay.js';

const MOODS = new Set([
  'Good', 'Calm', 'Okay', 'Tired', 'Stressed', 'Low', 'Anxious', 'Frustrated',
]);
const FACTORS = new Set([
  'Sleep', 'Work or studies', 'Relationships', 'Health or pain',
  'Food or digestion', 'Money', 'Not sure', 'Something else',
]);
const SUPPORT = new Set([
  'Just listen', 'Help me sort my thoughts', 'Suggest a small next step',
  'Help me feel calmer', 'Ask me a question',
]);

function problem(status, error, code) {
  return { status, error, code };
}

function istParts(now = new Date()) {
  return { day: isoDayIST(now), hour: hourIST(now) };
}

function validateInput({ localDate, slot, mood, factors, support, note }) {
  if (!isIsoDay(localDate)) {
    throw problem(400, 'localDate must be a real YYYY-MM-DD date', 'INVALID_DATE');
  }
  if (!['morning', 'night'].includes(slot)) {
    throw problem(400, 'slot must be morning or night', 'INVALID_MOOD_SLOT');
  }
  if (!MOODS.has(mood)) {
    throw problem(400, 'Choose a mood from the available options.', 'INVALID_MOOD');
  }
  if (!Array.isArray(factors) || factors.length > FACTORS.size ||
      factors.some((factor) => !FACTORS.has(factor)) ||
      new Set(factors).size !== factors.length) {
    throw problem(400, 'One or more check-in factors are invalid.', 'INVALID_MOOD_FACTORS');
  }
  if (support != null && !SUPPORT.has(support)) {
    throw problem(400, 'Choose a support option from the available list.', 'INVALID_MOOD_SUPPORT');
  }
  if (typeof note !== 'string' || note.trim().length === 0 || note.length > 500) {
    throw problem(400, 'Add a note of up to 500 characters to complete your check-in.', 'INVALID_MOOD_NOTE');
  }
}

export async function listMoodCheckIns(prisma, { userId, localDate } = {}) {
  if (!isIsoDay(localDate)) {
    throw problem(400, 'localDate must be a real YYYY-MM-DD date', 'INVALID_DATE');
  }
  return prisma.wellnessMoodCheckIn.findMany({
    where: { userId, localDate },
    orderBy: { createdAt: 'asc' },
  });
}

export async function createMoodCheckIn(prisma, { userId, ...input } = {}) {
  const data = {
    localDate: input.localDate,
    slot: input.slot,
    mood: input.mood,
    factors: input.factors,
    support: input.support ?? null,
    note: input.note,
  };
  validateInput(data);

  const { day, hour } = istParts();
  // One night window starts at 18:00 and ends at 05:00 the next day.
  // Accept the calendar date from older clients, but store its evening date.
  const nightStart = hour < 5
    ? new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
    : day;
  const slotDate = data.slot === 'night' ? nightStart : day;
  if (data.localDate !== day && data.localDate !== slotDate) {
    throw problem(409, 'Check-ins can only be saved for today.', 'MOOD_CHECKIN_DATE_CLOSED');
  }
  const slotOpen = data.slot === 'morning'
    ? hour >= 5 && hour < 12
    : hour >= 18 || hour < 5;
  if (!slotOpen) {
    throw problem(409, 'This check-in window has closed.', 'CHECKIN_WINDOW_CLOSED');
  }

  data.localDate = slotDate;
  try {
    return await prisma.wellnessMoodCheckIn.create({
      data: {
        userId: Number(userId),
        ...data,
        note: data.note.trim(),
      },
    });
  } catch (error) {
    if (error?.code === 'P2002') {
      throw problem(409, 'This check-in has already been logged.', 'CHECKIN_ALREADY_LOGGED');
    }
    throw error;
  }
}
