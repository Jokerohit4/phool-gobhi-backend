// Pure maths for a company's programme dashboard. No I/O: the service gathers
// the data, this turns it into the numbers staff (and the aggregate HR report)
// show, so the rules can be unit-tested directly.
//
// A "participant" is a member who is linked to an account, has NOT opted out of
// leaderboards, and HAS given health-data consent. Only participants'
// activity is ever counted. Everyone else appears only as a count in the
// funnel.

import { ACTIVE_DAY_STEP_THRESHOLD } from './orgScoring.js';

// Teams smaller than this are never broken out in anything handed to a
// company: a "team" of one is just that person's own numbers.
export const MIN_GROUP_SIZE = 3;

const DAY_MS = 86400000;
const dayMs = (day) => Date.parse(`${day}T00:00:00Z`);
const toDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export function dayRange(startDay, endDay) {
  const out = [];
  for (let t = dayMs(startDay); t <= dayMs(endDay); t += DAY_MS) out.push(toDay(t));
  return out;
}

// Monday of the week a day falls in.
export function weekStartOf(day) {
  const dow = new Date(dayMs(day)).getUTCDay(); // 0 = Sunday
  return toDay(dayMs(day) - ((dow + 6) % 7) * DAY_MS);
}

export const DISTRIBUTION_BUCKETS = [
  { key: '0', label: '0 days', min: 0, max: 0 },
  { key: '1-2', label: '1-2 days', min: 1, max: 2 },
  { key: '3-5', label: '3-5 days', min: 3, max: 5 },
  { key: '6-10', label: '6-10 days', min: 6, max: 10 },
  { key: '11+', label: '11+ days', min: 11, max: Infinity },
];

const round1 = (n) => Math.round(n * 10) / 10;
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

// One participant's activity inside the window.
export function participantDays({ attendanceDays = [], workoutDays = [], stepsByDay = {}, startDay, endDay }) {
  const inWin = (d) => typeof d === 'string' && d >= startDay && d <= endDay;
  const attendance = new Set(attendanceDays.filter(inWin));
  const workouts = new Set(workoutDays.filter(inWin));
  const stepDays = new Set();
  let steps = 0;
  for (const [day, value] of Object.entries(stepsByDay)) {
    const n = Number(value);
    if (!inWin(day) || !Number.isFinite(n) || n <= 0) continue;
    steps += Math.round(n);
    if (n >= ACTIVE_DAY_STEP_THRESHOLD) stepDays.add(day);
  }
  return { active: new Set([...attendance, ...workouts, ...stepDays]), workouts, attendance, steps };
}

/**
 * @param participants [{ userId, teamId, active:Set, workouts:Set, attendance:Set, steps }]
 * @param counts       { added, invited, joined, optedOut, pendingConsent }
 * @param teams        [{ id, name, added }]   (added = everyone on the team, any status)
 * @param window       { startDay, endDay }
 */
export function computeDashboardStats({ participants, counts, teams, window }) {
  const { startDay, endDay } = window;
  const days = dayRange(startDay, endDay);
  const last7Start = days.length > 7 ? days[days.length - 7] : startDay;
  const n = participants.length;

  const activeDaysOf = (p) => p.active.size;
  const everActive = participants.filter((p) => activeDaysOf(p) > 0);
  const active7 = participants.filter((p) => [...p.active].some((d) => d >= last7Start));

  // Daily: distinct participants active that day.
  const perDay = new Map(days.map((d) => [d, 0]));
  for (const p of participants) for (const d of p.active) if (perDay.has(d)) perDay.set(d, perDay.get(d) + 1);
  const daily = days.map((day) => ({ day, activeMembers: perDay.get(day) }));

  // Weekly: distinct participants active at any point in that week.
  const weekly = [];
  const weeks = [...new Set(days.map(weekStartOf))];
  for (const weekStart of weeks) {
    const ids = new Set();
    for (const p of participants) for (const d of p.active) if (weekStartOf(d) === weekStart) ids.add(p.userId);
    weekly.push({ weekStart, activeMembers: ids.size });
  }

  const distribution = DISTRIBUTION_BUCKETS.map((b) => ({
    key: b.key, label: b.label,
    members: participants.filter((p) => activeDaysOf(p) >= b.min && activeDaysOf(p) <= b.max).length,
  }));

  const totalActiveDays = participants.reduce((s, p) => s + activeDaysOf(p), 0);
  const totals = {
    activeDays: totalActiveDays,
    workoutDays: participants.reduce((s, p) => s + p.workouts.size, 0),
    checkinDays: participants.reduce((s, p) => s + p.attendance.size, 0),
    steps: participants.reduce((s, p) => s + p.steps, 0),
  };

  const teamRows = teams.map((t) => {
    const members = participants.filter((p) => p.teamId === t.id);
    const active = members.filter((p) => activeDaysOf(p) > 0);
    return {
      teamId: t.id, name: t.name, members: t.added, participants: members.length,
      activeParticipants: active.length,
      avgActiveDays: members.length ? round1(members.reduce((s, p) => s + activeDaysOf(p), 0) / members.length) : 0,
      participationRate: pct(active.length, members.length),
      // true when this row is too small to hand to a company
      small: members.length < MIN_GROUP_SIZE,
    };
  }).sort((a, b) => b.avgActiveDays - a.avgActiveDays || a.name.localeCompare(b.name));

  return {
    window: { startDay, endDay, days: days.length },
    funnel: [
      { key: 'added', label: 'Added by staff', value: counts.added },
      { key: 'joined', label: 'Signed in to the app', value: counts.joined },
      { key: 'consented', label: 'Agreed to share health data', value: n },
      { key: 'active', label: 'Active in this period', value: everActive.length },
    ],
    counts: { ...counts, participants: n },
    rates: {
      joined: pct(counts.joined, counts.added),
      consented: pct(n, counts.joined - counts.optedOut),
      active: pct(everActive.length, n),
      activeLast7Days: pct(active7.length, n),
    },
    activeLast7Days: active7.length,
    activeInPeriod: everActive.length,
    avgActiveDays: n ? round1(totalActiveDays / n) : 0,
    totals,
    daily,
    weekly,
    distribution,
    teams: teamRows,
  };
}
