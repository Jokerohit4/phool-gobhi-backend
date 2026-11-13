-- GET /templates asks for each template's last-done time in one grouped query:
-- WHERE userId = ? AND templateId IN (...) GROUP BY templateId, MAX(startedAt).
-- This index answers it without touching the table rows.
CREATE INDEX IF NOT EXISTS "WorkoutSession_userId_templateId_startedAt_idx" ON "health"."WorkoutSession"("userId", "templateId", "startedAt");
