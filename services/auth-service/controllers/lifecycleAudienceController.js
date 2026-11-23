import prisma from '../db/prisma.js';

const MAX_PAGE = 250;
const MAX_AGE_DAYS = 120;

// Internal (requireInternal): recently created customers, for health-service's
// lifecycle-nudge sweep (new-user re-engagement). Paged by id.
//
// Deliberately narrow and token-free: the sweep needs to know WHETHER a user
// can receive a push (`hasToken`) so it can count the ones it cannot reach,
// but the token itself never leaves auth-service from here (notifyUser
// fetches it per send, like every other nudge).
//
// "Onboarding complete" has no server-side column. The customer app's
// `onboarding_completed` is a client analytics event only, so this derives it
// from what the wizard writes: the "do you work out?" answer
// (`currentlyWorksOut`, null = never asked) or finished wellness setup.
// Users who finished through the resume path write the same fields, so they
// count. This is a proxy, and an approximate one; see the final notes in
// nudgeService.
export async function getLifecycleCandidates(req, res) {
  try {
    const { after = 0, limit = MAX_PAGE, createdBefore, maxAgeDays = 90 } = req.body ?? {};
    if (!Number.isInteger(after) || after < 0 ||
        !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE ||
        !Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > MAX_AGE_DAYS) {
      return res.status(400).json({ error: 'Invalid page' });
    }
    const before = createdBefore ? new Date(createdBefore) : new Date();
    if (Number.isNaN(before.getTime())) return res.status(400).json({ error: 'Invalid createdBefore' });
    const since = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

    const users = await prisma.user.findMany({
      where: {
        role: 'customer',
        isActive: true,
        archivedAt: null,
        id: { gt: after },
        createdAt: { gte: since, lte: before },
      },
      select: {
        id: true,
        createdAt: true,
        fcmToken: true,
        currentlyWorksOut: true,
        wellnessSetupCompleted: true,
        freeTimeWindow: true,
        persona: true,
        appMode: true,
        workoutIntent: true,
        wellnessFocuses: true,
      },
      orderBy: { id: 'asc' },
      take: limit,
    });

    res.json({
      data: users.map((u) => ({
        id: u.id,
        createdAt: u.createdAt,
        hasToken: Boolean(u.fcmToken),
        onboardingComplete: u.currentlyWorksOut !== null && u.currentlyWorksOut !== undefined
          ? true
          : u.wellnessSetupCompleted === true,
        freeTimeWindow: u.freeTimeWindow || null,
        persona: u.persona || null,
        appMode: u.appMode || null,
        workoutIntent: u.workoutIntent || null,
        wellnessFocuses: u.wellnessFocuses || [],
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
