-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('credit', 'debit', 'transfer', 'bonus', 'payout', 'topup', 'withdrawal');

-- CreateTable
CREATE TABLE "Wallet" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "userType" "UserType" NOT NULL,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTransaction" (
    "id" SERIAL NOT NULL,
    "walletId" INTEGER NOT NULL,
    "type" "TransactionType" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction" (
    "id" BIGSERIAL NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(6),
    "currency" VARCHAR(255),
    "description" VARCHAR(255),
    "status" VARCHAR(255) NOT NULL,
    "type" VARCHAR(255) NOT NULL,
    "wallet_id" BIGINT NOT NULL,

    CONSTRAINT "transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet" (
    "id" BIGSERIAL NOT NULL,
    "balance" DOUBLE PRECISION,
    "created_at" TIMESTAMP(6),
    "currency" VARCHAR(255),
    "deleted_at" TIMESTAMP(6),
    "status" VARCHAR(255) NOT NULL,
    "updated_at" TIMESTAMP(6),
    "user_id" BIGINT NOT NULL,
    "user_type" VARCHAR(255) NOT NULL,

    CONSTRAINT "wallet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "uk_hgee4p1hiwadqinr0avxlq4eb" ON "wallet"("user_id");

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "fktfwlfspv2h4wcgc9rjd1658a6" FOREIGN KEY ("wallet_id") REFERENCES "wallet"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
