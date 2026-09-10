import * as goalService from '../services/goalService.js';

export const getGoal = async (req, res) => {
  try {
    const state = await goalService.getGoalStateService(req.userId);
    res.json({ data: state });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Returns the full state, not just the saved number, so the ring re-renders
// from one response instead of the client saving and then re-fetching to
// find out where it now stands.
export const updateGoal = async (req, res) => {
  try {
    await goalService.setGoalService(req.userId, req.body?.sessionsPerWeek);
    const state = await goalService.getGoalStateService(req.userId);
    res.json({ data: state });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
