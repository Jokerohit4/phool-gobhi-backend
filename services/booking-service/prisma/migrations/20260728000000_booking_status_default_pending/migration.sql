-- Change the default status for new bookings from 'confirmed' to 'pending'
-- so bookings stay pending until the partner explicitly confirms them.
-- Existing bookings are not affected — they retain their current status.

ALTER TABLE "booking"."Booking"
  ALTER COLUMN "status" SET DEFAULT 'pending'::"booking"."BookingStatus";
