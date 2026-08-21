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

**Shared-device caveat:** the anon id lives in browser `localStorage` /
`SharedPreferences`, scoped to the *device*, not the person. If two different
people use the same device before either logs in, they're indistinguishable
in the data — same anon id, merged history. `reset()` on logout mints a fresh
anon id specifically so the *next* person on a shared device doesn't inherit
the previous one's identity, but two people who never log in/out in between
can't be split apart after the fact. No fix short of forcing login or device
fingerprinting (deliberately not pursued — DPDP compliance risk) closes this.

**Internal-traffic opt-out:** staff testing devices can be excluded from
writing to `analytics_events` at all (not just filtered out downstream) via a
persisted `analytics_excluded` flag, checked at the top of every client's
send path before it ever reaches `/api/events`:
- Website: visit `?notrack=1` once (sets `pg_analytics_excluded` in
  `localStorage`); `?notrack=0` clears it. See `lib/analytics.ts`.
- Customer app: the `phoolgobhi://notrack` deep link (`?off=1` clears),
  handled by `DeepLinkService` alongside the poster-QR check-in link — the
  mobile equivalent of the website's query param, since there's no URL bar.
- Partner app: no deep-link scheme exists in this app, so the equivalent
  entry point is 7 taps on the "App Version" row in Settings (the standard
  hidden dev-mode gesture), which opens a toggle dialog.
- Partner-web: not applicable — this app sends no analytics events at all.

The flag is hydrated once at startup (`loadAnalyticsExcludedFlag`) and takes
effect immediately when toggled, no restart needed either way.

---

## 4. Event dictionary

Naming: `snake_case`, `noun_verb`, past tense for completed actions. **Names are
stable contracts — renaming a shipped event breaks historical funnels.**

### Server-emitted (truth)

| Event | Service | distinct_id | Key properties |
|---|---|---|---|
| `signup_completed` | auth | userId | `role`, `user_type`, `linked_gym_id` (attendance-SaaS wedge — non-null only on a genuine new signup via a gym's /join link) |
| `login_completed` | auth | userId | `role`, `user_type`, `linked_gym_id` (always the account's existing value, if any — set once at signup, never changes on login) |
| `attendance_saas_reengagement_sent` | auth | userId | `linked_gym_id`, `had_fcm_token` — fired by the scheduled re-engagement sweep, once ever per user |
| `booking_confirmed` | booking | customerId | `booking_id`, `gym_id`, `amount`, `date`, `start_time` |
| `booking_failed` | booking | customerId | `gym_id`, `reason` (`slot_full`/`insufficient_balance`), `amount` |
| `booking_cancelled` | booking | customerId | `booking_id`, `gym_id`, `amount`, `date` |
| `booking_completed` | booking | customerId | `booking_id`, `gym_id`, `amount`, `date` |
| `referral_credited` | booking | customerId | `booking_id`, `referrer_id` |
| `checkin_requested` | booking | customerId | `booking_id`, `gym_id`, `location_verified` |
| `wallet_topup_order_created` | wallet | userId | `amount`, `order_id` |
| `wallet_topup_succeeded` | wallet | userId | `amount`, `order_id`, `via` (`webhook` if async) |
| `wallet_topup_failed` | wallet | userId | `amount`, `order_id` |
| `subscription_purchased_wallet` | wallet | userId | `amount`, `gym_id`, `plan_type`, `city`, `linked_gym_id` (attendance-SaaS wedge — non-null only when this purchase is at the buyer's own linked gym, i.e. the actual join→register conversion step, not just any subscription sale) |
| `partner_payout_recorded` | wallet | partnerId | `amount` |
| `gym_created` | gym | partnerId | `gym_id`, `city`, `session_price` |
| `gym_approved` | gym | partnerId | `gym_id`, `city` |
| `gym_rejected` | gym | partnerId | `gym_id`, `city` |
| `attendance_verified` | booking | customerId | `booking_id`, `gym_id`, `method` (`qr_scan` / `qr_geofence_self`) |
| `staff_account_created` | auth | actorId | `newUserId`, `gobhiType` |
| `staff_account_revoked` | auth | actorId | `targetUserId` |
| `staff_account_reactivated` | auth | actorId | `targetUserId` |
| `trainer_account_created` | auth | partnerId | `trainerId`, `gymId` |
| `trainer_account_deactivated` | auth | partnerId | `trainerId`, `gymId` |
| `trainer_account_reactivated` | auth | partnerId | `trainerId`, `gymId` |
| `trainer_checked_in` | booking | trainerId | `gym_id`, `date` |
| `training_session_logged` | booking | trainerId | `gym_id`, `booking_id`, `customer_id` |
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
| `referral_shared` | customer | Share your code tapped on Refer & Earn |
| `onboarding_started` | partner | Wizard opened (`resumed_at_step`) |
| `onboarding_step_completed` | partner | Each step (`step` 1–4, `gym_id` at 3) |
| `onboarding_gym_photo_added` | partner | Photos picked (`count`) |
| `onboarding_doc_added` | partner | Docs picked (`count`) |
| `onboarding_submitted` | partner | Final submit (`gym_id`, `photo_count`, `doc_count`) |
| `checkin_tapped` | customer | Self-check-in button tapped (`gym_id`) |
| `session_started` | both + web | App/site cold start (`session_id` in every subsequent event's properties, not a top-level column) |
| `session_ended` | both + web | Best-effort, fired on app backgrounding / page unload — may not always land; compute session length from `max(ts)-min(ts)` per `session_id` regardless |
| `cta_clicked` | website | Marketing-site CTA tap, `cta` identifies which one |
| `dashboard_viewed` | partner | Home dashboard opened (`HomeScreenTwo.initState`) |
| `gym_image_uploaded` | partner | Gym photo added on the Edit tab (`gym_id`, `pending`) |
| `gym_doc_uploaded` | partner | Verification doc added on the Edit tab (`gym_id`, `pending`) |
| `gym_profile_updated` | partner | Gym edit form saved (`gym_id`, `pending`) |
| `booking_checked_in` | partner | QR scan verifies attendance (`gym_id`, `booking_id`, `method` = `qr_scan`/`qr_scan_slot_shift`, `already_verified`) — client-side echo of the same moment `attendance_verified` fires server-side |
| `gym_switched` | partner | Partner selects a different gym from the multi-gym switcher (`gym_id`, `gym_count`) — only on an actual change, not re-selecting the active gym |
| `gym_class_created` | partner | Recurring class created on the Classes tab (`gym_id`, `pending`) |
| `schedule_slot_blocked` | partner | A slot block toggled on/off (`gym_id`, `action` = `blocked`/`unblocked`, `pending`) |
| `schedule_hours_updated` | partner | Operating-hours editor saved (`gym_id`, `pending`) |
| `logout_tapped` | partner | Sign-out confirmed in Settings, fired just before the session actually resets |

**Added 2026-08-17:** `dashboard_viewed`, `gym_image_uploaded`, `gym_doc_uploaded`,
`gym_profile_updated`, and `booking_checked_in` were defined in the partner
app's `AnalyticsEvents` back on 2026-07-23 but had **no call site** — reserved
names that never actually fired, so nothing about gym-management or QR
check-in activity ever reached `analytics_events` despite being reservable in
the admin dashboard's event search. All five are now wired. `gym_switched`,
`gym_class_created`, `schedule_slot_blocked`, and `schedule_hours_updated` are
new: multi-gym switching in particular had zero analytics coverage even though
it's the partner app's newest major feature (see the platform's multi-gym
support work) — the switcher sheet is one of the most-used surfaces for any
partner running more than one gym, and it was previously invisible in the
data entirely.

Every event also carries `source` (`server`/client implicit) and `service`/`app`.
Client events additionally carry `session_id` (see above) and the
device/platform properties below (added 2026-07-31 — see §9 for the privacy
note on `ip`):

| Property | Set by | Notes |
|---|---|---|
| `platform` | apps (`android`/`ios` via `Platform.operatingSystem`), website (static `web`) | |
| `os_version` | apps (Android `AndroidDeviceInfo.version.release`, iOS `IosDeviceInfo.systemVersion`) | absent on website — see `os_name` below |
| `device_model` | apps (Android `.model`, iOS `utsname.machine`, e.g. `"iPhone14,5"`) | iOS uses the specific hardware id, not the generic `.model`, to distinguish device generations — needs a lookup table to become human-readable |
| `device_manufacturer` | apps (Android `.manufacturer`, iOS hardcoded `'Apple'`) | |
| `app_version` / `app_build_number` | apps, via `package_info_plus` | |
| `device_language` | apps, via `Platform.localeName` | kept for historical continuity with existing rows/dashboards — see `system_language` below for the same value under its explicit name |
| `system_language` | apps, via `Platform.localeName` (added 2026-08-17, partner app only so far) | the OS locale, read fresh at send time — identical value to `device_language`, added under an explicit name alongside `app_language` |
| `app_language` | apps (added 2026-08-17, partner app only so far) | the language the app is actually rendering in. Partner app has no in-app language picker yet (English-only, hardcoded strings) so this is currently always `'en'` — kept as its own property so the schema doesn't need to change the day a real language switcher ships |
| `app_theme` | apps (`'dark'`/`'light'`), static flag kept in sync by each app's `ThemeProvider` | the app's active theme choice — may diverge from `system_theme` once a user manually overrides it |
| `system_theme` | apps (`'dark'`/`'light'`, added 2026-08-17, partner app only so far), via `PlatformDispatcher.instance.platformBrightness` read fresh at send time | the OS's live brightness setting, independent of any in-app override — distinct from `app_theme` specifically to catch drift between the two |
| `user_agent` | website (forwarded from the request's `User-Agent` header) | raw string |
| `os_name` / `browser_name` / `browser_version` / `device_type` | gateway, parsed from `user_agent` via `ua-parser-js` | **backstop only** — the gateway fills these only when the event doesn't already carry them, so it never overwrites the richer app-supplied fields above; this is the primary source of OS/browser info for website traffic |
| `ip` | gateway, from `req.ip` | every client event, via the gateway's `/api/events` handler |

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
9. **Attendance-SaaS wedge (gym-linked signup → paid registration)** —
   `signup_completed` where `linked_gym_id` is non-null → `subscription_purchased_wallet`
   where `linked_gym_id` is non-null, joined on `distinct_id`. No separate
   "joined the /join page" step is captured server-side (that's a client page
   view, not a truth event) — this measures signup-to-paid-registration only,
   not top-of-funnel page traffic. `attendance_saas_reengagement_sent` marks
   the scheduled nudge sent to signups still inactive after
   `REENGAGEMENT_AFTER_DAYS` (env, default 3) — a re-entry point into the
   same funnel, not a step within it.

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

The same route also enriches every accepted event with the `ip`/`user_agent`/
parsed-UA properties described in §4, via the `ua-parser-js` dependency — no
new env var needed for this.

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

Both apps depend on `device_info_plus` and `package_info_plus` to populate
the `os_version`/`device_model`/`device_manufacturer`/`app_version`/
`app_build_number` properties in §4 — fetched once at startup (`setupLocator`,
alongside the existing `SharedPreferences` await) and cached, so `_baseProps()`
stays a synchronous function.

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

Every funnel tab (except Activation, whose steps are alternative outcomes —
new signup vs. returning login — not a strict sequence) also shows a
drop-off table alongside its chart: count, % of the previous step, and % of
the top of the funnel, computed client-side from the same counts the chart
uses (`lib/analyticsLabels.ts`'s `withDropoff`) rather than a second query.

Three more tabs:

- **By City** (`?view=city`, `GET /admin/analytics/city-breakdown`) — gyms
  submitted/approved and bookings/GMV, per city. Needs no join back to the
  gym table since `city` is already denormalized onto booking events (§4).
- **Revenue** (`?view=revenue`, `GET /admin/analytics/revenue-trend`) — daily
  GMV and booking-count trend lines (two separate charts, deliberately not
  one dual-axis chart — see the `dataviz` skill's "one axis" rule).
- **User Journey** (`?view=user`, `GET /admin/analytics/user-journey?distinctId=&days=`)
  — looks up every event for one `distinct_id`, client and server interleaved
  chronologically rather than split into separate feeds. Detects session
  boundaries by watching `properties->>'session_id'` change between
  consecutive rows (server events carry none, so they render inline without
  resetting it), and best-effort resolves a numeric `distinct_id` to a real
  name/phone via auth-service's existing internal lookup — fails open to
  "unknown identity" for anon ids or a lookup failure.
- **Recent anonymous sessions** (same `?view=user` tab, `GET /admin/analytics/anon-sessions?days=&limit=`)
  — the only way to *find* a pre-signup journey to look up in the first
  place, since the search box above only resolves a phone number or an
  already-known `distinct_id` and anon visitors have neither on record. Lists
  the most recently active `anon_...` distinct_ids (grouped, most recent
  first) with first/last seen, event and session counts, and a cheap preview
  of their most recent app + screen — click a row to open its full journey.
- **Event search** (`?view=user`, `GET /admin/analytics/event-search?event=&filters=&days=&limit=`)
  — "which users did X" rather than "what did user X do." `filters` is a JSON
  object of exact-match property filters (e.g. `{"screen_name":"/gyms"}`).
  Groups by `distinct_id`, most recently active first; each row opens straight
  into the journey view, same as the anon-sessions list.
- **Custom funnels** (`?view=user`, saved via `GET/POST /admin/analytics/funnels`,
  `DELETE /admin/analytics/funnels/:id`, run via `GET /admin/analytics/custom-funnel?funnelId=|steps=&days=`)
  — admin-defined funnels, persisted in `SavedFunnel` (booking-service's own
  Prisma DB, *not* `analytics_events`). Unlike every hardcoded funnel above
  (independent per-event counts in the same window), this one enforces real
  step order: `getCustomFunnel` chains one CTE per step, each joining the
  previous step's surviving `distinct_id`s against a *later* occurrence of
  its own event — step N only counts someone if step N-1 happened first, for
  them specifically. Each step can carry its own exact-match property
  filters. `custom-funnel` accepts either a saved `funnelId` or an ad-hoc
  `steps` JSON array (both validated by the same `savedFunnelService.validateSteps`
  gate, 2-8 steps) so you can preview before saving.
- **Suggestion sources** for the event-search and custom-funnel builders —
  mirrors CleverTap's segment builder's event→property→value cascade rather
  than free-text filter inputs: `GET /admin/analytics/known-events?limit=`
  (real event names that have actually occurred, most frequent first — not a
  hardcoded schema), `GET /admin/analytics/known-properties?event=&limit=`
  (that event's actual property keys via `jsonb_object_keys`, minus
  `ip`/`user_agent`/`session_id` as noise — not useful filter dimensions),
  and `GET /admin/analytics/known-values?event=&key=&limit=` (that
  event+key's actual distinct values with counts, most common first). None
  of these three write anything; they're read-only autocomplete sources the
  admin UI calls live as you build a filter.

A fourth addition, **Supply health** (`GET /admin/analytics/supply-health`),
is folded into the existing Supply tab rather than a tab of its own: gyms
approved more than 7 days ago with their real booking count since, surfacing
"dead weight" supply (approved but never actually converting) — the thing
that matters more than raw approval throughput when the launch bottleneck is
active supply, not paperwork.

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
- Device model, OS/app version, and language (§4) are not treated as PII —
  they identify a device/build, not a person.
- **`ip` (added 2026-07-31) is a deliberate exception to "no PII"** — raw
  client IP is personal data under DPDP. It's captured because it was an
  explicit product decision (not a silent default), to enable future
  city/country-level breakdowns. Anyone building on top of `analytics_events`
  should treat `properties->>'ip'` with the same care as the `userId` column —
  in particular, be deliberate about who can see it in internal tooling that
  surfaces raw event detail (e.g. the admin dashboard's per-user "User
  Journey" view). No retention policy exists yet for this column specifically;
  it inherits whatever retention the rest of `analytics_events` has (none,
  currently — flagged here as a gap to revisit, not solved by this change).
- PostHog offers an EU region; self-hosting (open source) is the fallback if
  Indian data residency becomes mandatory.
- A consent gate can wrap `AnalyticsService` (return the no-op sink until the user
  accepts) without touching call sites.
