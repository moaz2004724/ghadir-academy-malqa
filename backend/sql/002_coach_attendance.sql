-- Additive only. Also applied by the guarded startup preparation.
BEGIN;
CREATE TABLE IF NOT EXISTS "CoachAttendance" (
  "id" TEXT PRIMARY KEY,
  "date" TIMESTAMP(3) NOT NULL,
  "records" JSONB NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "CoachAttendance_date_key" ON "CoachAttendance"("date");
COMMIT;
