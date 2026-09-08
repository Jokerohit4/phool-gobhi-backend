import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// FR-15. Two halves that must not drift apart: an impression row is written
// every time a suggestion is SHOWN (vote null), and the vote lands on that
// same row later. Recording only votes would leave GS-5 (suggestion uptake)
// with no denominator, and would make the eventual rules-vs-model comparison
// unmeasurable.
export async function recordImpressionService(userId, { suggestionKey, reasoning }) {
  return prisma.suggestionFeedback.create({
    data: { userId, suggestionKey, reasoning: reasoning ?? null },
  });
}

// Votes are idempotent-ish by design: re-voting on the same impression
// overwrites (a user flipping 👍 to 👎 is a correction, not a second data
// point). Ownership is checked here rather than trusted from the client,
// since the id travels through the app.
export async function recordVoteService(userId, feedbackId, vote) {
  const existing = await prisma.suggestionFeedback.findUnique({ where: { id: feedbackId } });
  if (!existing || existing.userId !== userId) {
    const err = new Error('Suggestion not found');
    err.status = 404;
    throw err;
  }
  return prisma.suggestionFeedback.update({
    where: { id: feedbackId },
    data: { vote, votedAt: new Date() },
  });
}

// Powers the admin-side read on whether suggestions are landing at all
// (aggregate only — see adminController's customer-only visibility note).
export async function getFeedbackStatsService() {
  const [shown, byVote] = await Promise.all([
    prisma.suggestionFeedback.count(),
    prisma.suggestionFeedback.groupBy({ by: ['vote'], _count: { _all: true } }),
  ]);
  const votes = {};
  for (const row of byVote) {
    if (row.vote) votes[row.vote] = row._count._all;
  }
  const voted = Object.values(votes).reduce((a, b) => a + b, 0);
  return {
    shown,
    voted,
    // GS-5's actual metric: of everything we showed, what fraction got any
    // reaction at all.
    actionRate: shown > 0 ? Math.round((voted / shown) * 1000) / 10 : 0,
    votes,
  };
}
