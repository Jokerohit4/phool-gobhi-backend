# Backend Learning Progress — Rohitashwa

Learning goal: Tech-lead level backend understanding, using phool-gobhi-backend as the textbook.
Method: Socratic Q&A with Claude. Deep & patient — don't move on until you can teach it back.

---

## Module 1 — What is a backend? (DONE ✅)

### Key concepts locked in

**HTTP Request anatomy**
A request is just structured text. It has:
- Method (`POST`, `GET`…) — what kind of action
- Path (`/api/auth/send-otp`) — which endpoint
- Headers (metadata: content type, auth token)
- Body (the actual data, e.g. `{"phone": "9354859197"}`)

The response is also just text — a status code + body. HTTP is an agreed-upon text format. Nothing magic.

**IP address vs Port**
- IP address = which *machine* (the building)
- Port = which *program* on that machine (the apartment)
- Path = which *function* inside that program (the room)

Order when a request arrives: machine → program → function. Outside-in.

`app.listen(5001)` means auth-service is saying "I'll handle everything arriving at apartment 5001."

**Why logic must live on the server, not the APK**
1. Attacker can decompile APK and read all logic/secrets
2. Backend changes don't require an app release
3. Keeps app size small
4. Consistency — doesn't depend on device performance
5. Secrets (OTP generation, JWT signing) must live somewhere the user can't see

> Rule: **Never trust the client. The client is the attacker's territory.**

---

## Module 2 — The API Gateway (DONE ✅)

### Key concepts locked in

**Why a gateway exists**
Two problems it solves:
1. **Single entry point** — app hardcodes one URL. Service changes don't require app releases.
2. **Centralised cross-cutting concerns** — JWT verification, rate limiting, logging live in one place, not copy-pasted into 6 services. (Principle: Don't Repeat Yourself at architecture level)

> Rule: **Authenticate once at the gate. Everything behind it trusts the internal network.**

**Public vs private routes**
- Public = no JWT needed, not user-specific (e.g. send-otp, gym list)
- Public routes *must* exist because you can't demand a token from someone trying to *get* a token
- Private routes: gateway checks JWT → extracts `userId/role/type` → forwards as `x-user-id`, `x-user-role`, `x-user-type` headers → services trust those headers without re-verifying

---

## Module 3 — JWT Deep Dive (DONE ✅)

### Key concepts locked in

**What a JWT is**
Three parts separated by dots: `header.payload.signature`
- Header: algorithm used
- Payload: the data (userId, role, type) — Base64 encoded, anyone can *read* it
- Signature: the security mechanism

**The signature mechanism (the key insight)**
```
signature = HMAC_SHA256(header + "." + payload, JWT_SECRET)
```
When verifying:
```
recomputed = HMAC_SHA256(incoming header + "." + incoming payload, JWT_SECRET)
valid = (recomputed == incoming signature)
```
No database call. Pure math. Fast.

**Why you can't tamper with the payload**
Change `"role":"customer"` → `"role":"gobhi"`, re-encode. Gateway recomputes signature on the new payload → different hash → doesn't match original signature → rejected. Attacker can't forge because they don't know `JWT_SECRET`.

> Rule: **`JWT_SECRET` is the crown jewel. If it leaks, anyone can mint tokens for any user/role. Never put it in an APK, git history, or logs.**

**Token expiry**
Payload contains an `exp` Unix timestamp. Gateway checks `now < exp` even if math is valid. Solves stolen token problem — token becomes useless after a short window (typically 15min–1hr).

**Access token vs Refresh token**

| | Access Token | Refresh Token |
|---|---|---|
| Expiry | Short (15min–1hr) | Long (7–30 days) |
| Stored in DB? | No | Yes |
| Used for? | Every API call | Only to get a new access token |

- Refresh token stored in DB = **revocable**. Logout deletes it. Stolen phone → delete it. Attacker's mathematically valid token gets rejected because it no longer exists in DB.
- Access token = fast, stateless, math-only. Refresh token = slower, stateful, revocable.
- **Refresh token rotation:** each refresh call issues a new access + refresh pair, old refresh token immediately invalidated.
- In jim_customer: Dio interceptor catches 401 → sends refresh token → gets new access token → retries original request. User never re-enters OTP.

---

## Module 4 — Databases: Postgres, MongoDB, Prisma (IN PROGRESS 🔄)

### Key concepts locked in

**Why Postgres for bookings/wallet**
- Needs ACID transactions — **Atomicity** means all-or-nothing (wallet debit + booking create must both succeed or both fail)
- ACID = Atomicity, Consistency, Isolation, Durability
- Any time real money moves, you need ACID. Non-negotiable.

**Why MongoDB for user profiles**
- Schema-less — each document can have different fields, no migrations needed
- Postgres requires `ALTER TABLE` to add a column (locks table briefly on large datasets)
- MongoDB: just start storing the new field on new documents, old ones unaffected
- Rule: **Postgres = rigid structure + relations + money. MongoDB = flexible structure + fast iteration.**

**What Prisma is**
- ORM (Object Relational Mapper) — two jobs:
  1. Schema definition (`schema.prisma` → `prisma db push` → SQL `CREATE TABLE`)
  2. Query translation: `prisma.gym.findMany()` → SQL query (type-safe, typos caught at code time not runtime)
- Without Prisma: raw SQL strings with no type safety

**Microservices and cross-service relations**
- `partnerId` in Gym table is just an `Int` — NOT a real foreign key to auth-service's users table
- Two separate databases on separate services = no cross-service foreign keys
- Cost of microservices: you lose referential integrity across services, must enforce manually in code
- Relations *within* the same service DB are real and enforced (GymImage, GymReview, SlotBlock all link to Gym properly)

**`onDelete: Cascade`** — when a Gym is deleted, all its GymImages, GymReviews, and SlotBlocks are automatically deleted too. Prevents orphaned records inside the same DB.

### Still to answer (Question 6 — paused here)
- [ ] `@@unique([gymId, customerId])` on GymReview — what behaviour does this enforce?
- [ ] `@@index` vs `@@unique` — what does an index actually do, why does `partnerId` need one?

---

## Upcoming Modules

- **Module 5** — Middleware: what it is, how your `requireAuth` works line by line
- **Module 6** — The booking flow end to end: JWT → gateway → booking-service → wallet debit → partner credit
- **Module 7** — Error handling and status codes: what 400/401/403/404/500 mean and when to use each
- **Module 8** — Environment variables and secrets management
- **Module 9** — Scaling and why microservices exist (the tradeoffs a tech lead thinks about)

---

## Concepts to Revisit / Weak Spots

- Refresh token DB storage — initially thought it was "two hashes combined"; correct model is it's a normal JWT but stored in DB making it revocable

---

## How to use this file
After each session, the new concepts get added here. Before the next session, re-read the last module. If you can explain each bullet point out loud without reading it, it's locked in.
