-- Link a medical document to the doctor appointment it was scanned or uploaded for.
ALTER TABLE "health"."MedicalDocument" ADD COLUMN "appointmentId" INTEGER;

CREATE INDEX "MedicalDocument_appointmentId_idx" ON "health"."MedicalDocument"("appointmentId");

ALTER TABLE "health"."MedicalDocument"
  ADD CONSTRAINT "MedicalDocument_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "health"."DoctorAppointment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
