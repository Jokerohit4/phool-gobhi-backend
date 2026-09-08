import * as suggestionFeedbackService from '../services/suggestionFeedbackService.js';

const VOTES = ['up', 'down', 'skip', 'done'];

export const recordImpression = async (req, res) => {
  try {
    const { suggestionKey, reasoning } = req.body || {};
    if (!suggestionKey) {
      return res.status(400).json({ error: 'suggestionKey is required' });
    }
    const impression = await suggestionFeedbackService.recordImpressionService(req.userId, {
      suggestionKey,
      reasoning,
    });
    res.status(201).json({ data: impression });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const recordVote = async (req, res) => {
  try {
    const { vote } = req.body || {};
    if (!VOTES.includes(vote)) {
      return res.status(400).json({ error: `vote must be one of: ${VOTES.join(', ')}` });
    }
    const updated = await suggestionFeedbackService.recordVoteService(
      req.userId,
      parseInt(req.params.id),
      vote,
    );
    res.json({ data: updated });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getFeedbackStats = async (req, res) => {
  try {
    const stats = await suggestionFeedbackService.getFeedbackStatsService();
    res.json({ data: stats });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
