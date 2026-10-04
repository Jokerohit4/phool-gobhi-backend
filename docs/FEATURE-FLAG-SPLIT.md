# Feature-flag split — `healthMetrics` → `workoutTracking` / `healthMetrics` / `healthVault`

Status: **implemented in code, not deployed.** The registry, the route split, the client gates and
the admin portal all exist on `dev` working trees. Two things have deliberately NOT happened: the
config backfill (§8 step 6) and any deploy. Until the backfill runs, `workoutTracking` is absent
from every stored config and resolves `false` — which is exactly why the transitional shim in
`health-service/middleware/requireFeatureFlag.js` still exists and must not be deleted yet.

Author: retention/health audit, 2026-10-04.
Last reconciled: 2026-10-04, after implementation and test runs.

§1-§11 are the original proposal, retained as the rationale and the record of what was decided.
Where implementation diverged from it, the divergence is marked inline and summarised in §12.

---

## 1. The problem, stated once

`healthMetrics` is a single boolean gating ~15 features across `health-service`, including both
the workout logging engine (the product's proposed daily hook) and the Local Health Vault
(PDF upload of medical reports — the most consent-sensitive surface in the app).

Consequences observed in the audit:

- **The daily hook cannot ship independently.** `workoutTracking` does not exist as a flag.
  Enabling the workout engine also enables medical-report upload.
- **Visible UI with dead API is possible.** `home_screen.dart:171` and `:179` render
  `TodaySessionCard` and `WorkoutQuickActions` unconditionally, while every endpoint they
  call (`workout_api_data_source.dart:89-335` → `/api/health/{exercises,templates,sessions,progress}`)
  sits behind `health.js:54`'s `gated` array. `today_session_card.dart:54-68` reads the flag
  but only to choose a wrapper — the gate is present yet scoped to an enhancement rather
  than the surface.
- **Flag default drift.** `healthMetrics` reads like a display toggle but is the workout
  engine's master switch. The accurate definition is buried in a client comment
  (`app_config_model.dart:32-35`) where no operator would look.
- **`cycleTracking` cannot be honoured client-side.** It exists server-side
  (`health.js:128-138`) and in the admin portal, but `AppConfigModel` has no
  `cycleTrackingEnabled` field, so any cycle UI would 403 with no client guard.
- **`runTracker` has no portal toggle.** `updateFeatureFlagsAction` (`app/settings/actions.ts:196-229`)
  writes 17 flags; `runTracker` is not one. It is the only flag `false` in dev and is
  unreachable from the admin portal. `actions.ts:211-216` describes exactly this anti-pattern
  as the reason `healthLedger` got a toggle.
- **Four copies of the flag defaults**, no shared schema, no contract test:
  `authController.js:261`, `app_config_model.dart:122-158` + `notRequired()` at `:163-188`,
  `app/settings/page.tsx:103-120`, `app/gamification/coins/page.tsx:31-33`.
- **No history.** `AppVersionSetting` carries `updatedAt`/`updatedBy` but no transition log,
  unlike `AppModeHistory` which records `fromMode`/`toMode`/`source` per change.

---

## 2. Target taxonomy

Grouped by lifecycle, because the current flat namespace conflates three incompatible jobs
(release sequencing / legal consent gating / ops kill-switch).

### TRAINING — shippable standalone

| Flag | Gates | DPDP class |
|---|---|---|
| `workoutTracking` | exercise library, routines, sessions, sets, progress summary, muscle readiness | low (training log, equivalent to Strong/Hevy) |

No dependencies. This is the daily hook and must be independently switchable.

### HEALTH — derived scores and biomarker capture

| Flag | Gates | Notes |
|---|---|---|
| `healthMetrics` *(narrowed)* | blended health score, behavioural + biological breakdown, biomarker snapshot, health profile | now honestly named; depends on `workoutTracking` because the behavioural component blends training data |
| `healthVault` | report upload, pending extractions, verify | **standalone** — see §3 |

### HEALTH SUB-FEATURES — unchanged, existing dependency chains

| Flag | Requires |
|---|---|
| `healthLedger` | `healthMetrics`, `healthLedger` (`ledger.js:33`) |
| `foodPhotoLogging` | + `foodPhotoLogging` (`ledger.js:108`) |
| `healthPersonalisation` | `healthMetrics`, `healthPersonalisation` (`health.js:83-87`) |
| `recapSharing` | `healthMetrics`, `recapSharing` (`health.js:88-92`) |
| `fitnessAssistant` | `healthMetrics`, `fitnessAssistant` (`health.js:105-109`) |
| `runTracker` | `healthMetrics`, `runTracker` (`health.js:116-120`) |
| `cycleTracking` | `healthMetrics`, `cycleTracking` (`health.js:128-138`) |

### GAMIFICATION / SOCIAL / SHELL — unchanged

`badges`, `streaksCoins`, `challenges`, `buddyPairedStreaks`, `buddy`, `brandedOnboarding`,
`homeTrackHome`, `nonPartnerAttendance`.

`maintenance.{wallet,gyms}` stays a separate windowed mechanism (`authController.js:405-415`).

### Net change

`healthMetrics` 1 flag → 3 flags (`workoutTracking`, narrowed `healthMetrics`, `healthVault`).

**As built, the registry holds 20 flags** — two more than this proposal anticipated, because
building the registry surfaced drift the proposal had not found:

- `referral` was already read by the client (`features['referral']`) and already live, but was
  never registered and never gated by anything.
- `fhirExport` has gated every export through `exportController` since ABHA Stage 0 and was
  declared nowhere, so it resolved `false` forever and no operator could reach it.

Client model: **19 boolean fields**, five of them new — `workoutTrackingEnabled`,
`healthVaultEnabled`, `healthPersonalisationEnabled`, `recapSharingEnabled` and the missing
`cycleTrackingEnabled`. `healthMetricsEnabled` already existed and kept its name; only its
meaning narrowed.

Public `GET /api/auth/app-config` returns **22 keys**: the 20 registry flags plus `otpProvider` and
`profileCompletionBonusAmount`, which are singleton settings (`OtpProviderSetting`,
`ProfileCompletionBonusSetting`) rather than flags and are edited on their own admin rows. The
contract test pins that exemption explicitly, so a third singleton cannot drift in unnoticed.

`fhirExport` is the one registered flag with no client surface (`clientKey: null`) — it is a
query-parameter branch on an existing route. A test asserts it is the *only* one, so a second such
flag has to be declared out loud.

---

## 3. Why `healthVault` must be standalone

`health.js:139-141` already establishes the precedent for this file:

> NOT flag-gated, same reasoning as DELETE /me: a user must always be able to delete their own
> data, even if the feature that collected it is switched off.

A vault that is only reachable while `healthMetrics` is on produces extracted biomarkers that
feed nothing when `healthMetrics` is off — and cannot be deleted or exported through the app.
Making it standalone keeps user-owned data reachable regardless of downstream consumption, which
is both the DPDP-correct behaviour and consistent with the reasoning already in the file.

Vault output feeding an off health score is acceptable: the data is the user's, captured for
them, visible and erasable in the app.

---

## 4. Structural fix: a flag registry as the single source of truth

Every recurring problem above (drift, unwritable flags, four copies of defaults, dropped keys)
traces back to the flag list being hand-maintained in five places. Replace the list with one
server-side registry and derive everything from it.

Proposed shape (`services/auth-service/config/featureFlagRegistry.js`):

```js
{
  name: 'workoutTracking',
  // Rendered as a toggle in the admin portal. Every registry entry gets one
  // automatically, which is what makes it impossible to add an unreachable flag again.
  portalToggle: true,
  // Client key in AppConfigModel. Also the admin form field name.
  clientKey: 'workoutTrackingEnabled',
  // Flags that must also be on. Emitted into requireFeatureFlag chains.
  deps: [],
  // Surfaced in the portal next to the toggle so whoever flips it knows what it turns on.
  blastRadius: 'Exercise library, routines, workout sessions, sets, progress, muscle readiness',
  // Drives the DPPA/DPDP classification in the consent copy.
  dataClass: 'training-log',
}
```

Consumers derive from the registry:

1. `DEFAULT_FEATURES` (`authController.js:261`) — built from registry, not hand-listed.
2. `getAppConfig` response — emits `schemaVersion` and `flags` from the registry.
3. Admin portal — renders toggles from `GET /api/auth/app-config/registry` (gobhi-only,
   alongside the existing `auth.js:68`).
4. `updateFeatureFlagsAction` — merges against the registry instead of listing 17 writes.
5. Contract test — asserts registry keys == client `AppConfigModel` keys.

### Response additions

```json
{
  "schemaVersion": 2,
  "features": { ... },
  "flagsKnown": ["workoutTracking", "healthMetrics", "healthVault", ...]
}
```

`schemaVersion` + `flagsKnown` solve the prod problem directly: prod today omits 8 keys that dev
returns, which means prod is running an `auth-service` revision whose `DEFAULT_FEATURES` had 10
entries. Because `app_config_model.dart` resolves a missing key via `?? false`, **"deliberately
off" and "server predates this flag" are indistinguishable** and both fail closed. With
`flagsKnown`, the client can log the difference in one line and a stale deploy stops masking itself.

---

## 5. Route gating changes

`health-service/routes/health.js` — replace the single `gated` array with three:

```js
const workoutGated = [requireAuth, requireAnyFeatureFlag('workoutTracking', 'healthMetrics')];
const metricsGated = [requireAuth, requireFeatureFlag('healthMetrics')];
const vaultGated  = [requireAuth, requireFeatureFlag('healthVault')];
```

**Naming and composition both differ from the proposal, deliberately.** The proposal called these
`trainingGated` / `healthGated` and made `healthGated` require *both* flags. Two reasons it is not
that:

1. `healthGated` was a bad name for a gate that ends up on consent, ledger-adjacent and export
   routes. The shipped names say which flag the route actually turns on: `workoutGated`,
   `metricsGated`, `vaultGated`, plus `consentGated` and `exportGated` for the routes that are
   reachable under any of several flags.
2. `metricsGated` does **not** yet require `workoutTracking`, even though the registry declares
   `healthMetrics → deps: [workoutTracking]`. Stored configs predate `workoutTracking`; requiring
   both today would resolve every health-metrics route to `false` the moment this deploys, i.e. the
   exact 403 wave §8 is written to prevent. The dependency is declared in the registry and enforced
   in the client (`AppConfigStore.healthMetricsVisible`), and the server catches up in the same
   change as the backfill.

The two gates are deliberately asymmetric during the transition, and the client is the stricter of
the two: `metricsGated` accepts `healthMetrics` alone, while the client requires `workoutTracking`
too. The client being stricter is the safe direction — nothing is shown that the server has not
caught up with — but it does mean the two sides will not agree until the backfill lands. Both
`app_config_model.dart` and `health.js` say so at the point of use.

Route reassignment, as built. The proposal cited `health.js` line numbers; those moved once the
file was edited, so this table keys on route paths, which do not:

| Routes | From | To |
|---|---|---|
| `/exercises`, `/exercises/:id`, `/exercises/:id/history`, `/templates`, `/sessions`, `/sessions/today`, `/sessions/:id`, `/sessions/:id/sets/:setId`, `/sessions/:id/exercises`, `/sessions/:id/exercise-sets` | `gated` | `workoutGated` |
| `/progress/summary`, `/progress/muscle-readiness`, `/exercise-records`, `/daily-activity` | `gated` | `workoutGated` |
| `/biometrics`, `/biometrics/latest`, `/biometrics/consent`, `/retention-policy` | `gated` | `metricsGated` |
| `/reports/upload`, `/reports/pending`, `/reports/verify` | `gated` | `vaultGated` |
| consent + export routes | `gated` | `consentGated` / `exportGated` |
| `/unlogged`, `/nudges`, `/stats`, `/goal`, `/consistency-streak`, `/plans`, `/suggestions/*`, `/insurer-grade` | `gated` | `workoutGated` |
| `ledger.js:33` ledger | unchanged | unchanged |
| `ledger.js:108` photo | unchanged | unchanged |

**Attendance is the one deliberate exception.** Its handler (`sessionController.js`) fans in
workout data, so it reads like a workout route, but the route itself is left ungated and the flag
is checked inside the handler instead. Attendance is a booking-integrity fact — a user checked in
to a gym they paid for — not a training feature, so gating its visibility on a workout toggle
would let a flag switch make already-recorded attendance invisible. `requireAnyFeatureFlag` exists
precisely so this handler can accept either flag without borrowing `workoutGated`'s name, which
would misdescribe it.

`routeSplitGates.test.js` asserts this whole matrix — 16 cases over the routes above, including the
attendance exception. It was mutation-checked: moving `/exercises` to `metricsGated` fails it.


`challenge-service/routes/challenges.js:11-29, 62-74`, `booking-service/routes/booking.js:126`,
`gym-service/routes/gym.js:46, 88` are unaffected.

---

## 6. Client changes

`lib/data/models/app_config_model.dart`

- add `workoutTrackingEnabled` (fail-closed `false`), `healthVaultEnabled` (fail-closed `false`),
  `healthPersonalisationEnabled` (fail-closed `false`), `recapSharingEnabled` (fail-closed `false`),
  and the missing `cycleTrackingEnabled`
- mirror all of them into `notRequired()` so the offline fallback matches the server defaults
- update the field doc comment, which misdescribed the scope

Two of the five beyond the original three (`healthPersonalisation`, `recapSharing`) were server
flags with no client field — the same class of gap as `cycleTracking`, found by writing the
contract test rather than by reading the server.

`lib/core/services/app_config_store.dart` — add extensions following the established pattern
(`RunTrackerFlag:27-35`, `HealthLedgerFlag:45-54`, `FoodPhotoFlag:62-67`):

```dart
extension WorkoutTrackingFlag on AppConfigStore {
  bool get workoutTrackingVisible => config?.workoutTrackingEnabled ?? false;
}
extension HealthVaultFlag on AppConfigStore {
  bool get healthVaultVisible => config?.healthVaultEnabled ?? false;
}
```

**Self-gate the workout UI.** The codebase already has this convention —
`home_health_section.dart:44`, `home_health_rings.dart:16`, `home_steps_summary_tile.dart:40`,
`streak_fab.dart:24` all self-gate so a caller never has to remember. Apply it to the two
currently-ungated entry points:

- `home_screen.dart:171` `TodaySessionCard()` → self-gate on `workoutTrackingVisible`
- `home_screen.dart:179` `WorkoutQuickActions()` → self-gate on `workoutTrackingVisible`
- also `home_track_home_screen.dart:72-73` and
  `linked_member_home_screen.dart:151-152` for consistency

`today_session_card.dart:54-68` should keep its `healthMetricsEnabled` check for the
`HomeHealthProvider` wrapper — that stays correct — but sit behind the new
`workoutTrackingVisible` check as well.

`lib/presentation/bloc/app_update/app_update_cubit.dart:39-79` — add the three new fields.

### The invariant that prevents recurrence

Self-gating each widget is the right immediate fix, but the durable fix is a check that cannot be
forgotten. Either:

- a widget-level lint/test that greps for `AppRoutes.routines` / `AppRoutes.activeWorkout` pushes
  and asserts the pushing file reads `workoutTrackingVisible`, or
- a shared `WorkoutTrackingGate` widget that both entry points must pass through.

Without one of these, the next ungated entry point reintroduces visible-UI-dead-API.

**Built, as a third option rather than either of the two above.** Both suggested shapes are
sound; neither is needed, because the router is already the single funnel every `pushNamed` and
every deep link passes through. So the gate went there:

- `AppRoutes._workoutRoutes` lists the 13 gated routes, and `generateRoute` returns
  `NotFoundScreen` for any of them when `AppConfigStore.workoutTrackingVisible` is false. The check
  sits *before* the `switch`, so it also runs before argument casting — a bare `/routines` deep link
  cannot throw its way past the gate.
- `test/app_routes_workout_gate_test.dart` asserts the list matches `lib/presentation/pages/workout/`.
  It fails if a workout route leaves the list, and equally if a route that is not a workout page
  joins it — the over-broad direction, which a grep for path strings cannot catch because the gate
  would then block a health screen.
- `test/workout_flag_widget_absence_test.dart` covers the two widgets in both flag states, plus the
  router gate itself and that the gate reads `workoutTracking` rather than `healthMetrics`.

Both suites were mutation-verified: dropping a route from the list fails the coverage test, adding
`healthDashboard` to it fails for being over-broad, and neutering the guard expression fails the
behavioural test.

The honest limit, which is why the widget-level gates stayed: this protects *navigation*. A widget
mounted outside the router is still gated only by itself, so `today_session_card.dart` and
`workout_quick_actions.dart` keep their own checks.


---

## 7. Admin portal changes

`app/settings/page.tsx` and `app/settings/actions.ts`

- replace the hand-maintained `FeatureFlags` interface (`:69-120`), `withFeatures()`, and the 17
  explicit writes (`actions.ts:196-229`) with a registry-driven render
- `updateFeatureFlagsAction` keeps the `...current.features` spread (`actions.ts:204`) — that
  spread fixed a real incident and the scar-comment at `:197-203` should stay — but the write list
  becomes registry-derived, so it cannot fall behind again
- `app/gamification/coins/page.tsx:31-33` drops its fourth copy of the defaults and reads the
  registry; it keeps its own toggle for `streaksCoins` (`:84`) since placing that kill-switch next
  to the coin numbers is good design
- `runTracker` gains a toggle automatically

Also worth fixing while in there: `updateAppConfigAdmin` (`authController.js`) does a blind
whole-blob replace with no schema validation. Two pages write the same blob from load-then-spread
reads, so a stale-read clobber between them is possible. It fails safe (→ `false`) but silently.

**Fixed.** The write still passes `req.body.config` into the upsert, but `validateFeaturePayload`
now rejects an unknown flag name, a non-object flag value, or a non-boolean `enabled` with a 400
*before* persistence. The audit half had already landed: every save diffs the previous blob against
the new one and writes one `AppConfigHistory` row listing only the flags that moved, best-effort so
a failed audit insert cannot fail a save that already succeeded.

The validator lives in `config/featureFlagRegistry.js` rather than here, and that placement is the
point: the admin route, the contract tests and `scripts/seedFeatureFlags.js` all call the same
function, so an ops script cannot write a payload the API would reject. `otp` and
`profileCompletionBonus` are allowed through, since the portal round-trips them inside `features`
even though they are singleton settings rather than gates.


---

## 8. Rollout order

The order is load-bearing. Flipping to the new taxonomy while `healthMetrics: true` is live will
403 the workout engine the moment `healthMetrics` is narrowed.

| # | Step | Safe because |
|---|---|---|
| 1 | Add registry, `schemaVersion`, `flagsKnown`, `AppConfigHistory`. No route or client change. | Purely additive; clients ignore unknown response keys. |
| 2 | Deploy backend + both clients. | No behaviour change. |
| 3 | Add `workoutTracking` and `healthVault` to the registry, both defaulting to `false`. | Nothing gated on them yet. |
| 4 | Add a **transitional shim** to `requireFeatureFlag.js`: `requireAnyFeatureFlag(['workoutTracking','healthMetrics'])` and repoint the training routes at it. | During the shim, either flag satisfies the route, so narrowing `healthMetrics` cannot 403 the workout engine. |
| 5 | Client: add flags, self-gate the four workout entry points. Deploy. | With `workoutTracking: false`, workout UI correctly disappears instead of 403ing. |
| 6 | Backfill the config blob per environment: `workoutTracking = <old healthMetrics value>`, `healthVault = false`. | Restores current behaviour exactly. |
| 7 | Flip training routes to `workoutTracking` only; delete the shim. | `workoutTracking` already mirrors the old value. |
| 8 | Narrow `healthMetrics` to health-only routes (`healthGated`). | Workout engine no longer depends on it. |
| 9 | Point vault routes at `healthVault`. Default off pending legal sign-off on report upload. | Independent switch now exists. |
| 10 | Registry-driven admin portal; `runTracker` toggle appears. | Removes the unreachable-flag class of bug. |
| 11 | Add the contract test (registry keys == client keys). | Prevents recurrence. |

Steps 4 and 6 are the ones to get right. Step 4 is what makes step 8 non-breaking; step 6 is what
stops step 8 from looking like a regression.

### Rollout status

| # | Step | Status |
|---|---|---|
| 1 | Registry, `schemaVersion`, `flagsKnown`, `AppConfigHistory` | **done** (code) |
| 2 | Deploy backend + both clients | **not done** — nothing deployed |
| 3 | Register `workoutTracking` + `healthVault`, both defaulting `false` | **done** |
| 4 | Transitional `requireAnyFeatureFlag` shim, training routes repointed | **done** — shim still in place, correctly |
| 5 | Client flags + self-gated workout entry points | **done** (5 fields, 3 home screens, 2 widgets) |
| 6 | **Backfill the config blob per environment** | **NOT DONE — this is the blocker** |
| 7 | Flip training routes to `workoutTracking` only, delete the shim | **not done**, and must not be, until after 6 |
| 8 | Narrow `healthMetrics` to health-only routes requiring both flags | **partial** — routes are health-only now; requiring *both* is deferred to the same change as the backfill |
| 9 | Vault routes on `healthVault`, default off | **done** |
| 10 | Registry-driven admin portal, `runTracker` toggle appears | **done** |
| 11 | Contract test (registry ↔ client ↔ admin) | **done** — 11 cases |

Step 6 is the only thing between this branch and a deploy. Until it runs, `workoutTracking` is
`false` in every stored config, and step 7 would 403 the entire workout engine for anyone whose
`healthMetrics` was stored as `false`. Run 6 and 7 together, or not at all.


### Backfill values

| Env | `workoutTracking` | `healthMetrics` | `healthVault` |
|---|---|---|---|
| dev | `true` (mirrors current `healthMetrics`) | `true` | `false` |
| prod | mirror whatever is chosen at launch | mirror at launch | `false` |

---

## 9. Dev has no representative configuration

Dev is 18-of-19 on. Prod is 0-of-10 on (and 8 keys absent). The fail-closed behaviour this whole
design exists to produce is therefore exercised in exactly one environment, and that environment is
unreleased.

Add `services/auth-service/scripts/seedFeatureFlags.js` taking a named profile:

| Profile | Shape |
|---|---|
| `all-on` | every flag true (today's dev) |
| `all-off` | every flag false (today's prod) |
| `launch-candidate` | the profile you intend to ship |
| `consent-minimal` | training on, every DPDP-sensitive flag off |

Run it against dev before each QA pass. This is the cheapest available fix for "dev tests nothing
about flags" and it needs no new infrastructure.

**Built.** `services/auth-service/scripts/seedFeatureFlags.js` — dry run by default, `--apply` to
write, `--expect-host <substr>` as a prod guard (it aborts rather than guessing whether a host
"looks like" prod), `--note` recorded in the `AppConfigHistory` row. It reads the registry, so it
addresses flags by name and is immune to what any settings page happens to render — which is the
whole reason it exists rather than 20 portal toggles. It validates through the same
`validateFeaturePayload` the admin route uses, and writes versions + maintenance back untouched
because they share the config column. Profiles: `defaults`, `all-off`, `all-on`,
`consent-minimal`, `launch-candidate`.

Two properties worth knowing: the portal cannot express these profiles at all, because an unchecked
checkbox is not submitted — "turn everything off" and "the form rendered nothing" are the same empty
`FormData`; and the script's write path has never run against a real Postgres from this environment,
so its first real use should be a dry run against dev.


**The launch-candidate profile is a product decision, not a code change.** Given the stated core
job is retention and health:

| Flag | Launch | Reason |
|---|---|---|
| `workoutTracking` | **on** | the daily hook; ~150 sessions/user/year vs ~30 bookings |
| `healthMetrics` | on | the differentiator Hevy has no answer for |
| `healthVault` | **off** | legal sign-off pending on medical report upload |
| `fitnessAssistant` | off until data density | cold-start: no users → empty prescriptions |
| `runTracker` | off | not yet tuned; now at least reachable from the portal |
| `streaksCoins` | **off until the coin sink exists** | `POST /coins/redeem` (`challenges.js:19`) is never called by the app and the catalog is non-interactive (`coin_wallet_screen.dart:282-329`); cheapest item is 50 coins at a 10-per-check-in earn rate. Enabling it today ships a visible earn loop with no spend loop. |
| `challenges` | off outside Gurugram/Gorakhpur | `challengeCatalogService.js:28-44` hardcodes 2 cities; everyone else sees an empty list |
| `buddy` | decision pending | 21,441 lines, zero moderation/report/block in client or service, no match expiry, no city filter |
| `badges`, `homeTrackHome`, `nonPartnerAttendance`, `brandedOnboarding` | on | low risk, no external dependency |

The table above is now executable as `--profile launch-candidate`, and
`test/seedFeatureFlagsProfiles.test.js` asserts the profile matches it — so the two cannot drift apart
unnoticed. Two flags it names are worth reading carefully, because the profile includes them for
reasons the "Launch" column does not convey:

- **`buddy` is on because it is already live in production**, not because its open question is
  settled. It fails open by design, and the profile would ship a visibly broken feature if it did
  not include it. The moderation gap below is unresolved and is *not* what this profile decides.
- **`challenges` is off**, even though a two-city pilot is the obvious use. Enabling it globally is
  the failure mode described above; a city-scoped rollout is a different mechanism than a flag.

One correction to a claim made earlier in this document: enabling `healthMetrics` does **not**
"silently revive" the flags that depend on it. `deps` makes a child *inert* while its parent is off —
it never switches a child on. So this profile can have `healthMetrics` on with `healthVault`,
`cycleTracking`, `fhirExport` and both AI surfaces off, which is exactly what it does. The relation
that does bite is the reverse: `healthMetrics` would be dead without `workoutTracking`, which is why
both are on.

---

## 10. Test plan

1. **Contract test** — registry keys == `AppConfigModel` keys == admin portal rendered toggles.
   Fails on drift. This is the test whose absence allowed `cycleTracking`. **Done** —
   `services/auth-service/test/featureFlagRegistry.test.js`, 12 cases: registry self-consistency,
   registry ↔ service code, registry ↔ customer app, registry ↔ admin portal, endpoint shape. Runs
   with no database and no app instance; the cross-repo cases skip rather than fail in a
   backend-only checkout.
2. **Route matrix** — for every route in §5, assert 403 `FEATURE_DISABLED` with the flag off, and
   not-403 with it on. **Done for `health-service`** — `routeSplitGates.test.js`, 16 cases,
   mutation-verified. **Done for `challenge-service`** —
   `test/routeFlagMatrix.test.js`, 6 cases: every route on exactly one flag and neither sibling, the
   deliberately ungated internal routes and the ungated admin surface pinned, admin role-gating, and
   the in-handler `isFeatureEnabled` checks that let one attendance event drive three flags
   independently. It also cross-checks every flag name this service references against the registry,
   which nothing did before: the service learns flags by fetching `/app-config`, so it cannot use
   `assertKnownFlag`, and an unrecognised name resolves **false** — a rename would have made a live
   route a permanent silent 403 with no boot error and no failing test.
3. **Client gate test** — assert no widget renders a `workoutTracking`-gated surface while the flag
   is false. **Done.** `test/workout_flag_widget_absence_test.dart` (9 cases) covers the quick-action
   tiles, the today card and the router gate in both flag states, including that the gate depends on
   `workoutTracking` and not on `healthMetrics`; `test/app_routes_workout_gate_test.dart` (8 cases)
   covers the route list and the deep-link path. Both mutation-verified. Two harness details worth
   recording: the flag has to land *before* the first real build, because these widgets use
   `context.read` and do not subscribe; and `WorkoutQuickActions` sizes itself with `.sw` after the
   gate returns, so the widget needs `ScreenUtilInit` — without it the flag-off case passes and the
   flag-on case throws, which reads exactly like a broken gate.
4. **Admin round-trip** — toggle one flag from the portal, assert the other 19 survive. Guards the
   `actions.ts` incident class. **Done** —
   `app/settings/__tests__/featureFlagsRoundTrip.test.ts`, 10 cases: a toggle changes exactly one
   flag in either direction, the other nineteen keep their stored values, a stored flag the registry
   does not know about survives, `clientKey: null` posts under the flag name, versions and
   maintenance are resubmitted, and a failed registry load refuses the save outright.
   One behaviour pinned rather than guarded: an unchecked checkbox is not submitted, so "turn
   everything off" and "the form rendered nothing" arrive as the same empty `FormData`. The action
   cannot tell them apart and must not refuse an empty form, which is why bulk profiles belong to the
   seed script.
5. **Registry defaults parity** — assert `DEFAULT_FEATURES` and `AppConfigModel.notRequired()`
   agree, so offline fallback never diverges from server defaults. **Done** —
   `test/featureFlagDefaultsParity.test.js`, 4 cases covering all three client fallback paths (the
   model factory, a payload missing a key, and the cubit's pre-fetch state). This is what found
   `badges` defaulting to `true` on the client against `false` in the registry.

Test results as of this reconciliation:

| Suite | Result |
|---|---|
| `auth-service` full | 142 passed, 0 failed |
| `health-service` full | 849 passed, 0 failed, 5 skipped (no `TEST_DATABASE_URL`) |
| `challenge-service` full | 84 passed, 0 failed |
| `admin` full (`vitest run`) | 112 passed, 0 failed |
| `customer-app` full (`flutter test`) | 2651 passed, **2 failed**, both pre-existing and outside this refactor: `widgets_home_test.dart` "resolved location renders Near You tiles with distance" asserts `'3.4 km away'` on a tile the in-flight Near You redesign replaced with a photo card; and `widgets/training_progress_screen_test.dart` asserts `'Estimated 1-rep max, per session'`, a label in the in-flight workout work. Neither screen reads app config, `AppUpdateCubit` or any route, and none of their files are modified. |
| `customer-app` `flutter analyze` | 15 issues, all pre-existing; none in files this refactor touched |



---

## 11. Out of scope

- Consent **versioning**. Per-user `privacyVersion` for `healthPersonalisation` already exists
  server-side and the flag/feature vs consent/write split is correct. Not touched here.
- `maintenance.{wallet,gyms}` — separate windowed mechanism, correctly modelled already.
- The gamification design problems from the audit (three streak counters, paired-streak accrual
  after unmatch, farmable sprouts, client-computed daily streak). These are product bugs, not flag
  bugs. §9's `streaksCoins: off` is the only flag-level mitigation.
- buddy moderation. Not a flag problem.

---

## 12. What shipped, what diverged, what is still open

Implementation ran 2026-10-04. This section is the honest ledger; the sections above are the design
record and should not be read as a description of the current code.

### Shipped

- `config/featureFlagRegistry.js` — 20 flags, `FLAG_SCHEMA_VERSION = 2`, deps, groups, client
  keys, `blastRadius`, `rationale`, fail-closed defaults (`buddy` + `referral` fail-open only).
- `GET /api/auth/app-config/registry` (gobhi-only) and `schemaVersion` + `flagsKnown` on the public
  config.
- `AppConfigHistory` + migration `20261004000000_add_app_config_history` (applied to the dev
  database on 2026-10-04 by the deploy pipeline; still unapplied to prod), with
  `GET /api/auth/app-config/history`. Writes are best-effort by design.
- Dev verified 2026-10-04 after the auth-service, health-service and challenge-service deploy:
  the public config reports `schemaVersion: 2` and `flagsKnown` of 20. The 16 flags dev had
  already stored kept their values; `workoutTracking`, `healthVault` and `fhirExport` resolved to
  their fail-closed defaults and `referral` to true. The admin `/settings` page builds its list
  from the registry and refuses to render one it could not load.
- Consequence on dev, by design: the Local Health Vault routes now 403, because `healthVault`
  defaults off pending legal sign-off. Workout and score routes keep serving through the
  transitional either-gate.
- health-service route split into `workoutGated` / `metricsGated` / `vaultGated` /
  `consentGated` / `exportGated`, plus `requireAnyFeatureFlag` + `isAnyFeatureEnabled` as the
  transitional shim.
- Client: 5 new fields, store dependency composition, self-gated workout surfaces across 3 home
  screens and 2 widgets.
- Admin: registry-driven settings + coin controls, cross-group dependency status, `runTracker`
  toggle now reachable.

### Shipped since the first draft of this section

Each of these closed a numbered gap from §10 / §7 / §6 / §9 rather than adding scope.

- **Unknown-key rejection (§7).** `validateFeaturePayload` now rejects unknown flag names,
  non-object flag values, and non-boolean `enabled` with a 400 before persistence. It lives in
  `config/featureFlagRegistry.js` rather than the controller, so the admin route, the contract
  tests and the seed script cannot drift apart on what a valid payload is.
- **Recurrence invariant (§6).** `AppRoutes.generateRoute` refuses any route in `AppRoutes._workoutRoutes`
  (13 routes) with `NotFoundScreen` when `AppConfigStore.workoutTrackingVisible` is false. The gate sits
  before the `switch`, so it also runs before argument casting and a bare deep link cannot throw.
  `test/app_routes_workout_gate_test.dart` asserts the list matches the workout pages, fails if a
  route leaves the list, and fails if an unrelated route joins it.
- **Client widget-absence tests (§10).** `test/workout_flag_widget_absence_test.dart` covers the two
  quick actions, the today card, and the router gate in both flag states, including that the gate
  depends on `workoutTracking` and not on `healthMetrics`.
- **challenge-service route matrix (§10).** `test/routeFlagMatrix.test.js` maps every route to
  exactly one flag and to neither sibling, pins the deliberately ungated routes (attendance events,
  coin refund, DPDPA erase/export) and the ungated admin surface, and cross-checks every flag name
  this service references against the registry by dynamic import.
- **Admin round-trip (§10).** `app/settings/__tests__/featureFlagsRoundTrip.test.ts` asserts that a
  toggle changes exactly one flag, that the other nineteen keep their stored values, that a stored
  flag the registry does not know about survives, and that a failed registry load refuses the save
  instead of writing a subset.
- **Defaults parity (§10).** `test/featureFlagDefaultsParity.test.js` compares the registry against
  `AppConfigModel.fromJson` (empty payload and per-flag omission) and the cubit's pre-fetch state.
- **Seed script (§9).** `scripts/seedFeatureFlags.js` — dry run by default, `--apply` to write,
  `--expect-host` as a prod guard, `--note` recorded in the audit row. Profiles: `defaults`,
  `all-off`, `all-on`, `consent-minimal`, `launch-candidate`. Addresses flags by name from the
  registry, so it is immune to what any settings page renders.
- **`badges` default alignment.** The registry had it fail-closed while `AppConfigModel.fromJson`,
  `notRequired()` and the cubit's initial state all defaulted it to `true`. Not a live bug — nothing
  serves `badges` yet — but it meant the client would have shown the badges shelf while every call
  behind it 403'd. Now fail-closed on all four paths.

### Diverged from this proposal

| Proposal said | Built | Why |
|---|---|---|
| `trainingGated` / `healthGated` / `vaultGated` | `workoutGated` / `metricsGated` / `vaultGated` (+ `consentGated`, `exportGated`) | names now state which flag a route turns on |
| `healthGated` requires both flags | `metricsGated` requires `healthMetrics` alone | stored configs predate `workoutTracking`; requiring both would 403 every health-metrics route on deploy. Deferred to the backfill change. |
| 18 → 20 flags | 20 flags, including `referral` + `fhirExport` | both were already live and ungated/unregistered; found by writing the contract test |
| 3 new client fields | 5 | `healthPersonalisation` + `recapSharing` were the same gap as `cycleTracking` |
| attendance on the training gate | route ungated, flag checked in the handler | attendance is booking integrity, not a training feature |
| a `WorkoutTrackingGate` widget wrapper (§6) | one pre-switch guard in `AppRoutes.generateRoute` over a route list | a wrapper is forgotten at each call site, and the router is the single funnel every deep link and every `pushNamed` passes through. The trade-off: the guard protects navigation, not a widget someone mounts outside the router, so the widget-level gates stay as well. |
| §6 proposed grep-based checks | a static test over the route list | grep fires on any mention of a path; a test that compares the list to the pages fails only on real drift, in both directions |

### Still open

1. **Prod backfill (§8 step 6).** Dev was backfilled on 2026-10-04; **prod was not**, and prod's
   auth-service has not been redeployed onto the registry at all. This is now the only
   critical-path item. Dev's run: the blob held 15 of 20 flags, so `workoutTracking` (mirrored from
   `healthMetrics`), `healthVault`, `fhirExport`, `referral` and `runTracker` were added, no flag
   moved true→false, and the change is recorded in `AppConfigHistory` against nobody. The
   server/client asymmetry on `healthMetrics` is still documented at both points of use, but on dev
   it is now inert because both flags are true.
   **The step 7 and step 8 code cleanups are deliberately NOT done.** The backfill is per
   environment and the code is one codebase deployed to both, so removing `requireAnyFeatureFlag`
   now would resolve `workoutTracking` to its fail-closed default in prod and 403 every workout
   route there. They wait on the prod run.
2. **`launch-candidate` must not be applied to dev as it stands.** Its first dry run against real
   dev data (2026-10-04) showed it would switch **9 flags off** that dev currently has on —
   `healthLedger`, `foodPhotoLogging`, `healthPersonalisation`, `recapSharing`, `fitnessAssistant`,
   `cycleTracking`, `streaksCoins`, `challenges`, `buddyPairedStreaks`. Dev's stored state is far
   more permissive than the profile. `defaults` would switch 15 off. Both are correct behaviour of
   the script and the reason the dry run exists; neither is a profile to apply casually.
3. **The seed script's write path is now exercised** against real dev Postgres (dry runs of
   `defaults` and `launch-candidate` on 2026-10-04, both verified to write nothing). Its first real
   `--apply` has still never run.
4. **`launch-candidate` is a proposal, not an approved launch posture.** It is defined and tested,
   but nobody has signed off on it — see the flag-by-flag reasoning in the script.
5. **`buddy`'s moderation gap is unchanged.** No reporting, blocking, match expiry or city filter
   anywhere, while the flag fails open. Recorded against the registry entry; out of scope here.
6. **The admin `/settings` page is unverified on dev.** It needs a gobhi session, and the preview
   deployment's `GATEWAY_URL` has no default in the repo, so whether it reads the dev gateway or
   prod is not determinable from source.

