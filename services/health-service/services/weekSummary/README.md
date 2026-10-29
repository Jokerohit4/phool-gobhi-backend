# Weekly summary contract notes

Weeks are Monday-start IST days. The authenticated read requires coachJourney
and weeklySummary. Layers use persisted journey unlocks plus current consent,
flags and setup, including wellness focus filtering. With no basic consent or
journey, layers and totals are empty. Cache hits recheck access and IST today.
The endpoint does not run journey synchronization, analytics, or goal writes.

Past resolveDay is unsuitable: it uses active (mutable) PlanItems, today's
layer states and the latest nutrition target. Completions are date-keyed but
that does not make the schedule historical. Use frozen planSummary for past
days and live resolveDay for today, explicitly labelled with plan.source.

Plan deviation: existing ScoreDaySnapshot rows do not contain counts or a
persisted target-hit decision, contrary to the fallback assumed by the plan.
Migration 20261030000000 adds nullable planSummary; new closes freeze it. Do
not fabricate legacy history: those days return null done/total/targetHit;
aggregate done/total are null if any eligible day is unknown. daysTargetHit
counts known hits. Deploy the additive migration before the code. No migration
or backfill is executed by this implementation task.

Food and water targets resolve from one history fetch, using the oldest target
for dates before history. Missing targets stay null. Today is in_progress for
food; water met is false until tomorrow, and today never contributes to daysMet.
Paused days and future days do not enter daily denominators or food sums.
Each totals block exposes closedDays (eligible elapsed days excluding today).
Use closedDays for food daysComplete/daysOnTarget, water daysMet and plan
daysTargetHit; denominatorDays still includes today for compatibility. Water
avgMl and food avgKcalCompleteDays exclude today.
Workouts count actual counted sessions (including multiple sessions per day),
with the current goal; past goals are not historical promises. ShowedUp follows
the existing journey check-in/qualifying-workout definition, range-filtered
before its day cap. It is independent of the stricter counted-workout rule.

Regenerate the client fixtures from real router responses with Prisma mocks:
UPDATE_WEEK_SUMMARY_FIXTURES=1 node --experimental-test-module-mocks --test test/weekSummaryContract.test.js
Normal tests compare response bodies with the committed fixtures.

Database range tests require RUN_WEEK_SUMMARY_DB_TESTS=1 and an explicit,
disposable TEST_DATABASE_URL. They are intentionally not run in this task.
check:drift requires DEV_DATABASE_URL and cannot pass offline; static migration
parity tests remain part of npm test. No real database may be queried here.
