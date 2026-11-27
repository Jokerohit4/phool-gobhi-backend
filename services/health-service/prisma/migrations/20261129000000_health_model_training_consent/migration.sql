CREATE TABLE "health"."ModelTrainingConsent" (
    "userId" INTEGER NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "policyVersion" TEXT NOT NULL,

    CONSTRAINT "ModelTrainingConsent_pkey" PRIMARY KEY ("userId")
);
