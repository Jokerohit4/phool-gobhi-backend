CREATE TABLE "wallet"."Coupon" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "kind" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "offerKeys" JSONB,
    "activeFrom" TIMESTAMP(3),
    "activeTo" TIMESTAMP(3),
    "maxRedemptions" INTEGER,
    "perCustomerLimit" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" INTEGER,
    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Coupon_code_check" CHECK ("code" COLLATE "C" ~ '^[A-Z0-9_-]{1,32}$'),
    CONSTRAINT "Coupon_value_check" CHECK (
        ("kind" = 'fixed' AND "value" >= 1) OR ("kind" = 'percent' AND "value" BETWEEN 1 AND 99)
    ),
    CONSTRAINT "Coupon_limits_check" CHECK ("maxRedemptions" > 0 AND "perCustomerLimit" > 0),
    CONSTRAINT "Coupon_window_check" CHECK ("activeFrom" < "activeTo"),
    CONSTRAINT "Coupon_offerKeys_check" CHECK (jsonb_typeof("offerKeys") = 'array')
);

CREATE TABLE "wallet"."CouponRedemption" (
    "id" SERIAL NOT NULL,
    "couponId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CouponRedemption_status_check" CHECK ("status" IN ('reserved', 'redeemed', 'released')),
    CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "wallet"."Coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CouponRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "wallet"."CoachingOrder"("orderId") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Coupon_code_key" ON "wallet"."Coupon"("code");
CREATE UNIQUE INDEX "CouponRedemption_orderId_key" ON "wallet"."CouponRedemption"("orderId");
CREATE INDEX "CouponRedemption_couponId_status_userId_idx" ON "wallet"."CouponRedemption"("couponId", "status", "userId");
