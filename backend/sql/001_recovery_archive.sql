-- Additive only. Also applied by the guarded startup preparation.
-- This script does not alter, delete, or populate any existing table.
BEGIN;
CREATE TABLE IF NOT EXISTS "RecoverySnapshot" (
  "id" TEXT PRIMARY KEY,
  "origin" TEXT NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "uploadedBy" TEXT NOT NULL,
  "counts" JSONB NOT NULL,
  "payload" JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS "RecoverySnapshot_createdAt_idx" ON "RecoverySnapshot"("createdAt");
COMMIT;
