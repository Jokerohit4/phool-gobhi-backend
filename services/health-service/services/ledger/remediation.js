/**
 * Turning a plan into "here is what is still open today".
 *
 * The score said what happened and stopped there. A number that cost fifteen
 * points is a record, not a task, and there was nothing in between: the user
 * could see what the day cost them and had no route from that number to the one
 * thing that would have changed it.
 *
 * The first attempt at this module was written backwards, mapping each miss to
 * an action, and it was wrong. `computeMisses` only runs for a **closed** day -
 * an open day is deliberately charged nothing, because a user reading "-15
 * planned workout missed" over their breakfast has not yet had the chance to do
 * the workout. So every miss that exists belongs to a frozen day, and a frozen
 * day is never recomputed. Mapping misses to actions therefore produced an
 * action list attached to days where nothing the user does could ever work.
 *
 * So this reads the *plan* instead. What is scheduled for today and not yet
 * done is a genuine opportunity, not an accusation, and it is the one question
 * the score was leaving unanswered: not "why did I lose points" but "what can I
 * still do".
 *
 * Two rules follow from that, and both are load-bearing:
 *
 * 1. **No points are shown.** Not the cost, not an estimate of the reward. A
 *    number next to a plan item turns the screen into a scoreboard, and the
 *    person is not being graded - they are being handed a list. It also would
 *    not survive contact with the daily caps: a day can be capped at +60, so a
 *    "+15" promise is not a number this service can keep.
 *
 * 2. **A future appointment is not an open item.** Not because of anything this
 *    module checks: an appointment carries its date in its schedule, so a
 *    future one is simply not due today and the schedule predicate removes it
 *    before it arrives here. The engine's own `isFutureAppointment` is a
 *    hardcoded `false` for the same reason. Reimplementing that filter with an
 *    invented field would be worse than useless - it would be a check against
 *    a column that does not exist, which passes every test and never fires.
 *
 * Related: the eating-disorder guard. Nothing here mentions intake, targets or
 * shortfall, and `CALORIES_LOW_COPY` exists only to carry the one line that
 * reports a low-intake day, which the safety card owns. This module never
 * suggests eating and never states a gap. See `lowCopyIsSafe` and its test,
 * which asserts the absence of the phrasings that would turn a report into a
 * prompt.
 */

/** Kinds that count as a real, doable thing today. */
const ACTIONABLE_KINDS = new Set([
  'workout',
  'habit',
  'doctor_medication',
  'doctor_test',
  'doctor_appointment',
]);

/**
 * The copy for a plan kind, and how urgent it is.
 *
 * `rank` orders the list, and it is the only ordering that matters: the first
 * item is what the screen leads with, so it is the thing most worth doing rather
 * than the first thing in the database. A medication outranks a workout because
 * a skipped prescription does not wait for a convenient evening, and this is not
 * a judgement about the person - it is about what a missed dose actually costs.
 */
const BY_KIND = {
  doctor_medication: { rank: 0, action: 'Take this and tick it off' },
  doctor_test: { rank: 1, action: 'Do this and tick it off' },
  doctor_appointment: { rank: 2, action: 'Go, or move it to another day' },
  workout: { rank: 3, action: 'Train, then tick it off' },
  habit: { rank: 4, action: 'Do this, then tick it off' },
};

/**
 * The line the app shows for a day whose logged intake is well under usual.
 *
 * This is the only place in the ledger where a number about food is turned into
 * a sentence, and it is a report rather than a prompt on purpose. It is defined
 * here, next to the rule that it must stay that way, rather than in the copy
 * file where it would be edited as ordinary marketing text.
 */
export const CALORIES_LOW_COPY =
  'Your logged intake is well under your usual. Nothing needs fixing here.';

/** Phrasings that would turn the low-side report into pressure to eat. */
const FORBIDDEN_IN_LOW_COPY = [
  'eat more',
  'add more',
  'increase',
  'reach your target',
  'short by',
  'missing',
  'behind',
  'you need',
];

/** A plan item is open when it is scheduled for `localDate` and not completed. */
function isOpen(item, { doneIds }) {
  if (!item || item.active === false) return false;
  // A row with nothing in it is a dead row. The screen renders the item's own
  // title, so an untitled item would render as a blank line with a button
  // beside it - which is worse than omitting it, because the button looks
  // tappable and does nothing meaningful. Dropped here rather than rendered
  // with a placeholder, since a placeholder title is a lie about the plan.
  if (typeof item.title !== 'string' || item.title.trim() === '') return false;
  if (doneIds.has(item.id)) return false;
  return true;
}

/**
 * Everything still open on `localDate`, most worth doing first.
 *
 * `isScheduledFor` and `isDueOn` are injected rather than imported so the
 * ordering, filtering and shaping can be tested without a database, and so this
 * module has no dependency on the plan service's internals beyond the two
 * predicates it is handed. Both default to the engine's own behaviour when not
 * supplied, so a caller that forgets one gets the real rule rather than a
 * silently-wrong one.
 *
 * `limit` exists for the same reason the score caps the lines it renders: a plan
 * with fourteen habits produces a list nobody acts on. Capping keeps the few
 * that rank highest, which are the ones the ordering already put there.
 */
export function openActions(
  { planItems = [], completions = [], localDate } = {},
  { isScheduledFor = null, limit = 4 } = {},
) {
  if (!localDate) return [];

  const doneIds = new Set(
    (completions || [])
      // A completion on a different day does not close today's item. Keyed on
      // the date rather than filtered out, so a user ticking yesterday's
      // workout mid-morning does not silently un-open today's.
      .filter((c) => !c.localDate || c.localDate === localDate)
      .map((c) => c.planItemId),
  );

  const out = [];
  for (const item of planItems || []) {
    const kind = item?.kind;
    if (!ACTIONABLE_KINDS.has(kind)) continue;

    // The schedule predicate is the engine's, so "scheduled for today" means
    // exactly what it means when the day is scored. Reimplementing it here
    // would let the two drift, and the drift would show up as an item the app
    // says to do on a day the engine never asked for it. Optional because the
    // caller normally passes items that are already filtered - `gatherDayInputs`
    // runs `isDueOn` - in which case there is nothing left to decide.
    if (isScheduledFor && !isScheduledFor(item, localDate)) continue;

    if (!isOpen(item, { doneIds })) continue;

    const { rank, action } = BY_KIND[kind];
    out.push({
      kind,
      rank,
      action,
      // The user's own words for the item, not ours. "Leg day" is more useful
      // than "your workout", and it is already written.
      label: item.title,
      itemId: item.id ?? null,
    });
  }

  return out
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit);
}

/**
 * True when the low-side copy has stayed a report.
 *
 * Exported for the test rather than inlined into it: the assertion is about a
 * property of the string, so the property belongs next to the string and a
 * future copy edit is checked against the rule it is editing.
 */
export function lowCopyIsSafe(copy = CALORIES_LOW_COPY) {
  const lowered = copy.toLowerCase();
  return !FORBIDDEN_IN_LOW_COPY.some((phrase) => lowered.includes(phrase));
}

export { ACTIONABLE_KINDS, BY_KIND };
