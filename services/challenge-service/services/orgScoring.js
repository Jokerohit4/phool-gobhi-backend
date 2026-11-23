// Pure scoring + ranking for corporate-wellness leaderboards.
//
// Everything here works from a phone alone (no wearable): gym check-ins,
// finished workouts, and phone-sensor steps. Consistency counts, not
// performance, so a beginner who shows up beats a fit person who goes twice.

export const ACTIVE_DAY_STEP_THRESHOLD = 3000;

function inWindow(day, startDay, endDay) {
  return typeof day === 'string' && day >= startDay && day <= endDay;
}

export function scoreMember({ scoring, attendanceDays = [], workoutDays = [], stepsByDay = {}, startDay, endDay }) {
  const attendance = new Set(attendanceDays.filter((d) => inWindow(d, startDay, endDay)));
  const workouts = new Set(workoutDays.filter((d) => inWindow(d, startDay, endDay)));
  let steps = 0;
  const stepDays = new Set();
  for (const [day, value] of Object.entries(stepsByDay)) {
    const n = Number(value);
    if (!inWindow(day, startDay, endDay) || !Number.isFinite(n) || n <= 0) continue;
    steps += Math.round(n);
    if (n >= ACTIVE_DAY_STEP_THRESHOLD) stepDays.add(day);
  }
  const active = new Set([...attendance, ...workouts, ...stepDays]);
  const score = scoring === 'steps' ? steps
    : scoring === 'workout_days' ? workouts.size
    : active.size;
  return { score, activeDays: active.size, workoutDays: workouts.size, steps };
}

// Colleagues see each other by full name, and nothing else about them: no
// photo, no phone, no email. (Members are told this before they agree to enter.)
export function displayNameFor(name, isMe) {
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) return isMe ? 'You' : 'Member';
  return clean;
}

// Standard competition ranking on score alone (1, 2, 2, 4): equal scores share
// a rank. Order inside a tie uses active days, then steps, then user id so the
// list is stable between reads.
export function rankMembers(rows) {
  const sorted = [...rows].sort((a, b) =>
    b.score - a.score || b.activeDays - a.activeDays || b.steps - a.steps || a.userId - b.userId);
  let rank = 0;
  return sorted.map((row, i) => {
    if (i === 0 || row.score !== sorted[i - 1].score) rank = i + 1;
    return { ...row, rank };
  });
}

// A team's score is the AVERAGE of its ranked members, so a bigger team does
// not win just by being bigger.
export function rankTeams(rows) {
  const byTeam = new Map();
  for (const row of rows) {
    if (row.teamId == null) continue;
    const t = byTeam.get(row.teamId) ?? { teamId: row.teamId, name: row.teamName, members: 0, total: 0 };
    t.members += 1;
    t.total += row.score;
    byTeam.set(row.teamId, t);
  }
  const teams = [...byTeam.values()].map((t) => ({
    teamId: t.teamId, name: t.name, members: t.members,
    score: Math.round((t.total / t.members) * 10) / 10,
  }));
  teams.sort((a, b) => b.score - a.score || b.members - a.members || a.teamId - b.teamId);
  let rank = 0;
  return teams.map((t, i) => {
    if (i === 0 || t.score !== teams[i - 1].score) rank = i + 1;
    return { ...t, rank };
  });
}
