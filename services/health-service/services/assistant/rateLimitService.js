import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Two windows, because they stop different things. The hourly cap stops a
// single frustrated session from burning a day's budget; the daily cap stops
// slow steady abuse that never trips the hourly one.
export const MAX_PER_HOUR = 10;
export const MAX_PER_DAY = 40;

/// May this user send another message right now?
///
/// Modelled directly on nudgeService.canSendService: a log table read as a
/// rolling-window count. Postgres rather than an in-process counter for the
/// reason that service already documents — every service here runs with
/// min-instances=0, so an in-memory window is emptied by cold starts and is
/// not shared across instances. It would enforce nothing under exactly the
/// load that makes enforcement matter.
///
/// The gateway's express-rate-limit is no substitute: it is keyed by IP, not
/// by user, and is also in-memory.
export async function canSendMessageService(userId, now = new Date()) {
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [hourCount, dayCount] = await Promise.all([
    prisma.assistantRateLimitLog.count({ where: { userId, sentAt: { gte: hourAgo } } }),
    prisma.assistantRateLimitLog.count({ where: { userId, sentAt: { gte: dayAgo } } }),
  ]);

  if (hourCount >= MAX_PER_HOUR) {
    return { allowed: false, reason: 'hourly_cap', retryAfterSeconds: 3600 };
  }
  if (dayCount >= MAX_PER_DAY) {
    return { allowed: false, reason: 'daily_cap', retryAfterSeconds: 86400 };
  }
  return { allowed: true };
}

/// Recorded when a message is ACCEPTED, not when it succeeds.
///
/// The cost and abuse risk is in processing the message at all — a provider
/// call that errors has still been paid for. Counting only successes would let
/// a failing loop run free.
export async function recordMessageSentService(userId) {
  await prisma.assistantRateLimitLog.create({ data: { userId } });
}
