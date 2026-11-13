CREATE TABLE "auth"."ExploreCatalogue" (
  "version" INTEGER PRIMARY KEY, "hash" TEXT NOT NULL UNIQUE, "payload" JSONB NOT NULL
);
CREATE TABLE "auth"."ExploreEpochManifest" (
  "epochManifestId" TEXT PRIMARY KEY, "epoch" TEXT NOT NULL,
  "worldGeneration" INTEGER NOT NULL, "payload" JSONB NOT NULL,
  CONSTRAINT "ExploreEpochManifest_epoch_worldGeneration_key" UNIQUE ("epoch", "worldGeneration")
);
CREATE TABLE "auth"."ExploreProgress" (
  "userId" INTEGER PRIMARY KEY REFERENCES "auth"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE, "revision" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE "auth"."ExploreLocationReceipt" (
  "receiptId" TEXT PRIMARY KEY, "userId" INTEGER NOT NULL REFERENCES "auth"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "occurrenceId" TEXT NOT NULL,
  "epochManifestId" TEXT NOT NULL REFERENCES "auth"."ExploreEpochManifest"("epochManifestId") ON DELETE RESTRICT ON UPDATE CASCADE,
  "revision" INTEGER NOT NULL, "acknowledgedAt" TIMESTAMPTZ(3) NOT NULL, "payload" JSONB NOT NULL,
  CONSTRAINT "ExploreLocationReceipt_userId_occurrenceId_key" UNIQUE ("userId", "occurrenceId"),
  CONSTRAINT "ExploreLocationReceipt_userId_revision_key" UNIQUE ("userId", "revision")
);
CREATE INDEX "ExploreLocationReceipt_userId_acknowledgedAt_receiptId_idx"
  ON "auth"."ExploreLocationReceipt" ("userId", "acknowledgedAt", "receiptId");
CREATE TABLE "auth"."ExploreRewardReceipt" (
  "receiptId" TEXT PRIMARY KEY, "userId" INTEGER NOT NULL REFERENCES "auth"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "rewardKey" TEXT NOT NULL, "revision" INTEGER NOT NULL,
  "acknowledgedAt" TIMESTAMPTZ(3) NOT NULL, "payload" JSONB NOT NULL,
  CONSTRAINT "ExploreRewardReceipt_userId_rewardKey_key" UNIQUE ("userId", "rewardKey"),
  CONSTRAINT "ExploreRewardReceipt_userId_revision_key" UNIQUE ("userId", "revision")
);
CREATE INDEX "ExploreRewardReceipt_userId_acknowledgedAt_receiptId_idx"
  ON "auth"."ExploreRewardReceipt" ("userId", "acknowledgedAt", "receiptId");
CREATE TABLE "auth"."ExploreClaim" (
  "userId" INTEGER NOT NULL REFERENCES "auth"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE, "claimId" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL, "receiptId" TEXT, "reason" TEXT,
  PRIMARY KEY ("userId", "claimId"),
  CONSTRAINT "ExploreClaim_terminal_outcome" CHECK (("receiptId" IS NULL) <> ("reason" IS NULL))
);
-- A publication cannot be edited/deleted even accidentally by an application upsert.
CREATE FUNCTION "auth"."reject_explore_record_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Explore records are immutable'; END $$;
CREATE TRIGGER "ExploreCatalogue_immutable" BEFORE UPDATE OR DELETE ON "auth"."ExploreCatalogue"
  FOR EACH ROW EXECUTE FUNCTION "auth"."reject_explore_record_mutation"();
CREATE TRIGGER "ExploreEpochManifest_immutable" BEFORE UPDATE OR DELETE ON "auth"."ExploreEpochManifest"
  FOR EACH ROW EXECUTE FUNCTION "auth"."reject_explore_record_mutation"();
-- Account deletion may delete receipts/commands, but their attribution/outcome cannot change.
CREATE TRIGGER "ExploreLocationReceipt_immutable" BEFORE UPDATE ON "auth"."ExploreLocationReceipt"
  FOR EACH ROW EXECUTE FUNCTION "auth"."reject_explore_record_mutation"();
CREATE TRIGGER "ExploreRewardReceipt_immutable" BEFORE UPDATE ON "auth"."ExploreRewardReceipt"
  FOR EACH ROW EXECUTE FUNCTION "auth"."reject_explore_record_mutation"();
CREATE TRIGGER "ExploreClaim_immutable" BEFORE UPDATE ON "auth"."ExploreClaim"
  FOR EACH ROW EXECUTE FUNCTION "auth"."reject_explore_record_mutation"();
