// The one precondition every windowed feature on HealthGoal shares.
//
// The score target, the pause and calm mode are all columns on HealthGoal, and
// HealthGoal is created by the intake wizard and by nothing else. The ledger is
// reachable without intake - it is behind a feature flag, not behind intake - so
// "no goal row" is an ordinary state for a real user to be in, and every write
// that touches one of those columns has to decide what to do about it.
//
// The decision differs by write, and the difference is the whole point of this
// file:
//
//   A WRITE THAT CREATES A WINDOW refuses, with a 409 and a code. Setting a
//   target or starting a pause on a user with no goal is not a server fault and
//   not a malformed request; it is the right request against a state that cannot
//   hold it yet, and the answer names the thing to do about it. Before this, the
//   refusal was a bare `new Error('No goal set')`, which `handle` maps to a 500 -
//   so the user got "Server error" for a condition the app could have explained
//   and routed around.
//
//   A WRITE THAT CLEARS OR SETS A FLAG does not refuse, it applies to whatever
//   rows exist. Clearing a target that is not there and clearing one that is have
//   the same outcome, so a clear must be idempotent; `healthGoal.update()` is
//   not idempotent, it throws Prisma P2025 on a missing row, and that error was
//   reaching the client as a 500 whose body was the Prisma invocation dump -
//   table and column names included. `updateMany` returns a count of zero
//   instead of throwing, which is the primitive this situation actually wants.
//
// The status is 409 rather than 404 deliberately. The row is a precondition on
// the write, not the thing being addressed, and 404 would tell a client looking
// for a goal that the goal does not exist - which is true, and not what anyone
// asking to set a pause needs to hear.

/** The client's code for "finish intake first". Stable; branch on this, not the message. */
export const NO_GOAL_CODE = 'NO_GOAL';

const MESSAGE =
  'Finish your health setup first - the score, your pause and your target all ' +
  'live on your goal, which is created by the setup questions.';

/**
 * The error a window-creating write throws when there is no goal row.
 *
 * Carries `status` and `code` because `handle` in ledgerController reads both, and
 * a plain Error reaches the client as an opaque 500 - which is how this shipped.
 * A named class rather than a bare object so `instanceof` is available to a
 * caller that would rather catch than check a property.
 */
export class NoGoalError extends Error {
  constructor() {
    super(MESSAGE);
    this.name = 'NoGoalError';
    // A literal, like the 400s and 404s the rest of this controller sets, rather
    // than a shared constants module that does not exist and would be the only
    // thing in the ledger using one.
    this.status = 409;
    this.code = NO_GOAL_CODE;
    // `err.error` wins over `err.message` in the controller's response body, so it
    // is set too rather than left undefined.
    this.error = MESSAGE;
  }
}

/**
 * Refuse unless a goal row exists.
 *
 * Takes the row rather than the prisma client so the caller keeps ownership of
 * the query and this stays a pure guard with nothing to mock - a test can hand it
 * `null` and assert the throw without a database.
 *
 * @param {object|null} goal - the HealthGoal row, or null
 * @throws {NoGoalError} when there is no row
 */
export function assertGoal(goal) {
  if (!goal) throw new NoGoalError();
  return goal;
}
