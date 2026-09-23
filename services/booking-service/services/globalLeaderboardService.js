// Platform-wide leaderboard: every user who hasn't opted out, ranked by the
// same composite 0-100 score (presence 70 / steps 20 / recent-week 10) as the
// per-gym board.
//
// Population = anyone with a member check-in at ANY gym in the window plus
// anyone with an attendance event in the window, plus the requester always.
// Attendance events are NOT gym-scoped here, so presence in any gym counts --
// and the per-day best-trust de-dupe in computeScores means multiple gyms the
// same day still pay once. Users who never attend anywhere aren't ranked
// globally (same contract as the per-gym board only listing that gym's
// check-ins); a steps-only user with zero presence stays off the board.
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';
import { scoreWindow, computeScores, windowDaysFor } from './attendanceScoreService.js';

const prisma = new PrismaClient();

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
const CHALLENGE_SERVICE_URL = process.env.CHALLENGE_SERVICE_URL || 'http://challenge-service:5008';
const HEALTH_SERVICE_URL = process.env.HEALTH_SERVICE_URL || 'http://health-service:5009';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

const GLOBAL_LEADERBOARD_TOP_N = 50;
const CRITERIA = ['attendance', 'steps', 'recent'];

async function internalHeadersFor(targetUrl) {
  return { headers: { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(targetUrl)) } };
}

// Best-effort across-gyms attendance events in [fromUtc, now]. Missing gymId
// param = all gyms. A down challenge-service silently yields [].
async function fetchAllGymAttendanceEvents(fromUtc) {
  try {
    const res = await axios.get(`${CHALLENGE_SERVICE_URL}/internal/attendance-events`, {
      params: { from: fromUtc.toISOString() },
      ...(await internalHeadersFor(CHALLENGE_SERVICE_URL)),
    });
    return res.data?.data ?? [];
  } catch (_) {
    return [];
  }
}

async function fetchDailyActivityRows(userIds, fromKey, toKey) {
  if (userIds.length === 0) return [];
  try {
    const res = await axios.get(`${HEALTH_SERVICE_URL}/internal/daily-activity`, {
      params: { ids: userIds.join(','), from: fromKey, to: toKey },
      ...(await internalHeadersFor(HEALTH_SERVICE_URL)),
    });
    return res.data?.data ?? [];
  } catch (_) {
    return [];
  }
}

export async function getGlobalLeaderboard(window, requestingCustomerId) {
  const validWindow = ['weekly', 'monthly', 'all'].includes(window) ? window : 'all';
  const { startKey, startUtc } = scoreWindow(new Date(), validWindow);
  const todayKey = new Date(Date.now() + (5 * 60 + 30) * 60000).toISOString().split('T')[0];

  // Distinct check-in days across every gym in the window -- the global
  // "member presence days" stat and the board's candidate population. One row
  // per (customerId, date) regardless of gym, so 2 gyms the same day = 1 day.
  let memberDays = [];
  try {
    memberDays = await prisma.memberAttendance.findMany({
      where: { date: { gte: startKey } },
      select: { customerId: true },
      distinct: ['customerId', 'date'],
    });
  } catch (_) {
    memberDays = [];
  }
  const memberCustomerIds = [...new Set(memberDays.map((r) => r.customerId))];

  // Attendance events across all gyms in the window widen the population to
  // anyone who attended (e.g. via a booking) without a member check-in row.
  const eventRows = await fetchAllGymAttendanceEvents(startUtc);
  const eventUserIds = [...new Set(eventRows.map((e) => e.userId))];

  // Always include the requester even with no attendance, so "where would I
  // rank" works before their first visit anywhere.
  const candidateIds = [...new Set([...memberCustomerIds, ...eventUserIds, requestingCustomerId])];

  let userById = {};
  try {
    const res = await axios.post(
      `${AUTH_SERVICE_URL}/internal/users/batch`,
      { ids: candidateIds },
      await internalHeadersFor(AUTH_SERVICE_URL),
    );
    const users = res.data?.data || [];
    userById = Object.fromEntries(users.map((u) => [u.id, u]));
  } catch (_) {
    // Opt-in can't be verified -- safer to show nobody than to guess.
    return {
      window: validWindow,
      entries: [],
      me: { rank: null, checkIns: 0, score: 0, optedIn: false },
    };
  }

  const activityRows = await fetchDailyActivityRows(candidateIds, startKey, todayKey);
  const scores = computeScores({
    attendanceEvents: eventRows,
    dailyActivityRows: activityRows,
    userIds: candidateIds,
    window: validWindow,
  });

  // Same-rank population as the per-gym board: opted-in members only.
  const checkInsByCustomer = {};
  for (const r of memberDays) {
    checkInsByCustomer[r.customerId] = (checkInsByCustomer[r.customerId] ?? 0) + 1;
  }

  const ranked = candidateIds
    .filter((id) => userById[id]?.leaderboardOptIn === true)
    .map((id) => {
      const s = scores[id] ?? { score: 0, attendance: 0, steps: 0, recent: 0 };
      return {
        customerId: id,
        checkIns: checkInsByCustomer[id] ?? 0,
        score: s.score,
        attendanceScore: s.attendance,
        stepsScore: s.steps,
        recentScore: s.recent,
      };
    })
    .sort((a, b) => b.score - a.score || b.checkIns - a.checkIns)
    .map((r, i) => ({
      rank: i + 1,
      customerId: r.customerId,
      name: userById[r.customerId]?.name || 'Anonymous',
      photoUrl: userById[r.customerId]?.profileImageUrl || null,
      checkIns: r.checkIns,
      score: r.score,
      attendanceScore: r.attendanceScore,
      stepsScore: r.stepsScore,
      recentScore: r.recentScore,
    }));

  const myScores = scores[requestingCustomerId] ?? { score: 0, attendance: 0, steps: 0, recent: 0 };
  const myCheckIns = checkInsByCustomer[requestingCustomerId] ?? 0;
  const strictlyAbove = ranked.filter(
    (r) => r.score > myScores.score || (r.score === myScores.score && r.checkIns > myCheckIns),
  ).length;
  const myListedRank = ranked.findIndex((r) => r.customerId === requestingCustomerId) + 1;
  const myRank = myListedRank || strictlyAbove + 1;

  const meRanks = {};
  for (const key of CRITERIA) {
    const keyScore = `${key}Score`;
    const myCriterionScore = myScores[key];
    const byCriterion = [...ranked].sort(
      (a, b) => b[keyScore] - a[keyScore] || b.checkIns - a.checkIns,
    );
    const myIndex = byCriterion.findIndex((r) => r.customerId === requestingCustomerId) + 1;
    const strictlyAbove = byCriterion.filter(
      (r) => r[keyScore] > myCriterionScore || (r[keyScore] === myCriterionScore && r.checkIns > myCheckIns),
    ).length;
    meRanks[key] = { rank: myIndex || strictlyAbove + 1, score: myCriterionScore };
  }

  return {
    window: validWindow,
    windowDays: windowDaysFor(validWindow),
    global: true,
    entries: ranked.slice(0, GLOBAL_LEADERBOARD_TOP_N),
    me: {
      rank: myRank,
      checkIns: myCheckIns,
      score: myScores.score,
      attendanceScore: myScores.attendance,
      stepsScore: myScores.steps,
      recentScore: myScores.recent,
      ranks: meRanks,
      optedIn: userById[requestingCustomerId]?.leaderboardOptIn === true,
    },
  };
}