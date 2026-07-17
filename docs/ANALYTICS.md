# Phool Gobhi — Eventing & Funnels

How product events are captured across the Flutter apps and the Node backend, and
how they roll up into the funnels that matter for the business.

> **Status:** instrumentation shipped (backend + both apps). The **active sink is
> first-party Postgres** — events are written to an `analytics_events` table we
> own (no third party). Server events write directly; client events POST to the
> gateway `/api/events` route. PostHog remains a drop-in alternative. A dashboard
> over the table is a future step; query funnels with the SQL in §8 meanwhile.

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
| `gym_created` | gym | partnerId | `gym_id`, `city`, `session_price` |
| `gym_approved` | gym | partnerId | `gym_id`, `city` |

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

Every event also carries `source` (`server`/client implicit), `service`/`app`,
and `platform`.

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
   `wallet_topup_succeeded`.
6. **Approval SLA** — time between `gym_created` and `gym_approved`.

In PostHog: Product → Funnels → add these events as ordered steps, breakdown by
`role` / `city` / `platform` as needed.

---

## 6. Configuration

### Backend (per service env var)

| Var | Values | Notes |
|---|---|---|
| `ANALYTICS_PROVIDER` | `none` · `console` · **`postgres`** (active on dev) · `posthog` | set on every service **and the gateway** |
| `ANALYTICS_DATABASE_URL` | Postgres connection string | required for `postgres`; the shared event store (any Neon DB; currently the booking DB — point at a dedicated DB later) |
| `ANALYTICS_SERVICE_NAME` | `auth-service`/`booking-service`/…/`gateway` | tags the event source |
| `POSTHOG_API_KEY` / `POSTHOG_HOST` | — | only for the `posthog` sink |

The `analytics_events` table is created automatically on first write
(`CREATE TABLE IF NOT EXISTS`), so there's no migration to run.

### Apps (build-time `--dart-define`)

```
flutter run \
  --dart-define=ANALYTICS_PROVIDER=firstparty   # posts to <gateway>/api/events
# or =console (dev logs), =none (off), =posthog (+ POSTHOG_KEY)
```

Default: `console` in debug, **`firstparty` in release** (uses the app's existing
gateway base URL — no extra config). `posthog`/`firstparty` downgrade to no-op if
their required config is missing.

---

## 7. Turning it on

Costs nothing at our scale (PostHog free tier ≈ 1M events/month; ~5k users ×
~50 events ≈ 250k/mo).

1. Create a free PostHog account → project → copy the **Project API Key**.
2. Backend: set `ANALYTICS_PROVIDER=posthog`, `POSTHOG_API_KEY=phc_…` on every
   `*-prod` Cloud Run service + the gateway (dev already runs the first-party
   Postgres sink — see §8). Redeploy via `/deploy <service> prod`.
3. Apps: build with the `--dart-define`s above (wire them into the flavor build
   scripts / CI).
4. Build the funnels in §5 in the PostHog UI.

To verify locally without PostHog, set `ANALYTICS_PROVIDER=console` and watch the
`[analytics] <event> {…}` lines in service logs / `flutter run` output.

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
