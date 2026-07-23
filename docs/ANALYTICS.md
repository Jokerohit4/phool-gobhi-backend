# Phool Gobhi — Eventing & Funnels

How product events are captured across the Flutter apps and the Node backend, and
how they roll up into the funnels that matter for the business.

> **Status (updated 2026-07-23):** instrumentation shipped (backend + both apps
> + website). The **active sink is first-party Postgres** — events are written
> to an `analytics_events` table we own (no third party). Server events write
> directly; client events POST to the gateway `/api/events` route, which now
> validates against an event-name allowlist and rate-limits (see §6). PostHog
> remains a drop-in alternative. **Every event name shipped anywhere in the
> platform must be listed in `docs/analytics-events.json`** — run
> `node scripts/check-analytics-events.cjs` to check for drift (it's a hard
> gate in `/deploy`). A dashboard now lives in the admin portal at `/analytics`
> (Supply/Conversion/Fulfillment/Activation/Wallet/Buddy tabs), backed by new
> `GET /api/bookings/admin/analytics/*` endpoints (see §8); the SQL there
> remains useful for anything not yet on that page. **Production is still
> pending a dedicated analytics DB** (§6) — until that lands, `/analytics` and
> the SQL below only reflect dev traffic.

---

## 1. Principles

1. **Vendor-neutral by design.** Every call site talks to a thin facade
   (`AnalyticsService` in the apps, `track()` in the backend). The concrete sink
   — console, no-op, PostHog, or a future first-party Postgres pipeline — is
   chosen once by an env var. Switching providers never touches call sites.
2. **Client tracks intent, server tracks truth.** Anything tied to money or state
   (signup, booking confirmed, payment, gym approved) is emitted **server-side**
   where it can't be faked or dropped. The apps emit UI intent (taps, screen
   views, slot selection).
3. **One identity.** Both client and server key events on the numeric `userId`
   (the JWT subject the gateway forwards as `x-user-id`). The app calls
   `identify(userId)` on login so pre-login anonymous events stitch to the user.
4. **No PII in analytics.** We send `userId` only — never phone, email, or name as
   event properties.
5. **Analytics never breaks the app.** All sends are fire-and-forget and
   swallow errors.

---

## 2. Architecture

```
 Flutter apps (jim_customer, jim_partner)        Node backend (per service + gateway)
 ┌───────────────────────────────┐               ┌──────────────────────────────┐
 │ AnalyticsService (facade)      │               │ utils/analytics.js  track()   │
 │  ├─ ConsoleAnalyticsService    │               │  ├─ console sink              │
 │  ├─ NoopAnalyticsService       │               │  ├─ noop (default)            │
 │  └─ PostHogAnalyticsService ───┼──┐         ┌──┼─ posthog (HTTP /capture)      │
 │     (HTTP /capture, no SDK)    │  │         │  └──────────────────────────────┘
 └───────────────────────────────┘  │         │  gateway · auth · booking · wallet │
   identify / track / screen / reset │         │  · gym · buddy                    │
                                     ▼         ▼   emit at lifecycle truth points
                              Postgres (or PostHog) — funnels built here
```

- **Apps:** `lib/core/analytics/analytics_service.dart` + `analytics_events.dart`.
  Sink chosen from `--dart-define` (see below). Screen views auto-tracked
  (partner: via `combinedGenerateRoutes`; customer: via `AnalyticsRouteObserver`
  on `navigatorObservers`).
- **Backend:** an identical `utils/analytics.js` lives in `auth-service`,
  `booking-service`, `wallet-service`, `gym-service`, and `buddy-service`, plus
  the gateway (which also runs `ingest()` for client-emitted events posted to
  `/api/events`). Each service emits the events it owns. The PostHog sink posts
  to the free HTTP capture API — **no SDK dependency**.

---

## 3. Identity model

| Phase | distinct_id | How |
|---|---|---|
| Pre-login (OTP funnel) | anonymous device id | generated in the PostHog sink |
| On login success | `userId` | app calls `identify(userId, {role, user_type})`, which aliases the anon id → user |
| Server events | `userId` | passed directly to `track()` |
| Logout | new anon id | app calls `reset()` (prevents cross-account bleed on shared devices) |

Because both halves use `userId`, a funnel can freely mix client and server steps,
e.g. `book_tapped` (client) → `booking_confirmed` (server).

---

## 4. Event dictionary

Naming: `snake_case`, `noun_verb`, past tense for completed actions. **Names are
stable contracts — renaming a shipped event breaks historical funnels.**

### Server-emitted (truth)

| Event | Service | distinct_id | Key properties |
|---|---|---|---|
| `signup_completed` | auth | userId | `role`, `user_type` |
| `login_completed` | auth | userId | `role`, `user_type` |
| `booking_confirmed` | booking | customerId | `booking_id`, `gym_id`, `amount`, `date`, `start_time` |
| `booking_failed` | booking | customerId | `gym_id`, `reason` (`slot_full`/`insufficient_balance`), `amount` |
| `booking_cancelled` | booking | customerId | `booking_id`, `gym_id`, `amount`, `date` |
| `booking_completed` | booking | customerId | `booking_id`, `gym_id`, `amount`, `date` |
| `checkin_requested` | booking | customerId | `booking_id`, `gym_id`, `location_verified` |
| `wallet_topup_order_created` | wallet | userId | `amount`, `order_id` |
| `wallet_topup_succeeded` | wallet | userId | `amount`, `order_id`, `via` (`webhook` if async) |
| `wallet_topup_failed` | wallet | userId | `amount`, `order_id` |
| `subscription_purchased_wallet` | wallet | userId | `amount`, `gym_id`, `plan_type` |
| `partner_payout_recorded` | wallet | partnerId | `amount` |
| `gym_created` | gym | partnerId | `gym_id`, `city`, `session_price` |
| `gym_approved` | gym | partnerId | `gym_id`, `city` |
| `gym_rejected` | gym | partnerId | `gym_id`, `city` |
| `attendance_verified` | booking | customerId | `booking_id`, `gym_id`, `method` (`qr_scan` / `qr_geofence_self`) |
| `staff_account_created` | auth | actorId | `newUserId`, `gobhiType` |
| `staff_account_revoked` | auth | actorId | `targetUserId` |
| `staff_account_reactivated` | auth | actorId | `targetUserId` |
| `buddy_profile_created` | buddy | userId | — |
| `buddy_swiped` | buddy | swiperId | `action` |
| `buddy_matched` | buddy | swiperId | `matchId`, `otherUserId` |
| `buddy_unmatched` | buddy | userId | `matchId` |
| `buddy_message_sent` | buddy | userId | `matchId` |
| `buddy_blocked` | buddy | userId | `targetUserId` |

**Retired (historical rows only, do not emit going forward):** `subscription_order_created` and `subscription_purchased` — the two-step Razorpay subscription flow was replaced by a single wallet-debit step on 2026-07-22 (commit `b8c7251`), now emitted as `subscription_purchased_wallet`. Any query spanning that date needs to account for both name sets or it will silently undercount.

### Client-emitted (intent)

| Event | App | When |
|---|---|---|
| `otp_requested` | both | Send-OTP tapped (`is_login`) |
| `otp_submitted` | both | Verify-OTP tapped |
| `screen_viewed` | both | Every route push (`screen_name`) |
| `search_performed` | customer | Search query ≥ 2 chars (`query`) |
| `gym_viewed` | customer | Booking screen opened for a gym (`gym_id`) |
| `slot_selected` | customer | Slot chosen (`start_time`) |
| `book_tapped` | customer | Book button (`gym_id`, `amount`, `start_time`) |
| `topup_tapped` | customer | Top-up initiated (`amount`) |
| `onboarding_started` | partner | Wizard opened (`resumed_at_step`) |
| `onboarding_step_completed` | partner | Each step (`step` 1–4, `gym_id` at 3) |
| `onboarding_gym_photo_added` | partner | Photos picked (`count`) |
| `onboarding_doc_added` | partner | Docs picked (`count`) |
| `onboarding_submitted` | partner | Final submit (`gym_id`, `photo_count`, `doc_count`) |
| `checkin_tapped` | customer | Self-check-in button tapped (`gym_id`) |
| `session_started` | both + web | App/site cold start (`session_id` in every subsequent event's properties, not a top-level column) |
| `session_ended` | both + web | Best-effort, fired on app backgrounding / page unload — may not always land; compute session length from `max(ts)-min(ts)` per `session_id` regardless |
| `cta_clicked` | website | Marketing-site CTA tap, `cta` identifies which one |

Defined in `phool-gobhi-partner-app`'s `AnalyticsEvents` but **not yet wired to
any call site** as of 2026-07-23 — reserved names, not currently emitted:
`gym_image_uploaded`, `gym_doc_uploaded`, `gym_profile_updated`,
`dashboard_viewed`, `booking_checked_in`.

Every event also carries `source` (`server`/client implicit), `service`/`app`,
and `platform`. Client events additionally carry `session_id` (see above).

---

## 5. The funnels

1. **Activation** — `otp_requested` → `otp_submitted` → `signup_completed`
   (new) / `login_completed`.
2. **Conversion / GMV** — `gym_viewed` → `slot_selected` → `book_tapped` →
   `booking_confirmed`. Branch: `booking_failed` (by `reason`).
3. **Fulfillment** — `booking_confirmed` → `checkin_requested` →
   `booking_completed`. Measures real attendance / no-show.
4. **Supply (partner)** — `onboarding_started` → `onboarding_step_completed`
   (1→2→3→4) → `gym_created` → `gym_approved`.
5. **Wallet** — `topup_tapped` → `wallet_topup_order_created` →
   `wallet_topup_succeeded`. Branch: `wallet_topup_failed`.
6. **Approval SLA** — time between `gym_created` and `gym_approved` (or
   `gym_rejected`) — a self-join on `analytics_events` by `gym_id`, no schema
   change needed since both events carry `gym_id` and a `ts`.
7. **Buddy engagement** — `buddy_profile_created` → `buddy_swiped` →
   `buddy_matched` → `buddy_message_sent`. Negative-signal branches:
   `buddy_unmatched`, `buddy_blocked`.
8. **Subscriptions** — as of 2026-07-22, a single step: `subscription_purchased_wallet`
   (wallet-debit purchase, no separate order/verify events). Rows before that
   date use the retired `subscription_order_created` → `subscription_purchased`
   two-step names — see the retired-events note in §4.

In PostHog: Product → Funnels → add these events as ordered steps, breakdown by
`role` / `city` / `platform` as needed.

---

## 6. Configuration

### Backend (per service env var)

| Var | Values | Notes |
|---|---|---|
| `ANALYTICS_PROVIDER` | `none` · `console` · **`postgres`** (active) · `posthog` | set on every service **and the gateway** |
| `ANALYTICS_DATABASE_URL` | Postgres connection string | required for `postgres`; a dedicated Neon DB, separate from any service's operational DB |
| `ANALYTICS_SERVICE_NAME` | `auth-service`/`booking-service`/…/`gateway` | tags the event source |
| `POSTHOG_API_KEY` / `POSTHOG_HOST` | — | only for the `posthog` sink; not currently used — first-party Postgres is the deliberate choice (free, self-owned) |

The `analytics_events` table is created automatically on first write
(`CREATE TABLE IF NOT EXISTS`), so there's no migration to run.

The gateway's `/api/events` route additionally validates every client-sent
event name against `docs/analytics-events.json` (silently drops anything not
listed, still returns `202`) and rate-limits at 60 req/min/IP — see §1's link
to `scripts/check-analytics-events.cjs` for keeping that registry current.

### Apps (build-time `--dart-define`)

```
flutter run \
  --dart-define=ANALYTICS_PROVIDER=firstparty   # posts to <gateway>/api/events
# or =console (dev logs), =none (off), =posthog (+ POSTHOG_KEY)
```

Default is unconditionally **`firstparty`** (not gated on debug/release — a
debug-mode run silently no-op'ing into `console` only was how the partner
app's telemetry went unnoticed for weeks; see §7). Debug builds still print a
local `[analytics] ...` line alongside the real POST, so nothing is lost for
local development. `posthog`/`firstparty` downgrade to no-op if their required
config is missing.

---

## 7. Turning it on

First-party Postgres is the deliberate, ongoing choice (free, self-owned) —
not PostHog. It's on for every service in both environments.

1. Backend: `ANALYTICS_PROVIDER=postgres` + `ANALYTICS_DATABASE_URL` (the
   dedicated analytics Neon DB) + `ANALYTICS_SERVICE_NAME` set on every
   `*-dev` and `*-prod` Cloud Run service and the gateway. Env-var-only,
   redeploy via `/deploy <service> <env>` (Step 0 of which runs the drift
   checker in §1).
2. Apps: the default is already `firstparty` (see §6) — no build flag needed,
   though the Makefiles pass `--dart-define=ANALYTICS_PROVIDER=firstparty`
   explicitly anyway, to document intent and allow a one-off override.
3. Website: `AnalyticsBootstrap` (mounted in `app/layout.tsx`) posts to the
   site's own `/api/events` route, which proxies to the gateway.
4. Build/consult the funnels in §5 via the admin portal's `/analytics` page,
   or the SQL in §8 directly.

**Historical note:** the partner app's client-side telemetry never actually
reached this table for weeks, because the old default (`console` in debug,
`firstparty` only in `--release`) meant ordinary `flutter run` testing was
silently discarded. Fixed 2026-07-23 by making `firstparty` unconditional.

To verify locally, set `ANALYTICS_PROVIDER=console` and watch the
`[analytics] <event> {…}` lines in service logs / `flutter run` output; or run
`node scripts/analytics-digest.cjs` / `/analytics-digest` against a real DB.

---

## 8. First-party store & funnel SQL (active)

Events land in one append-only table (created automatically):

```sql
CREATE TABLE analytics_events (
  id          BIGSERIAL PRIMARY KEY,
  event       TEXT NOT NULL,
  distinct_id TEXT,
  properties  JSONB NOT NULL DEFAULT '{}',
  source      TEXT,          -- 'server' | 'client'
  service     TEXT,          -- auth-service / gym-service / gateway / jim_customer / ...
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- **Server events** are inserted in-process by each service's `track()`.
- **Client events** POST to the gateway `POST /api/events`
  (`{event, distinct_id, properties}`), which calls `ingest()` → same table.
- Identity stitching: the app sends an `identify` event carrying
  `anon_distinct_id`; join pre-login anon events to the user via that mapping.

### Admin dashboard (preferred over ad-hoc SQL)

`phool-gobhi-admin`'s `/analytics` page covers all six funnels in §5 plus the
approval-SLA run-rate, reading from `services/booking-service/services/
analyticsQueryService.js` — a second, dedicated `pg.Pool` on
`ANALYTICS_DATABASE_URL` (separate from booking-service's own operational
Prisma DB), exposed at `GET /api/bookings/admin/analytics/*`
(`onboarding-funnel`, `approval-sla`, `conversion-funnel`, `fulfillment-funnel`,
`activation`, `wallet-funnel`, `buddy-funnel`, `trend?metric=&days=`), all
`requireRole('gobhi')`. The sample queries below are for anything not yet
covered there, or quick one-off checks.

### Sample funnel queries

Booking conversion (last 30 days), per step:
```sql
SELECT event, count(DISTINCT distinct_id) AS users
FROM analytics_events
WHERE event IN ('gym_viewed','slot_selected','book_tapped','booking_confirmed')
  AND ts > now() - interval '30 days'
GROUP BY event
ORDER BY array_position(
  ARRAY['gym_viewed','slot_selected','book_tapped','booking_confirmed'], event);
```

Partner onboarding drop-off by step:
```sql
SELECT properties->>'step' AS step, count(*) AS completions
FROM analytics_events
WHERE event = 'onboarding_step_completed'
GROUP BY 1 ORDER BY 1;
```

Activation (signups vs OTP requests) this week:
```sql
SELECT event, count(*) FROM analytics_events
WHERE event IN ('otp_requested','signup_completed','login_completed')
  AND ts > now() - interval '7 days'
GROUP BY event;
```

A BI dashboard (Metabase/Grafana/PostHog-on-the-table) over `analytics_events` is
the natural next step — the schema is intentionally generic so any of them fits.

### Switching providers

`ANALYTICS_PROVIDER` is the only lever. `posthog` (set `POSTHOG_API_KEY`) sends to
PostHog instead; `none` turns everything off. No call sites change — that's the
point of the facade.

---

## 9. Privacy

- Only `userId` identifies a person; no phone/email/name in properties.
- PostHog offers an EU region; self-hosting (open source) is the fallback if
  Indian data residency becomes mandatory.
- A consent gate can wrap `AnalyticsService` (return the no-op sink until the user
  accepts) without touching call sites.
