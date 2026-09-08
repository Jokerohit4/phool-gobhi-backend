-- FR-14 (see phool-gobhi-fitness-plus-BRD.html): non-judgemental skip-reason
-- + re-plan intent, captured at cancel time. Both nullable — dismissing the
-- prompt still cancels the booking, it just records nothing, which is the
-- BRD's own "left as-is" case.
CREATE TYPE "booking"."CancellationReason" AS ENUM ('not_this_time', 'injury', 'work', 'travel', 'other');
CREATE TYPE "booking"."NextVisitIntent" AS ENUM ('today', 'this_week', 'this_month', 'unsure');

ALTER TABLE "booking"."Booking"
  ADD COLUMN "cancellationReason" "booking"."CancellationReason",
  ADD COLUMN "nextVisitIntent" "booking"."NextVisitIntent";
