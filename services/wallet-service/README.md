# Wallet Service

Handles wallet creation, balance management, and transactions for all user types (customer, partner, gobhi).

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Set up your `.env` file (see `.env` for template).
3. Run Prisma migrations:
   ```bash
   npx prisma migrate dev --name init
   ```
4. Start the service:
   ```bash
   npm run dev
   ```

## API Endpoints

- `POST   /api/wallet/`                — Create wallet `{ userId, userType }`
- `GET    /api/wallet/:userId`         — Get wallet by userId
- `GET    /api/wallet/:userId/transactions` — Get wallet transactions
- `POST   /api/wallet/:userId/credit`  — Credit wallet `{ amount, description }`
- `POST   /api/wallet/:userId/debit`   — Debit wallet `{ amount, description }`

## Models

See `prisma/schema.prisma` for details. 