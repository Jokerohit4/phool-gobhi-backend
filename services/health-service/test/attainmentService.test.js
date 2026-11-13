import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAttainment,
  projectPace,
  getAttainment,
  ATTAINMENT_STATUS,
  REACHED_TOLERANCE_KG,
  STALE_WEIGHT_DAYS,
} from '../services/ledger/attainmentService.js';

// Every test here is about a way the answer could be wrong in the direction that
// flatters the user. The score is the leading indicator and is allowed to be
// encouraging; this is the outcome check, so the failure mode worth writing a
// test for is the one where it says "on track" when it cannot support that.

const TODAY = '2026-10-01';

/** Weigh-ins, ascending, as prisma returns them. */
const readings = (...pairs) => pairs.map(([localDate, kg]) => ({ localDate, kg }));

/** A losing goal: 80 kg now, aiming for 75 by the 1st of November. */
const lose = {
  targetWeightKg: 75,
  targetDate: '2026-11-01',
  today: TODAY,
};

test('no target means there is nothing to be at or short of', () => {
  const result = computeAttainment({ targetWeightKg: null, today: TODAY, readings: readings(['2026-09-25', 80]) });
  assert.equal(result.status, ATTAINMENT_STATUS.NO_TARGET);
  // The series is deliberately not reported here. A user with no target should not
  // have their weight handed back on a screen that has nothing to do with it.
  assert.equal(result.currentWeightKg, null);
  assert.equal(result.startWeightKg, null);
});

test('a target with no measurement says not measured, and does not use the score', () => {
  const result = computeAttainment({ ...lose, readings: [] });

  // The state the user asked for. There is no weight, so there is no comparison,
  // and the tempting shortcut - infer progress from the score - is precisely the
  // conflation this endpoint exists to prevent. Asserted on the shape rather than
  // on a comment: every field that would imply progress is null.
  assert.equal(result.status, ATTAINMENT_STATUS.NOT_MEASURED);
  assert.equal(result.currentWeightKg, null);
  assert.equal(result.gapKg, undefined, 'a gap with no weight on one side is not a gap');
  assert.equal(result.projectedTargetKg, undefined);
  assert.equal(result.actualWeeklyKg, undefined);
});

test('a target set with a full series of nothing still reads as not measured', () => {
  // The obvious implementation shortcut: an empty array is falsy somewhere and
  // the whole series gets treated as absent. Checked so a future refactor that
  // "simplifies" the guard cannot reintroduce it silently.
  const result = computeAttainment({ ...lose, readings: [] });
  assert.equal(result.status, ATTAINMENT_STATUS.NOT_MEASURED);
});

test('reached is reported when the target is met', () => {
  const result = computeAttainment({
    ...lose,
    readings: readings(['2026-09-01', 80], ['2026-09-15', 77], ['2026-10-01', 75]),
  });

  assert.equal(result.status, ATTAINMENT_STATUS.REACHED);
  assert.equal(result.currentWeightKg, 75);
  assert.equal(result.gapKg, 0);
});

test('reached tolerates being fractionally short, because scales are not precise', () => {
  // 0.3 kg short of a 75 kg target. Declaring this a miss would make a person's
  // success depend on the precision of their bathroom scale, and would flip the
  // card to red the morning after they arrived.
  const result = computeAttainment({
    ...lose,
    readings: readings(['2026-09-25', 75.3]),
  });

  assert.equal(result.status, ATTAINMENT_STATUS.REACHED);
  assert.equal(result.gapKg, -0.3);
});

test('reached tolerates a fractional overshoot too, so a bulk is not a failure', () => {
  // Gaining to 82.2 against a target of 82. The tolerance is symmetric on
  // purpose: an unsymmetric one makes a bulk harder to complete than a cut, which
  // is a real asymmetry nobody chose.
  const result = computeAttainment({
    targetWeightKg: 82,
    targetDate: '2026-11-01',
    today: TODAY,
    readings: readings(['2026-09-25', 82.2]),
  });

  assert.equal(result.status, ATTAINMENT_STATUS.REACHED);
});

test('short by more than the tolerance is not reached', () => {
  const result = computeAttainment({
    ...lose,
    readings: readings(['2026-09-25', 75 + REACHED_TOLERANCE_KG + 0.1]),
  });
  assert.equal(result.status, ATTAINMENT_STATUS.BEHIND_PACE);
});

test('a losing trend on pace reports on track', () => {
  // 80 on 1 Sept to 77 on 1 Oct is ~3 kg a month, comfortably ahead of the ~2.5
  // kg the 75-by-1-Nov target needs.
  const result = computeAttainment({
    ...lose,
    readings: readings(['2026-09-01', 80], ['2026-10-01', 77]),
  });

  assert.equal(result.status, ATTAINMENT_STATUS.ON_TRACK);
  assert.ok(result.actualWeeklyKg < 0, 'a losing trend is a negative rate');
  assert.ok(result.requiredWeeklyKg < 0, 'losing to a target also requires a negative rate');
  assert.equal(result.gapKg, -2);
});

test('a flat trend against a loss target is behind pace, not on track', () => {
  // The score could be excellent here - perfect logging, all the workouts, every
  // protein target hit - and the weight would not move. This is the exact case
  // that a score-led design reports as success, and it is the reason attainment is
  // a separate endpoint.
  const result = computeAttainment({
    ...lose,
    readings: readings(['2026-09-01', 80], ['2026-10-01', 80]),
  });

  assert.equal(result.status, ATTAINMENT_STATUS.BEHIND_PACE);
});

test('a moving trend in the wrong direction is behind pace', () => {
  const result = computeAttainment({
    ...lose,
    readings: readings(['2026-09-01', 80], ['2026-10-01', 82]),
  });
  assert.equal(result.status, ATTAINMENT_STATUS.BEHIND_PACE);
});

test('losing faster than required is on track, not behind', () => {
  // The trap this feature is easiest to fall into. 0.7 kg/week actual against
  // 0.45 required projects to 73.9 against a 75 target - 1.1 kg PAST it. A test
  // of the form "does the projection land within tolerance of the target" reports
  // that as behind pace, and it is exactly backwards: the user is ahead and
  // overshooting.
  const result = computeAttainment({
    ...lose,
    readings: readings(['2026-09-01', 80], ['2026-10-01', 77]),
  });

  assert.ok(result.actualWeeklyKg < result.requiredWeeklyKg, 'losing faster than required');
  assert.ok(result.projectedTargetKg < 75, 'the projection overshoots the target');
  assert.equal(
    result.status,
    ATTAINMENT_STATUS.ON_TRACK,
    'someone ahead of pace must never be told they are behind',
  );
});

test('gaining faster than required is on track, by the same reasoning', () => {
  // The mirror of the case above, checked because the direction test is an
  // if/else and an oversight in one branch is invisible from the other.
  const result = computeAttainment({
    targetWeightKg: 85,
    targetDate: '2026-12-01',
    today: TODAY,
    readings: readings(['2026-09-01', 78], ['2026-10-01', 82]),
  });

  assert.equal(result.status, ATTAINMENT_STATUS.ON_TRACK);
});

test('a slow gain is behind, and the overshoot rule does not rescue it', () => {
  // The mirror of the "losing faster than required" case, and the guard that the
  // overshoot rule has not simply made everything on track. Gaining 0.2 kg/week
  // toward a target 2 kg away and two months out projects to 82.5, well short of
  // 85 - so behind, in the correct direction for a gain.
  const result = computeAttainment({
    targetWeightKg: 85,
    targetDate: '2026-12-01',
    today: TODAY,
    readings: readings(['2026-09-01', 81], ['2026-09-15', 81.2], ['2026-10-01', 81.4]),
  });

  assert.ok(result.projectedTargetKg < 85, 'the projection falls short');
  assert.equal(result.status, ATTAINMENT_STATUS.BEHIND_PACE);
});

test('a gain that is ahead is on track even though it overshoots the target', () => {
  // Gaining fast projects well past the target. Under a naive "land within the
  // tolerance" test this reads as behind pace, which is backwards for exactly the
  // same reason it is backwards for a loss.
  const result = computeAttainment({
    targetWeightKg: 85,
    targetDate: '2026-12-01',
    today: TODAY,
    readings: readings(['2026-09-20', 80], ['2026-10-01', 82]),
  });

  assert.ok(result.projectedTargetKg > 85, 'the projection overshoots');
  assert.equal(result.status, ATTAINMENT_STATUS.ON_TRACK);
});

test('a projection that lands just short of the target is behind, not on track', () => {
  // 75.4 now, 74 by 1 Nov, down from 76 a month ago. The trend projects to 74.78,
  // which is 0.78 short of the target and therefore outside the half-kilo
  // tolerance. Nearly there is not there, and reporting it as on track would be
  // the optimistic-curve failure this file is built to avoid.
  const result = computeAttainment({
    targetWeightKg: 74,
    targetDate: '2026-11-01',
    today: TODAY,
    readings: readings(['2026-09-01', 76], ['2026-10-01', 75.4]),
  });

  assert.ok(result.projectedTargetKg > 74, 'the projection stops short');
  assert.ok(
    Math.abs(result.projectedTargetKg - 74) > REACHED_TOLERANCE_KG,
    'and by more than the tolerance',
  );
  assert.equal(result.status, ATTAINMENT_STATUS.BEHIND_PACE);
});

test('the required rate is reported next to the actual, so the claim is checkable', () => {
  // "On track" is a projection, and a projection the user cannot check is just an
  // assertion. Both rates come back so the screen can show the number that would
  // prove the verdict wrong.
  const result = computeAttainment({
    ...lose,
    readings: readings(['2026-09-01', 80], ['2026-09-15', 79], ['2026-10-01', 77.8]),
  });

  assert.ok(Number.isFinite(result.actualWeeklyKg));
  assert.ok(Number.isFinite(result.requiredWeeklyKg));
  assert.ok(result.daysLeft > 0);
});

test('a passed target date is reported with the gap, and is not a failure state', () => {
  const result = computeAttainment({
    targetWeightKg: 75,
    targetDate: '2026-09-20',
    today: TODAY,
    readings: readings(['2026-09-01', 80], ['2026-10-01', 78]),
  });

  assert.equal(result.status, ATTAINMENT_STATUS.DATE_PASSED);
  assert.equal(result.gapKg, -3);
  assert.equal(result.daysSinceTarget, 11);
  // The word itself. There is no FAILED status to reach for, and this asserts
  // the string cannot appear even if someone adds one later.
  assert.ok(
    !Object.values(ATTAINMENT_STATUS).some((s) => /fail/i.test(s)),
    'no attainment status may read as a failure',
  );
});

test('reached outranks a passed date', () => {
  // The user hit the target and then let the deadline lapse. They attained the
  // goal; reporting the date instead would be the app insisting on a deadline the
  // user's body does not consult.
  const result = computeAttainment({
    targetWeightKg: 75,
    targetDate: '2026-09-20',
    today: TODAY,
    readings: readings(['2026-09-25', 75]),
  });

  assert.equal(result.status, ATTAINMENT_STATUS.REACHED);
});

test('a target with no date is reached or not, and never claims a pace', () => {
  const result = computeAttainment({
    targetWeightKg: 75,
    targetDate: null,
    today: TODAY,
    readings: readings(['2026-09-01', 80], ['2026-10-01', 78]),
  });

  // No date means no pace, and inventing one would put a deadline in front of the
  // user that they never set. Not "behind pace" either, because there is no pace
  // to be behind - the word would import an accusation the data cannot support.
  assert.equal(result.status, ATTAINMENT_STATUS.NOT_REACHED);
  assert.equal(result.daysLeft, null);
  assert.equal(result.projectedTargetKg, null);
});

test('past a cut target is reached, not short of it', () => {
  // 3 kg under a 75 kg target is outside the tolerance band, so the naive
  // "is it within half a kilo" test calls this not-reached and the screen then
  // tells someone who has passed their goal that they are still short of it. They
  // are past it. The question left for them is whether to keep going, which is
  // not this service's to answer.
  const result = computeAttainment({
    targetWeightKg: 75,
    targetDate: '2026-11-01',
    today: TODAY,
    goals: ['lose_fat'],
    readings: readings(['2026-08-01', 82], ['2026-10-01', 72]),
  });

  assert.equal(result.status, ATTAINMENT_STATUS.REACHED);
  assert.equal(result.gapKg, 3);
});

test('past a bulk target is reached, by the same reasoning', () => {
  const result = computeAttainment({
    targetWeightKg: 80,
    targetDate: '2026-11-01',
    today: TODAY,
    goals: ['build_muscle'],
    readings: readings(['2026-08-01', 72], ['2026-10-01', 84]),
  });

  assert.equal(result.status, ATTAINMENT_STATUS.REACHED);
});

test('under a bulk target is not "past" it', () => {
  // The mirror of the case above, and the one that catches a sign error. Someone
  // bulking towards 80 who is at 78 has not passed it; the fact that they are
  // lighter than a cut target would be has no bearing on a bulk.
  const result = computeAttainment({
    targetWeightKg: 80,
    targetDate: '2026-11-01',
    today: TODAY,
    goals: ['build_muscle'],
    readings: readings(['2026-08-01', 75], ['2026-10-01', 78]),
  });

  assert.notEqual(result.status, ATTAINMENT_STATUS.REACHED);
});

test('a recomp goal gets no verdict from the scale alone', () => {
  // Recomp is the same weight with a different composition, so weight passing the
  // target says nothing about whether it was attained. The service has no
  // composition data and must not imply otherwise in either direction.
  const result = computeAttainment({
    targetWeightKg: 75,
    targetDate: '2026-11-01',
    today: TODAY,
    goals: ['recomp'],
    readings: readings(['2026-08-01', 80], ['2026-10-01', 71]),
  });

  assert.notEqual(result.status, ATTAINMENT_STATUS.REACHED);
});

test('a flat series gets no past-target verdict either', () => {
  // Crossing is the only evidence, and a user who has not moved has not supplied
  // any. Abstaining here is the honest answer, and it is a plain not-reached
  // rather than an invented certainty.
  const result = computeAttainment({
    targetWeightKg: 75,
    targetDate: null,
    today: TODAY,
    readings: readings(['2026-09-01', 80], ['2026-10-01', 80]),
  });

  assert.equal(result.status, ATTAINMENT_STATUS.NOT_REACHED);
});

test('gaining past a cut target is not having reached it', () => {
  // The sign error that a naive "is the current weight on the other side of the
  // target" test makes, and the cruellest version of it available: 80 -> 82
  // against a 75 kg target leaves the user on the same side of it, two kilos
  // further away. "Reached" here would congratulate someone for overshooting in
  // the wrong direction.
  const result = computeAttainment({
    targetWeightKg: 75,
    targetDate: '2026-11-01',
    today: TODAY,
    goals: ['lose_fat'],
    readings: readings(['2026-09-01', 80], ['2026-10-01', 82]),
  });

  assert.equal(result.status, ATTAINMENT_STATUS.BEHIND_PACE);
});

test('a single reading cannot establish that the target was passed', () => {
  // There is no other point to have crossed from, so a lone weigh-in 3 kg under
  // the target is a gap, not a crossing.
  const result = computeAttainment({
    targetWeightKg: 75,
    targetDate: '2026-11-01',
    today: TODAY,
    goals: ['lose_fat'],
    readings: readings(['2026-09-25', 72]),
  });

  assert.notEqual(result.status, ATTAINMENT_STATUS.REACHED);
});

test('a start already at the target makes any move past it a crossing', () => {
  // 75.2 is at the target to within the band, so from there to 71 is not a
  // near-miss on the way down - it is a pass through and out the other side. This
  // is the case that a guard refusing to count a start inside the band as
  // evidence would get wrong.
  const result = computeAttainment({
    targetWeightKg: 75,
    targetDate: '2026-11-01',
    today: TODAY,
    readings: readings(['2026-09-01', 75.2], ['2026-10-01', 71]),
  });

  assert.equal(result.status, ATTAINMENT_STATUS.REACHED);
});

test('a start inside the band moving back within it is plain reached', () => {
  // The same starting point, but a move that stays in the band. This is reached by
  // the tolerance route and must not depend on any crossing argument.
  const result = computeAttainment({
    targetWeightKg: 75,
    targetDate: '2026-11-01',
    today: TODAY,
    readings: readings(['2026-09-01', 74.6], ['2026-10-01', 75.3]),
  });

  assert.equal(result.status, ATTAINMENT_STATUS.REACHED);
});

test('a reading below the plausible body range is dropped', () => {
  // 3 kg is a typo, and letting it through would produce a confident "you are 2
  // kg past your cut target" built on a mistyped number. Same bounds as
  // METRIC_BOUNDS.weight, so a reading that could not have been stored through the
  // API cannot be believed if it got there some other way.
  const result = computeAttainment({
    targetWeightKg: 75,
    today: TODAY,
    goals: ['lose_fat'],
    readings: readings(['2026-09-20', 80], ['2026-09-25', 3]),
  });

  assert.equal(result.currentWeightKg, 80);
  assert.equal(result.asOf, '2026-09-20');
});

test('a reading above the plausible body range is dropped', () => {
  const result = computeAttainment({
    targetWeightKg: 75,
    today: TODAY,
    readings: readings(['2026-09-20', 80], ['2026-09-25', 900]),
  });

  assert.equal(result.currentWeightKg, 80);
});

test('a malformed reading date is dropped rather than sorted into the series', () => {
  // '2026-02-31' is not a date. The shape check passes and the string sorts
  // between 28 Feb and 1 Mar, so without this it silently becomes its own point
  // in the series and, if it is the latest, the reported "current" weight.
  const result = computeAttainment({
    targetWeightKg: 75,
    today: TODAY,
    readings: readings(['2026-09-20', 80], ['2026-02-31', 78]),
  });

  assert.equal(result.currentWeightKg, 80);
  assert.equal(result.asOf, '2026-09-20');
});

test('a malformed target date is ignored rather than trusted', () => {
  // If this were used, every day calculation below would be wrong in a way that
  // still produced confident numbers.
  const result = computeAttainment({
    targetWeightKg: 75,
    targetDate: 'next tuesday',
    today: TODAY,
    readings: readings(['2026-09-25', 78]),
  });

  assert.equal(result.targetDate, null);
  assert.equal(result.daysLeft, null);
});

test('a future-dated reading is ignored', () => {
  // A typo or a clock skew. Allowed through, a user could appear to have hit a
  // goal they have not approached yet - which is the one thing this endpoint
  // must never say wrongly.
  const result = computeAttainment({
    ...lose,
    readings: readings(['2026-09-25', 78], ['2026-10-05', 75]),
  });

  assert.equal(result.currentWeightKg, 78);
  assert.notEqual(result.status, ATTAINMENT_STATUS.REACHED);
});

test('a physically impossible reading is dropped rather than clamped', () => {
  // 0 kg and a negative are typos, and clamping them to some floor would invent a
  // measurement the user never took.
  const result = computeAttainment({
    ...lose,
    readings: readings(['2026-09-20', 80], ['2026-09-25', 0], ['2026-09-28', -5]),
  });
  assert.equal(result.currentWeightKg, 80);
});

test('an old reading is answered but flagged stale', () => {
  const result = computeAttainment({
    ...lose,
    readings: readings(['2026-09-01', 80], ['2026-09-02', 77]),
  });

  // The user still gets an answer - hiding it would be its own kind of dishonesty
  // - but the screen can say the number is old rather than implying it was taken
  // this morning.
  assert.equal(result.asOf, '2026-09-02');
  assert.ok(result.daysSinceMeasurement > STALE_WEIGHT_DAYS);
  assert.equal(result.stale, true);
});

test('a recent reading is not stale', () => {
  const result = computeAttainment({
    ...lose,
    readings: readings(['2026-09-25', 78], ['2026-09-29', 77.5]),
  });
  assert.equal(result.stale, false);
});

test('readings out of order are sorted, so the latest is genuinely the latest', () => {
  // Prisma orders by (localDate, id) but the pure function accepts any order, and
  // a wrong "current" would silently report the user's weight weeks out of date.
  const result = computeAttainment({
    ...lose,
    readings: readings(['2026-09-28', 78], ['2026-09-20', 80], ['2026-10-01', 77]),
  });
  assert.equal(result.currentWeightKg, 77);
  assert.equal(result.asOf, '2026-10-01');
});

test('the baseline is the first reading, not the most recent one', () => {
  // Progress is measured from where the user started. Using the latest reading as
  // both ends would report a change of zero and a rate of zero - technically
  // arithmetic, completely useless.
  const result = computeAttainment({
    ...lose,
    readings: readings(['2026-08-01', 84], ['2026-10-01', 78]),
  });
  assert.equal(result.startWeightKg, 84);
  assert.equal(result.currentWeightKg, 78);
  assert.ok(result.actualWeeklyKg < 0);
});

test('a baseline older than a year is not used', () => {
  // A two-year-old first weigh-in describes a different situation, and progress
  // measured from it is arithmetic dressed up as insight.
  const result = computeAttainment({
    ...lose,
    readings: readings(['2024-01-01', 95], ['2026-10-01', 78]),
  });
  assert.notEqual(result.startWeightKg, 95);
});

test('a single reading gives no projection rather than a fabricated one', () => {
  // There is no line to project, only a point. A rate from one point is a
  // division by zero dressed as a trend.
  const result = computeAttainment({
    ...lose,
    readings: readings(['2026-10-01', 78]),
  });

  assert.equal(result.currentWeightKg, 78);
  assert.equal(result.actualWeeklyKg, null);
  assert.notEqual(result.status, ATTAINMENT_STATUS.ON_TRACK);
});

test('two readings on the same day give no projection', () => {
  const result = computeAttainment({
    ...lose,
    readings: readings(['2026-10-01', 80], ['2026-10-01', 77]),
  });
  assert.equal(result.actualWeeklyKg, null);
  assert.notEqual(result.status, ATTAINMENT_STATUS.ON_TRACK);
});

test('projectPace refuses to project onto a date that has passed', () => {
  // Dividing by a negative span produces a confident number pointing the wrong
  // way, which is worse than no number.
  const pace = projectPace({
    start: { kg: 80, localDate: '2026-09-01' },
    current: { kg: 77, localDate: '2026-10-01' },
    target: 75,
    now: TODAY,
    targetDate: '2026-09-20',
  });
  assert.equal(pace, null);
});

test('malformed input degrades to the least committal status, never an error', () => {
  // A screen that cannot render attainment at all is worse than one a day late.
  for (const bad of [null, undefined, NaN, 0, -5, 'heavy', {}]) {
    const result = computeAttainment({
      targetWeightKg: bad,
      targetDate: TODAY,
      readings: readings(['2026-09-25', 78]),
      today: TODAY,
    });
    assert.equal(result.status, ATTAINMENT_STATUS.NO_TARGET, `for ${String(bad)}`);
  }
});

test('a non-array readings argument is treated as no readings', () => {
  const result = computeAttainment({ ...lose, readings: undefined });
  assert.equal(result.status, ATTAINMENT_STATUS.NOT_MEASURED);
});

// --- the database half --------------------------------------------------------

function fakePrisma({ goal, entries = [] } = {}) {
  return {
    healthGoal: { findUnique: async () => goal },
    biometricEntry: { findMany: async () => entries },
  };
}

test('a user with no target never has their weight series read', async () => {
  // Not just cheaper. A user who has not asked a weight question should not have
  // their weight read off the database for a screen that will not show it.
  let readWeight = false;
  const prisma = {
    healthGoal: { findUnique: async () => ({ targetWeightKg: null, targetDate: null, goals: ['general_health'] }) },
    biometricEntry: {
      findMany: async () => {
        readWeight = true;
        return [];
      },
    },
  };

  const result = await getAttainment(prisma, { userId: 1, localDate: TODAY });
  assert.equal(result.status, ATTAINMENT_STATUS.NO_TARGET);
  assert.equal(readWeight, false);
});

test('the recorded goal reaches the calculation, not just the response', async () => {
  // `isPastTarget` abstains for goals the scale cannot speak for, so a goal that
  // only reached the response would make every one of those answers "reached"
  // regardless. Asserted end to end through the database half.
  const prisma = {
    healthGoal: {
      findUnique: async () => ({
        targetWeightKg: 75,
        targetDate: '2026-11-01',
        goals: ['recomp'],
      }),
    },
    biometricEntry: {
      findMany: async () => [
        { value: 80, localDate: '2026-08-01' },
        { value: 71, localDate: '2026-10-01' },
      ],
    },
  };

  const result = await getAttainment(prisma, { userId: 1, localDate: '2026-10-01' });

  assert.notEqual(result.status, ATTAINMENT_STATUS.REACHED);
  assert.deepEqual(result.goals, ['recomp']);
});

test('the goal comes back with the answer, so the screen can name it', async () => {
  // A number labelled "goal" with no goal attached is a question the user has to
  // answer about their own life.
  const prisma = fakePrisma({
    goal: { targetWeightKg: 75, targetDate: '2026-11-01', goals: ['lose_fat'] },
    entries: [
      { value: 80, localDate: '2026-09-01' },
      { value: 77, localDate: '2026-10-01' },
    ],
  });

  const result = await getAttainment(prisma, { userId: 1, localDate: TODAY });
  assert.deepEqual(result.goals, ['lose_fat']);
  assert.equal(result.status, ATTAINMENT_STATUS.ON_TRACK);
});

test('a set where only one goal abstains still gets a verdict from the scale', async () => {
  // `recomp` + `lose_fat` is the case the "every goal abstains" rule exists for.
  // The series has crossed the target, and one of the two goals is a weight goal,
  // so calling it REACHED is a statement the service can actually support.
  // Requiring ALL goals to abstain is what stops this being discarded because the
  // user also ticked a non-weight objective.
  const prisma = {
    healthGoal: {
      findUnique: async () => ({
        targetWeightKg: 75,
        targetDate: '2026-11-01',
        goals: ['recomp', 'lose_fat'],
      }),
    },
    biometricEntry: {
      findMany: async () => [
        { value: 80, localDate: '2026-08-01' },
        { value: 71, localDate: '2026-10-01' },
      ],
    },
  };

  const result = await getAttainment(prisma, { userId: 1, localDate: '2026-10-01' });
  assert.equal(result.status, ATTAINMENT_STATUS.REACHED, 'a weight goal in the set must count');
});

test('a set of only non-weight goals gets no verdict from the scale alone', async () => {
  // The other half of the rule, and the case a naive `goals.length > 0` check
  // would get backwards.
  const prisma = {
    healthGoal: {
      findUnique: async () => ({
        targetWeightKg: 75,
        targetDate: '2026-11-01',
        goals: ['recomp', 'general_health'],
      }),
    },
    biometricEntry: {
      findMany: async () => [
        { value: 80, localDate: '2026-08-01' },
        { value: 71, localDate: '2026-10-01' },
      ],
    },
  };

  const result = await getAttainment(prisma, { userId: 1, localDate: '2026-10-01' });
  assert.notEqual(result.status, ATTAINMENT_STATUS.REACHED);
  assert.deepEqual(result.goals, ['recomp', 'general_health']);
});

test('prisma decimals arrive as numbers, not strings', async () => {
  // Decimal(5,1) comes back as a Prisma Decimal object or a string depending on
  // the client, and a string target compared with arithmetic is a silent NaN.
  const prisma = fakePrisma({
    goal: { targetWeightKg: 75, targetDate: '2026-11-01', goals: ['lose_fat'] },
    entries: [{ value: 77, localDate: '2026-10-01' }],
  });

  const result = await getAttainment(prisma, { userId: 1, localDate: TODAY });
  assert.equal(typeof result.targetWeightKg, 'number');
  assert.equal(typeof result.currentWeightKg, 'number');
});

test('the weight query is filtered to the weight metric', async () => {
  // A missing filter would mix in body-fat percentages as kilograms and produce
  // an answer about a number nobody entered.
  let where = null;
  const prisma = {
    healthGoal: { findUnique: async () => ({ targetWeightKg: 75, targetDate: null, goals: ['lose_fat'] }) },
    biometricEntry: {
      findMany: async (args) => {
        where = args.where;
        return [];
      },
    },
  };

  await getAttainment(prisma, { userId: 1, localDate: TODAY });
  assert.equal(where.metric, 'weight');
  assert.equal(where.userId, 1);
});

test('a user with no goal row at all gets no target, not an error', async () => {
  const prisma = fakePrisma({ goal: null });
  const result = await getAttainment(prisma, { userId: 1, localDate: TODAY });
  assert.equal(result.status, ATTAINMENT_STATUS.NO_TARGET);
});
