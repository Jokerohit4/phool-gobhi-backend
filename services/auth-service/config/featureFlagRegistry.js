/**
 * Feature-flag registry — the single source of truth for customer-app
 * kill-switches.
 *
 * WHY THIS FILE EXISTS
 *
 * Every recurring problem with the flag system came from the flag list being
 * hand-maintained in five places at once: this service's DEFAULT_FEATURES, the
 * customer app's AppConfigModel, the admin portal's FeatureFlags interface, the
 * portal's form action, and the coins page's local copy. They drifted, and the
 * drift was silent every time:
 *
 *   - `cycleTracking` shipped server-side but AppConfigModel had no field for
 *     it, so the client structurally could not honour the flag.
 *   - `runTracker` shipped and was the only flag `false` in dev, but the portal
 *     wrote 17 flags without it — so it could not be switched on from the
 *     admin UI at all. Only a direct config-blob edit or a code deploy could
 *     reach it. (app/settings/actions.ts already documented this exact
 *     anti-pattern as the reason healthLedger finally got a toggle.)
 *   - `referral` was read by the client's fromJson but never declared here, so
 *     it silently resolved to the client's fail-open default forever and the
 *     portal had no control over it.
 *   - `getAppConfig` spread DEFAULT_FEATURES under the stored blob, so a service
 *     deployed from an older revision omitted flags the client knew about —
 *     and because the client resolves a missing key with `?? false`, "deliberately
 *     off" and "this server predates that flag" were indistinguishable.
 *
 * So: one registry, and everything derives from it. DEFAULT_FEATURES is built
 * from `defaults()`. The admin portal renders toggles from `getFlagRegistry()`
 * (GET /api/auth/app-config/registry, gobhi-only). The contract test asserts
 * this list and the customer app's AppConfigModel agree, which is the check
 * whose absence allowed every one of the drifts above.
 *
 * ADDING A FLAG
 *
 * Add an entry here and nothing else needs to change for it to be reachable
 * from the admin portal, present in the app-config response, and covered by
 * the contract test. That is the whole point: an unreachable flag should be
 * impossible to create.
 *
 * Not listed here: `otp` and `profileCompletionBonus`, which are served from
 * their own singleton setting rows (OtpProviderSetting etc.) rather than from
 * the features blob, and which getAppConfig overrides on top of `defaults()`.
 * They are still returned in the response.
 */

/** Bumped whenever the flag SET changes shape, so a client can tell a flag that
 * is off from a server that predates the flag existing. Emitted as
 * `schemaVersion` on GET /api/auth/app-config. */
export const FLAG_SCHEMA_VERSION = 2;

/**
 * Ordering within a group is only for the admin portal's render order. `deps`
 * is what the servers actually enforce: a flag whose deps are off is inert
 * regardless of its own value, so the portal shows it as blocked rather than
 * pretending it does something.
 */
export const FEATURE_FLAGS = [
  // ---------------------------------------------------------------- training
  {
    name: 'workoutTracking',
    defaultEnabled: false,
    deps: [],
    clientKey: 'workoutTrackingEnabled',
    group: 'training',
    dataClass: 'training-log',
    blastRadius:
      'Exercise library, custom exercises, routines, workout sessions, sets, progress summary, muscle readiness',
    rationale:
      'Split out of `healthMetrics` on 2026-10-04. The workout log is the product\'s ' +
      'high-frequency loop (~150 sessions/user/year against ~30 bookings), so it must be ' +
      'shippable without dragging every health feature with it. It previously shared one ' +
      'boolean with the Local Health Vault — PDF upload of medical reports — which meant the ' +
      'daily hook could not ship without the most consent-sensitive surface in the app. ' +
      'Deliberately fail-closed like its siblings: it collects new personal data.',
  },
  // ------------------------------------------------------------------ health
  {
    name: 'healthMetrics',
    defaultEnabled: false,
    deps: ['workoutTracking'],
    clientKey: 'healthMetricsEnabled',
    group: 'health',
    dataClass: 'health-derived',
    blastRadius: 'Blended health score, behavioural/biological breakdown, biomarker snapshot, health profile',
    rationale:
      'NARROWED on 2026-10-04. Previously this one boolean also gated the workout ' +
      'engine; those routes moved to `workoutTracking`. What is left is the derived-score ' +
      'half, which is what the name always implied. Requires `workoutTracking` because the ' +
      'behavioural component of the blend is computed from training data. ' +
      'See docs/phool-gobhi-health-metrics-implementation-plan-2026-08-27.html.',
  },
  {
    name: 'healthVault',
    defaultEnabled: false,
    deps: [],
    clientKey: 'healthVaultEnabled',
    group: 'health',
    dataClass: 'medical',
    blastRadius: 'Local Health Vault: report upload, pending extractions, extraction verification',
    rationale:
      'Split out of `healthMetrics` on 2026-10-04, standalone on purpose. Uploading a ' +
      'medical report is the most sensitive collection in the app, and tying it to a ' +
      'boolean that also turned on workout logging is not a risk posture anyone should ' +
      'accept. Standalone also keeps user-owned data reachable: this file already ' +
      'establishes at health.js ("a user must always be able to delete their own data, ' +
      'even if the feature that collected it is switched off"), and a vault reachable only ' +
      'while health metrics are on would produce extracted biomarkers the user can neither ' +
      'export nor erase in-app. Off until legal sign-off on report upload.\n\n' +
      'NOT THE SAME SURFACE as `healthLedger`\'s medical documents. This is a report you ' +
      'upload for the AI to EXTRACT biomarkers from (/reports/upload, /pending, ' +
      '/verify); that is a record the user keeps and re-reads under its own ' +
      '`medical_records` consent scope (/ledger/medical-documents). Two different ' +
      'uploads, two different flags, and conflating them is the mistake this split exists ' +
      'to prevent.',
  },
  {
    name: 'healthLedger',
    defaultEnabled: false,
    deps: ['healthMetrics'],
    clientKey: 'healthLedgerEnabled',
    group: 'health',
    dataClass: 'medical',
    blastRadius: 'Brokerage-style daily health score, candlestick/line chart, nutrition targets, food log',
    rationale:
      'The brokerage-style daily health score, its chart, the nutrition target engine, ' +
      'the food log and the optional medical-records vault. Layered on healthMetrics so ' +
      'it can be pulled without taking workout logging down. ' +
      '(phool-gobhi-health-ledger-plan-20260927.html)\n\n' +
      'Highest bar in the system, for three reasons:\n' +
      "  1. It is the first feature here whose premise is a SCORE. Every other health " +
      'feature logs; this one grades. The plan\'s own eating-disorder guard (a calorie ' +
      'target that never drops below BMR, under-eating never rewarded, a "calm mode" ' +
      'that removes red entirely) is a product requirement, not a nice-to-have.\n' +
      '  2. It stores what is close to a medical record — conditions, the doctor\'s own ' +
      'advice, lab slips — behind its own `medical_records` consent scope. CDSCO\'s ' +
      '"General Wellness Software" carve-out only holds while the app tracks the ' +
      "doctor's plan and never writes one, so this is the flag to pull if that line is " +
      'ever questioned.\n' +
      '  3. Photo food logging sends an image to a third-party model provider. That has ' +
      'its own sub-flag below.',
  },
  {
    name: 'foodPhotoLogging',
    defaultEnabled: false,
    deps: ['healthLedger'],
    clientKey: 'foodPhotoLoggingEnabled',
    group: 'health',
    dataClass: 'medical',
    blastRadius: 'Meal photo capture, food-photo recognition',
    rationale:
      'Sub-flag of healthLedger, not a peer: the ledger is useless without ' +
      'search-based food logging, so it must never be gated behind this one. Only the ' +
      'photo path is separable, because it is the only part that puts a user\'s image on ' +
      "someone else's infrastructure. Off until Zero Data Retention is confirmed on the " +
      'provider account. (A user happy to log calories is not automatically happy to hand ' +
      'over a photo of their plate.)',
  },
  {
    name: 'healthPersonalisation',
    defaultEnabled: false,
    deps: ['healthMetrics'],
    clientKey: 'healthPersonalisationEnabled',
    group: 'health',
    dataClass: 'health-derived',
    blastRadius: 'Non-neutral AI programming modes (records a per-user privacyVersion)',
    rationale:
      'The only consent-bearing write in health-service: a non-neutral programming mode ' +
      'records a privacyVersion. The consent wording needs review before a real user ' +
      'agrees to it. Kept separate from healthMetrics so the consent gate can be held ' +
      'independently of the feature existing. See ' +
      'docs/phool-gobhi-counsel-brief-20260908.html.',
  },
  {
    name: 'recapSharing',
    defaultEnabled: false,
    deps: ['healthMetrics'],
    clientKey: 'recapSharingEnabled',
    group: 'health',
    dataClass: 'none',
    blastRadius: 'Weekly recap card export/sharing (the only artifact intended to leave the platform)',
    rationale:
      'The only feature producing an artifact meant to leave the platform. The payload ' +
      'carries no PII by construction, but "we believe it carries no PII" is exactly the ' +
      'sort of claim worth having checked before it becomes shareable.',
  },
  {
    name: 'fitnessAssistant',
    defaultEnabled: false,
    deps: ['healthMetrics'],
    clientKey: 'fitnessAssistantEnabled',
    group: 'health',
    dataClass: 'health-derived',
    blastRadius: 'AI coach chat panel (reads training history)',
    rationale:
      'An AI answering questions about someone\'s body is a bigger claim than logging ' +
      'their sets, and the disclaimer wording wants sign-off. Independently switchable so ' +
      'the assistant can be pulled without taking anything else down. Cold-start note: ' +
      'with no user base the model has no data to be useful from, so this is the flag to ' +
      'leave off until there is real density.',
  },
  {
    name: 'runTracker',
    defaultEnabled: false,
    deps: ['healthMetrics'],
    clientKey: 'runTrackerEnabled',
    group: 'health',
    dataClass: 'health-derived',
    blastRadius: 'GPS run/walk tracking, routes, cycle stats (run-tracker-spec.html §12 Q1)',
    rationale:
      'Layered on healthMetrics, independently switchable, but inert unless healthMetrics ' +
      'is also on. Its own consent/storage/export/erase plumbing is health-service\'s, so ' +
      'it ships dark alongside the rest of Health+ rather than needing its own legal ' +
      'sign-off. The only flag that was unreachable from the admin portal before the ' +
      'registry existed.',
  },
  {
    name: 'cycleTracking',
    defaultEnabled: false,
    deps: ['healthMetrics'],
    clientKey: 'cycleTrackingEnabled',
    group: 'health',
    dataClass: 'medical',
    blastRadius: 'Cycle tracking, phases, FR-27 consent scope',
    rationale:
      'Its own flag AND its own consent scope, because this reverses FR-27 (2026-09-08), ' +
      'which deliberately kept zero cycle columns server-side. Off until the consent ' +
      'wording has been reviewed — the same bar healthPersonalisation was held to, and this ' +
      'is more sensitive than that was.',
  },
  {
    name: 'fhirExport',
    defaultEnabled: false,
    deps: ['healthMetrics'],
    clientKey: null,
    group: 'health',
    dataClass: 'medical',
    blastRadius: 'FHIR R4 / ABHA export format of GET /export (format=ndjson|json|fhir)',
    rationale:
      'Declared here on 2026-10-04 for the first time. exportController.js has checked ' +
      'this flag since ABHA-FHIR-INTEGRATION.md Stage 0, but it was never in ' +
      'DEFAULT_FEATURES, so it resolved false forever — which happened to be the correct ' +
      'behaviour (fail-closed) for entirely the wrong reason: nobody could ever switch it ' +
      'on. Registering it is what makes it reachable. Off until the HAPI validator passes ' +
      'against the NRCeS IG: until then we must not hand anyone a file labelled as a ' +
      'government-standard record. clientKey is null — this is a query-parameter branch on ' +
      'an existing route, with no client-side surface to gate.',
  },
  // ------------------------------------------------------------ gamification
  {
    name: 'badges',
    defaultEnabled: false,
    deps: [],
    clientKey: 'badgesEnabled',
    group: 'gamification',
    dataClass: 'none',
    blastRadius: 'Badges shelf on the map, badge counts on the Progress hub',
    rationale:
      'Derived and display-only — no ledger, no coin movement — so it fails OPEN: harmless ' +
      'if shown. Still flag-gated for consistency with its siblings.',
  },
  {
    name: 'streaksCoins',
    defaultEnabled: false,
    deps: [],
    clientKey: 'streaksCoinsEnabled',
    group: 'gamification',
    dataClass: 'none',
    blastRadius: 'Streaks (weekly + daily), coin wallet, coin balance tile, sprouts, collectibles, leaderboard tiles, gift FAB',
    rationale:
      'Moves coin-ledger and streak state, so fail-CLOSED: a backend hiccup must hide it ' +
      'rather than risk the app calling a route that is not ready.\n\n' +
      'DO NOT ENABLE until the coin sink exists. As of 2026-10-04 the app never calls ' +
      'POST /api/challenges/coins/redeem (the route exists, challenge-service), the ' +
      'catalog UI is a non-interactive Container/Row with no onTap, and the cheapest ' +
      'seeded item costs 50 coins against a 10-coins-per-check-in earn rate. Turning this ' +
      'on today ships a visible earn loop with no spend loop.',
  },
  {
    name: 'challenges',
    defaultEnabled: false,
    deps: [],
    clientKey: 'challengesEnabled',
    group: 'gamification',
    dataClass: 'none',
    blastRadius: 'Challenge list, enrolment, checkpoints, off-peak challenges, city quests',
    rationale:
      'Fail-closed like streaksCoins: enrolment and advancement mutate rows.\n\n' +
      'CONTENT WARNING: the seeded catalogue is hardcoded to two cities (Gurugram and ' +
      'Gorakhpur) and every challenge mechanic is geo-fenced to one of them. A user ' +
      'anywhere else sees an empty list. There is no dynamic-pricing-like fallback and no ' +
      'non-geo challenge, so this reads as a broken feature outside those two cities.',
  },
  {
    name: 'buddyPairedStreaks',
    defaultEnabled: false,
    deps: [],
    clientKey: 'buddyPairedStreaksEnabled',
    group: 'gamification',
    dataClass: 'none',
    blastRadius: 'Paired streaks with a matched buddy, paired-streak coins',
    rationale:
      'Fail-closed: opt-in writes rows and awards coins on weekly qualification.\n\n' +
      'KNOWN BUG while dark — fix before enabling: advancePairedStreaksService scans all ' +
      'pairedStreak rows and never re-checks match status, buddy-service has no cleanup on ' +
      'unmatch or account deletion, and the client drops the row on unmatch. Coins ' +
      'therefore keep accruing for a match that no longer exists, invisibly. Opt-in also ' +
      'auto-enrols the other member without their consent, and there is no opt-out route.',
  },
  // ------------------------------------------------------------------ social
  {
    name: 'buddy',
    defaultEnabled: true,
    deps: [],
    clientKey: 'buddyEnabled',
    group: 'social',
    dataClass: 'social',
    blastRadius: 'Buddy tab, swipe discovery, matches, chat, buddy profiles, paired streaks',
    rationale:
      'Fails OPEN: buddy is live, so a missing or unknown flag must resolve to enabled ' +
      'rather than hiding a shipped feature by mistake.\n\n' +
      'DECISION PENDING. As of 2026-10-04 there is no reporting, blocking, or moderation ' +
      'anywhere in the client or in buddy-service (grep for report|block|flag|moderate ' +
      'returns nothing), no match expiry (matches persist indefinitely as status=active), ' +
      'no city or distance filter on discovery so cross-city matching is possible, and no ' +
      'gate tying it to bookings so it is fully usable with zero connection to the actual ' +
      'product. That is a moderation and safety liability, not just a retention bet.',
  },
  {
    name: 'referral',
    defaultEnabled: true,
    deps: [],
    clientKey: 'referralEnabled',
    group: 'social',
    dataClass: 'none',
    blastRadius: 'Refer & Earn: install-referrer attribution, referral bonus',
    rationale:
      'Declared here on 2026-10-04 for the first time. The customer app has always read ' +
      'features.referral, but it was never in DEFAULT_FEATURES, so the key never appeared ' +
      'in the response and the client silently used its fail-open default forever — with no ' +
      'backend gate and no portal control. Fails OPEN, matching the client.\n' +
      'NOTE: the bonus amount is client-side config only; nothing server-side gates it.',
  },
  // --------------------------------------------------------------- onboarding
  {
    name: 'brandedOnboarding',
    defaultEnabled: false,
    deps: [],
    clientKey: 'brandedOnboardingEnabled',
    group: 'onboarding',
    dataClass: 'health-derived',
    blastRadius: 'Onboarding question graph and the health-profile writes it produces',
    rationale:
      'Gates COLLECTION only. Off means the existing two-step onboarding runs untouched, ' +
      'so this can ship dark and be turned on for a cohort.',
  },
  {
    name: 'homeTrackHome',
    defaultEnabled: false,
    deps: ['workoutTracking'],
    clientKey: 'homeTrackHomeEnabled',
    group: 'onboarding',
    dataClass: 'none',
    blastRadius: 'appMode taking effect: the home_track Home screen replaces the marketplace Home',
    rationale:
      'Whether appMode actually changes what the user sees. Separate from ' +
      'brandedOnboarding on purpose: collection and consequence are staged independently, ' +
      'so the real home/partner-gym/non-partner split can be measured on live users before ' +
      'anyone builds on the assumption. Requires workoutTracking (was healthMetrics) — the ' +
      'home-track screen leads with workout/routine widgets that flag gates.',
  },
  {
    name: 'nonPartnerAttendance',
    defaultEnabled: false,
    deps: [],
    clientKey: 'nonPartnerAttendanceEnabled',
    group: 'ops',
    dataClass: 'none',
    blastRadius: 'Places-sourced unclaimed gym records, GPS check-in at non-partner gyms',
    rationale:
      'Resolving a place calls Google Places — billable — on every request and writes a ' +
      'row, so it needs a real kill switch rather than just a hidden button in the app.',
  },
];

const BY_NAME = new Map(FEATURE_FLAGS.map((f) => [f.name, f]));

/** Every flag name, for schemaVersion/flagsKnown on the app-config response. */
export const flagNames = () => FEATURE_FLAGS.map((f) => f.name);

/** The default features blob. Overridden key-by-key by any stored config. */
export function defaultFeatures() {
  const out = {};
  for (const flag of FEATURE_FLAGS) {
    out[flag.name] = { enabled: flag.defaultEnabled };
  }
  return out;
}

/**
 * Everything the admin portal needs to render toggles without hand-maintaining a
 * parallel list. Serve this from a gobhi-only route rather than having the
 * portal redeclare the flag names — that redeclaration is what drifted.
 */
export function flagRegistry() {
  return FEATURE_FLAGS.map((f) => ({ ...f, blockedBy: f.deps.filter((d) => !BY_NAME.has(d)) }));
}

/** Throws on an unknown flag name, so a typo in a route chain fails at boot. */
export function assertKnownFlag(name) {
  if (!BY_NAME.has(name)) {
    throw new Error(`Unknown feature flag "${name}" — add it to FEATURE_FLAGS in config/featureFlagRegistry.js`);
  }
  return name;
}

// The two settings that live in `features` but are NOT flags. They are served
// from their own singleton rows (OtpProviderSetting, ProfileCompletionBonusSetting)
// and injected into the public response, so the admin portal round-trips them
// through `config.features`. They are allowed through here for that reason; they
// are not gates and must never be given an `enabled`.
export const FEATURES_SINGLETON_KEYS = new Set(['otp', 'profileCompletionBonus']);

/**
 * `config.features` is a blind write target, so an unknown key is the silent-
 * false failure this whole split was opened to fix: the key is stored, no gate
 * anywhere reads it, every consumer resolves it to the registry default, and
 * the operator who set it is shown a toggle that silently does nothing. Reject
 * the write instead of accepting a key that cannot work.
 *
 * Also type-check `enabled`. `diffChangedFlags` and the gate middleware both
 * coerce with `!!`, so a JSON string "false" reads as TRUE - a flag that looks
 * off in the portal and is on at the gate is worse than a rejected write.
 *
 * Lives here, not in the controller, so that the admin route, the parity
 * contract test and scripts/seedFeatureFlags.js all validate identically. A
 * second copy of this function is exactly the drift the registry header
 * describes, and it would be a copy that only the ops path could disagree with.
 */
export function validateFeaturePayload(features) {
  const known = new Set([...flagNames(), ...FEATURES_SINGLETON_KEYS]);
  const unknown = [];
  const malformed = [];
  for (const [name, value] of Object.entries(features)) {
    if (!known.has(name)) {
      unknown.push(name);
      continue;
    }
    if (FEATURES_SINGLETON_KEYS.has(name)) continue; // {provider} / {amount}, not {enabled}
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      malformed.push(name);
      continue;
    }
    if ('enabled' in value && typeof value.enabled !== 'boolean') malformed.push(name);
  }
  return { unknown: unknown.sort(), malformed: malformed.sort() };
}

/**
 * Which flags actually moved, for the audit row. `!!` on both sides so a
 * value that only ever changed shape (`{}` -> `{enabled: false}`) is not
 * reported as a change worth a history entry.
 */
export function diffChangedFlags(before, after) {
  const names = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changed = [];
  for (const name of names) {
    if (!!before?.[name]?.enabled !== !!after?.[name]?.enabled) changed.push(name);
  }
  return changed.sort();
}
