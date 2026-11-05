import axios from 'axios';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';

const HEALTH_SERVICE_URL = process.env.HEALTH_SERVICE_URL || 'http://health-service:5009';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

// Each person's 7-day average health score (0-100), from the same health-service
// batch the consistency league reads, so the number on a swipe card is the one
// in the league and on their own Health Score card. Best effort: a slow or
// failed lookup just means no score is shown, it never fails a deck. A user
// with no scored days averages 0, which is "no data", not a score, so it is
// left out.
export async function getWeeklyHealthScores(userIds) {
  if (!userIds.length) return new Map();
  try {
    const res = await axios.post(
      `${HEALTH_SERVICE_URL}/internal/ledger/biometrics/batch-consistency`,
      { userIds },
      {
        headers: { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(HEALTH_SERVICE_URL)) },
        timeout: 2000,
      },
    );
    const scores = new Map();
    for (const row of res.data?.data ?? []) {
      const score = Number(row.avgScore);
      if (Number.isFinite(score) && score > 0) scores.set(row.userId, Math.round(score));
    }
    return scores;
  } catch (err) {
    console.error('getWeeklyHealthScores failed:', err.response?.status || err.message);
    return new Map();
  }
}
