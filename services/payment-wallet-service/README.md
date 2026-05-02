# Payment Wallet Service

A Java Spring Boot microservice for handling both wallet and payment flows for customers, partners, and gobhi users.

## Features
- Wallet creation and management
- Payment flows (customer, partner, payouts)
- Transaction history
- Credit/debit wallet
- PostgreSQL integration

## Tech Stack
- Java 17+
- Spring Boot
- Spring Data JPA (Hibernate)
- PostgreSQL
- Maven

## Setup
1. Ensure you have Java 17+ and Maven installed.
2. Configure your PostgreSQL connection in `src/main/resources/application.properties`.
3. Build and run:
   ```bash
   mvn spring-boot:run
   ```

## API Endpoints (examples)
- `POST   /api/wallet` — Create wallet
- `GET    /api/wallet/{userId}` — Get wallet
- `GET    /api/wallet/{userId}/transactions` — Get transactions
- `POST   /api/wallet/{userId}/credit` — Credit wallet
- `POST   /api/wallet/{userId}/debit` — Debit wallet
- `POST   /api/payment/customer` — Customer payment
- `POST   /api/payment/partner` — Partner payment
- `POST   /api/payment/payout/partner` — Payout to partner
- `POST   /api/payment/payout/gobhi` — Payout to gobhi

## Directory Structure
- `controller/` — REST controllers
- `service/` — Business logic
- `repository/` — JPA repositories
- `model/` — JPA entities

---

**Edit `application.properties` for your DB credentials before running!**
