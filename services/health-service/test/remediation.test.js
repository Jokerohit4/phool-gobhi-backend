import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACTIONABLE_KINDS,
  BY_KIND,
  CALORIES_LOW_COPY,
  lowCopyIsSafe,
  openActions,
} from '../services/ledger/remediation.js';
import { isFutureAppointment, isScheduledFor } from '../services/ledger/scoreEngine.js';

const TODAY = '2026-09-28';

const item = (id, kind, extra = {}) => ({
  id,
  kind,
  title: `Item ${id}`,
  active: true,
  endsOn: null,
  ...extra,
});

const done = (planItemId, localDate = TODAY) => ({
  planItemId,
  localDate,
  how: 'manual',
  late: false,
});

describe('open actions: what is still open today', () => {
  it('a scheduled, uncompleted item is offered', () => {
    const out = openActions({ planItems: [item(1, 'workout')], localDate: TODAY });
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'workout');
    // The user's own words, not a restatement of the kind.
    assert.equal(out[0].label, 'Item 1');
    assert.ok(out[0].action.length > 0);
  });

  it('an item ticked today is not offered', () => {
    const out = openActions({
      planItems: [item(1, 'workout')],
      completions: [done(1)],
      localDate: TODAY,
    });
    assert.deepEqual(out, []);
  });

  it("yesterday's tick does not close today's item", () => {
    // The mistake this guards: keying completions on planItemId alone. A user who
    // logs yesterday's missed workout this morning would see today's silently
    // disappear from the list, and would have no way to tell it had been
    // swallowed rather than done.
    const out = openActions({
      planItems: [item(1, 'workout')],
      completions: [done(1, '2026-09-27')],
      localDate: TODAY,
    });
    assert.equal(out.length, 1);
  });

  it('a completion with no date of its own still counts, for older clients', () => {
    const out = openActions({
      planItems: [item(1, 'workout')],
      completions: [{ planItemId: 1 }],
      localDate: TODAY,
    });
    assert.deepEqual(out, []);
  });

  it('an inactive item is not offered', () => {
    const out = openActions({
      planItems: [item(1, 'workout', { active: false })],
      localDate: TODAY,
    });
    assert.deepEqual(out, []);
  });

  it('a course of tablets that has ended is not offered, and is not deleted', () => {
    // The item is still in the plan and still visible to the user. This is about
    // what to nag about, not about what exists - deciding a prescription is over
    // is not this service's call. The exclusion is the engine's own
    // `isScheduledFor`, which returns false for a past `endsOn`.
    const ended = item(1, 'doctor_medication', { endsOn: '2026-09-01' });
    assert.equal(isScheduledFor(ended, TODAY), false);

    const out = openActions(
      { planItems: [ended], localDate: TODAY },
      { isScheduledFor },
    );
    assert.deepEqual(out, [], 'a finished course must not be nagged about');
  });

  it('a course of tablets that ends today is still offered', () => {
    // The last day of a course is still a day to take it. `endsOn < localDate`
    // and not `<=`, and both sides of that comparison are worth a test.
    const endingToday = item(1, 'doctor_medication', { endsOn: TODAY });
    assert.equal(isScheduledFor(endingToday, TODAY), true);

    const out = openActions(
      { planItems: [endingToday], localDate: TODAY },
      { isScheduledFor },
    );
    assert.equal(out.length, 1);
  });
});

describe('open actions: a future appointment is not today\'s work', () => {
  it('an appointment dated next week is not due today, so it never reaches the list', () => {
    // A doctor's appointment carries its date in the plan item's `schedule`
    // field, not in a separate date column - there is no `startsOn` on the
    // model, and an earlier version of this module filtered on one. The filter
    // that actually works is the schedule predicate, which this test drives
    // directly: an appointment scheduled for the 4th is not scheduled for the
    // 28th, so it is not something to do today.
    const appointment = item(1, 'doctor_appointment', { schedule: '2026-10-04' });
    assert.equal(isScheduledFor(appointment, TODAY), false);

    const out = openActions(
      { planItems: [appointment], localDate: TODAY },
      { isScheduledFor },
    );
    assert.deepEqual(out, [], 'a future appointment must not be on today\'s list');
  });

  it("today's appointment is due today and is offered", () => {
    const appointment = item(1, 'doctor_appointment', { schedule: TODAY });
    assert.equal(isScheduledFor(appointment, TODAY), true);

    const out = openActions(
      { planItems: [appointment], localDate: TODAY },
      { isScheduledFor },
    );
    assert.equal(out.length, 1);
  });

  it('the engine agrees there is nothing extra to check for future appointments', () => {
    // `isFutureAppointment` is a hardcoded false in the engine, and this is why
    // that is correct rather than a stub: the schedule filter has already
    // removed anything dated later. Asserted so the next reader does not treat
    // it as an unimplemented guard and add a second, redundant one.
    assert.equal(isFutureAppointment(item(1, 'doctor_appointment'), TODAY), false);
  });

  it('rest and nutrition are never offered, because neither is a tap', () => {
    // A rest day is done by not doing anything, and a nutrition target is
    // satisfied by whatever gets logged - neither is an action the user can take
    // from a list, so offering them would be a dead row.
    for (const kind of ['rest', 'nutrition']) {
      const out = openActions({ planItems: [item(1, kind)], localDate: TODAY });
      assert.deepEqual(out, [], `${kind} must not appear as an open action`);
    }
  });

  it('no kind is offered without copy behind it', () => {
    // The guarantee that a new plan-item kind cannot ship with no wording. If a
    // kind were added to ACTIONABLE_KINDS without a BY_KIND entry it would
    // destructure undefined and throw on the first user's first render, so the
    // two sets are checked against each other here instead.
    for (const kind of ACTIONABLE_KINDS) {
      assert.ok(BY_KIND[kind], `kind ${kind} is actionable but has no copy`);
      assert.ok(
        typeof BY_KIND[kind].action === 'string' && BY_KIND[kind].action.length > 0,
        `kind ${kind} has no action text`,
      );
    }
    for (const kind of Object.keys(BY_KIND)) {
      assert.ok(
        ACTIONABLE_KINDS.has(kind),
        `kind ${kind} has copy but is not offered, so the copy is dead`,
      );
    }
  });
});

describe('open actions: the order and the cap', () => {
  it('medication outranks a workout', () => {
    // Not a judgement about the person: a missed dose does not wait for a
    // convenient evening, and the first item on screen is what leads.
    const out = openActions({
      planItems: [item(1, 'workout'), item(2, 'doctor_medication')],
      localDate: TODAY,
    });
    assert.deepEqual(
      out.map((r) => r.kind),
      ['doctor_medication', 'workout'],
    );
  });

  it('a long plan is capped, and the cap keeps the highest ranked', () => {
    const planItems = [
      item(1, 'habit'),
      item(2, 'habit'),
      item(3, 'habit'),
      item(4, 'workout'),
      item(5, 'doctor_medication'),
    ];
    // `limit` is the second argument, not a field of the data object. Passing it
    // in the data object is silently ignored, so the assertion below would pass
    // against the default of 4 for the wrong reason if the two were swapped.
    const out = openActions({ planItems, localDate: TODAY }, { limit: 3 });
    assert.equal(out.length, 3);
    assert.deepEqual(
      out.map((r) => r.kind),
      ['doctor_medication', 'workout', 'habit'],
    );
  });

  it('the default cap is four, and a fifth item is dropped', () => {
    const planItems = [
      item(1, 'doctor_medication'),
      item(2, 'doctor_test'),
      item(3, 'doctor_appointment'),
      item(4, 'workout'),
      item(5, 'habit'),
    ];
    const out = openActions({ planItems, localDate: TODAY });
    assert.equal(out.length, 4, 'the habit ranks last and is the one dropped');
  });

  it('no points appear anywhere on an action', () => {
    // The whole reason this is a list and not a scoreboard. Also: a "+15" next
    // to an item would not survive the daily caps, so it would be a promise the
    // service cannot keep.
    const out = openActions({
      planItems: [item(1, 'workout'), item(2, 'doctor_medication')],
      localDate: TODAY,
    });
    for (const action of out) {
      assert.equal(action.points, undefined, 'an action must carry no point value');
      assert.ok(!/\d/.test(action.action), `action text carries a number: "${action.action}"`);
    }
  });
});

describe('open actions: the schedule predicate is the engine\'s, not a copy', () => {
  it('an item the engine says is not due is not offered', () => {
    // Injected rather than reimplemented, precisely so a plan with an every-
    // other-day workout does not show up on the wrong day. If this predicate
    // were reimplemented here the two would drift and the user would be told to
    // train on a rest day the engine never asked for.
    const isScheduledFor = (i, date) => date === '2026-09-28';
    const out = openActions(
      { planItems: [item(1, 'workout')], localDate: '2026-09-30' },
      { isScheduledFor },
    );
    assert.deepEqual(out, []);
  });

  it('an item the engine says is due is offered', () => {
    const isScheduledFor = (i, date) => date === '2026-09-30';
    const out = openActions(
      { planItems: [item(1, 'workout')], localDate: '2026-09-30' },
      { isScheduledFor },
    );
    assert.equal(out.length, 1);
  });
});

describe('open actions: bad input is not a crash', () => {
  it('empty and missing everything produce an empty list', () => {
    assert.deepEqual(openActions(), []);
    assert.deepEqual(openActions({}), []);
    assert.deepEqual(openActions({ planItems: [], completions: [], localDate: TODAY }), []);
    assert.deepEqual(openActions({ planItems: null, localDate: TODAY }), []);
  });

  it('a day with no localDate produces nothing', () => {
    // Without a date there is no "today", and guessing one would attach a plan
    // to an arbitrary day.
    assert.deepEqual(openActions({ planItems: [item(1, 'workout')] }), []);
  });

  it('malformed items are skipped rather than thrown on', () => {
    const out = openActions({
      planItems: [null, {}, { kind: 'workout' }, item(1, 'workout')],
      localDate: TODAY,
    });
    // The untitled workout is dropped too, not just the shape-less entries: it
    // would render as a blank row with a button beside it.
    assert.equal(out.length, 1, 'only the one well-formed item survives');
    assert.equal(out[0].itemId, 1);
  });

  it('a whitespace-only title is treated as no title', () => {
    const out = openActions({
      planItems: [item(1, 'workout', { title: '   ' })],
      localDate: TODAY,
    });
    assert.deepEqual(out, []);
  });
});

describe('the low-intake guard', () => {
  it('the low-side copy is a report, not a prompt', () => {
    assert.ok(
      lowCopyIsSafe(),
      `low-side copy reads as pressure to eat: "${CALORIES_LOW_COPY}"`,
    );
  });

  it('the guard fails when the copy is edited into a prompt', () => {
    // The counterpart. Without this, `lowCopyIsSafe` could be passing only
    // because it tests a constant nobody has changed yet.
    assert.equal(lowCopyIsSafe('You are 400 kcal behind - add more today'), false);
  });

  it('no open action mentions eating, intake or a target', () => {
    // The guard has to hold in the list users read every day, not only in the one
    // line the safety card shows. A habit called "eat breakfast" is the user's
    // own wording and is left alone; what is checked is the action text this
    // module authors.
    const out = openActions({
      planItems: [
        item(1, 'doctor_medication'),
        item(2, 'workout'),
        item(3, 'habit'),
        item(4, 'doctor_appointment'),
      ],
      localDate: TODAY,
    });
    for (const action of out) {
      const text = action.action.toLowerCase();
      for (const banned of ['eat', 'kcal', 'protein', 'target', 'calorie']) {
        assert.ok(
          !text.includes(banned),
          `action text mentions "${banned}": "${action.action}"`,
        );
      }
    }
  });
});
