import * as consistencyStreakService from '../services/consistencyStreakService.js';

// GET /api/health/consistency-streak
//
// The home-track streak: derived from the user's own logged sessions, pays
// nothing. See consistencyStreakService for why it is separate from
// challenge-service's coin-bearing streak.
//
// Never 404s — a user with no sessions is a valid state and returns zeroes,
// so the home screen renders without branching on "has any history yet".
export const getConsistencyStreak = async (req, res) => {
  try {
    const weeksToShow = req.query.weeks ? parseInt(req.query.weeks, 10) : undefined;
    if (weeksToShow !== undefined && (!Number.isInteger(weeksToShow) || weeksToShow < 1 || weeksToShow > 52)) {
      return res.status(400).json({ error: 'weeks must be an integer between 1 and 52' });
    }

    const streak = await consistencyStreakService.getConsistencyStreakService(
      req.userId,
      weeksToShow ? { weeksToShow } : {},
    );
    res.json({ data: streak });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
