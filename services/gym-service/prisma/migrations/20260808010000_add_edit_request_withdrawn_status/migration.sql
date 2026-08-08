-- Hand-authored migration (same caveat as every prior migration in this
-- service: no shadow DB was available; reconcile against the actual dev/prod
-- DB before applying).
--
-- Lets a partner cancel their own still-pending edit request before a gobhi
-- reviews it — see gymService.js's withdrawEditRequest. Distinct from
-- 'rejected' (a gobhi disapproving it) so partner-facing "not approved"
-- messaging never fires for something the partner withdrew themselves.

ALTER TYPE "gym"."EditRequestStatus" ADD VALUE IF NOT EXISTS 'withdrawn';
