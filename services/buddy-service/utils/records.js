// Which personal record is someone's best. Records on different lifts, in
// different units and rep counts can only be compared through an estimated
// one-rep max, so that is what is ranked. The same rule as the app's
// BuddyPersonalRecord.best, so a profile shows the same "featured" record in
// the deck and on its own page.

const LB_TO_KG = 0.45359237;

// Epley, in kg. Reps are capped at 30, past which the estimate means nothing
// and a very long set would otherwise win.
export function estimatedOneRepMaxKg({ weight, unit, reps }) {
  return (unit === 'lb' ? weight * LB_TO_KG : weight) * (1 + Math.min(reps, 30) / 30);
}

// The `n` strongest, best first; equal records keep the order they came in.
export function topRecords(records, n) {
  return records
    .map((record, index) => ({ record, index, e1rm: estimatedOneRepMaxKg(record) }))
    .sort((a, b) => b.e1rm - a.e1rm || a.index - b.index)
    .slice(0, n)
    .map((entry) => entry.record);
}

// The strongest of `records`; the first of equals, so callers that pass them
// newest-first get the newest on a tie. null for none.
export function pickBestRecord(records) {
  let best = null;
  for (const record of records) {
    if (!best || estimatedOneRepMaxKg(record) > estimatedOneRepMaxKg(best)) best = record;
  }
  return best;
}
