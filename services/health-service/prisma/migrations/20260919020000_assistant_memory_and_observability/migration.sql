-- Two columns supporting work that was specified but never wired up.
--
-- tokensCached: the provider reports how much of a prompt it served from its
-- prefix cache. Those tokens are billed at a discount and, on the current
-- provider, do not count toward the rate limit - so without recording them
-- there is no way to answer "how close are we to the ceiling" except by
-- guessing. Part of tokensIn, never additional to it. NULL means the provider
-- did not report it, which is not the same as zero.
--
-- usedSystemPrompt: usedContext already records COUNTS of what fed a prompt.
-- That answers "how much" and never "what", which is the only question that
-- helps when someone reports a wrong or unsafe answer. The text is derived
-- entirely from rows this service already stores, lands on a table already
-- covered by the DPDPA erasure and export paths, and sits in the same row as
-- the user's own free text - so it widens no exposure that was not open.
ALTER TABLE "health"."AssistantMessage" ADD COLUMN IF NOT EXISTS "tokensCached" INTEGER;
ALTER TABLE "health"."AssistantMessage" ADD COLUMN IF NOT EXISTS "usedSystemPrompt" TEXT;
