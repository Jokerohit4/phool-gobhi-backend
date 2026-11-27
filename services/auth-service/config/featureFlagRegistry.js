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
export const FLAG_SCHEMA_VERSION = 7;

/**
 * Ordering within a group is only for the admin portal's render order. `deps`
 * is what the servers actually enforce: a flag whose deps are off is inert
 * regardless of its own value, so the portal shows it as blocked rather than
 * pretending it does something.
 */
const featureDefinitions = [
  {
    name: 'subscriptionOffers',
    defaultEnabled: false,
    deps: [],
    clientKey: 'subscriptionOffersEnabled',
    group: 'subscriptions',
    dataClass: 'none',
    blastRadius: 'Subscription offers, quotes, and membership screens',
    rationale: 'Keeps the subscription screens off until their customer rollout is ready.',
  },
  {
    name: 'subscriptionMedical',
    defaultEnabled: false,
    deps: ['subscriptionOffers'],
    clientKey: 'subscriptionMedicalEnabled',
    group: 'subscriptions',
    dataClass: 'medical',
    blastRadius: 'Medical plan offers and quotes',
    rationale: 'Lets the medical family roll out independently within the subscription screens.',
  },
  {
    name: 'subscriptionWellness',
    defaultEnabled: false,
    deps: ['subscriptionOffers'],
    clientKey: 'subscriptionWellnessEnabled',
    group: 'subscriptions',
    dataClass: 'none',
    blastRadius: 'Wellness plan offers and quotes',
    rationale: 'Lets the wellness family roll out independently within the subscription screens.',
  },
  {
    name: 'modelTrainingConsent',
    defaultEnabled: false,
    deps: [],
    clientKey: 'modelTrainingConsentEnabled',
    group: 'health',
    dataClass: 'health-derived',
    blastRadius: 'Model-training consent prompt and controls',
    rationale: 'Keeps model-training consent controls off until the consent flow is ready.',
  },
  {
    name: 'firstLogPrompt',
    defaultEnabled: false,
    deps: [],
    clientKey: 'firstLogPromptEnabled',
    group: 'onboarding',
    dataClass: 'none',
    blastRadius: 'First-log prompt',
    rationale: 'Allows an independent rollout of the first-log prompt.',
  },
  {
    name: 'planCoveredBooking',
    defaultEnabled: false,
    deps: [],
    clientKey: 'planCoveredBookingEnabled',
    group: 'subscriptions',
    dataClass: 'none',
    blastRadius: 'Plan-covered booking flow',
    rationale: 'Allows the customer booking flow to roll out independently of offer discovery.',
  },
  {
    name: 'coachingSessionConfirm',
    defaultEnabled: false,
    deps: [],
    clientKey: 'coachingSessionConfirmEnabled',
    group: 'coach',
    dataClass: 'none',
    blastRadius: 'Customer confirmation of coaching sessions',
    rationale: 'Allows the coaching-session confirmation flow to roll out independently.',
  },
  {
    name: 'exploreFoodFinds',
    defaultEnabled: false,
    deps: [],
    clientKey: 'exploreFoodFindsEnabled',
    group: 'exploration',
    dataClass: 'collection',
    blastRadius: 'Food Finds world issuance; collection history and published-epoch queue resolution remain available',
    rationale: 'Enables the renewable Food Finds grid independently of Sprouts and coins. Defaults off until the Increment A pilot is ready; rollback preserves saved history and queued claims.',
  },
  // ---------------------------------------------------------------- training
  // ------------------------------------------------------------------ health
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
    defaultEnabled: false,
    deps: [],
    clientKey: 'buddyEnabled',
    group: 'social',
    dataClass: 'social',
    blastRadius: 'Buddy tab, swipe discovery, matches, chat, buddy profiles, paired streaks',
    rationale:
      'Fails CLOSED: buddy stays off by default until the safety backstop (reports, ' +
      'automatic hold, suspension) is verified. A missing or unknown flag must resolve to ' +
      'disabled rather than surface an unmoderated social feature by mistake.\n\n' +
      'DECISION 2026-10-09. The reporting, hold and suspension routes now exist in ' +
      'buddy-service (Group W), but they have not been exercised end-to-end on dev ' +
      '(W10) and selfie verification is still outstanding, so anyone can declare a gender. ' +
      'Dev keeps an explicit stored row set to true so it stays usable; prod stays false ' +
      'until W10 passes and this entry is revisited.',
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
  // ------------------------------------------------------------------- coach
  {
    name: 'homeIntroduction',
    defaultEnabled: false,
    deps: [],
    clientKey: 'homeIntroductionEnabled',
    group: 'coach',
    dataClass: 'health-derived',
    blastRadius: 'Progressive first-run Home presentation for newly enrolled customer accounts',
    rationale:
      'New accounts begin with water logging and a completed workout before Today. ' +
      'The server persists completion and bounded activity coin claims; reminders are optional. ' +
      'Journey layers open at 7/10/15 elapsed days with consent/setup still required. ' +
      'Existing accounts retain full Home. The Coach Journey itself is permanently on.',
  },
  {
    name: 'weeklySummary',
    defaultEnabled: false,
    deps: [],
    clientKey: 'weeklySummaryEnabled',
    group: 'coach',
    dataClass: 'health-derived',
    blastRadius: 'Weekly habit summary read endpoint and client entry points',
    rationale: 'Weekly food, water, plan and workout review; defaults off and uses the existing admin app-config override for development dogfood.',
  },
  {
    name: 'selfLinkGym',
    defaultEnabled: false,
    deps: [],
    clientKey: 'selfLinkGymEnabled',
    group: 'coach',
    dataClass: 'none',
    blastRadius:
      'Self-link and leave-gym endpoints (POST/DELETE /gym-links/self) and the linked-member Home',
    rationale:
      'Lets a customer attach themselves to a partner gym without a QR, so it is a ' +
      'membership claim the gym can be billed off — needs the raised app-version minimum ' +
      'first, because older builds do not read the linked-member fields /me returns and ' +
      'would fall back to the marketplace Home silently. Deliberately its own flag so ' +
      'the link surface can be held back independently.',
  },
  {
    name: 'personaSwitch',
    defaultEnabled: false,
    deps: [],
    clientKey: 'personaSwitchEnabled',
    group: 'coach',
    dataClass: 'none',
    blastRadius:
      'PUT /users/:id/persona and the app\'s "How you use Phool Gobhi" switcher: a user moving ' +
      'between linked gym, own gym, wellness, home training and explorer (leaving a gym included)',
    rationale:
      'Switching ends gym links, swaps the plan track and pauses challenges, so it ships dark ' +
      'until the app build that shows the confirmation steps is the minimum. Moving onto a ' +
      'partner gym additionally needs selfLinkGym, because that is a billed membership claim.',
  },
  {
    name: 'referralHomeTrigger',
    defaultEnabled: false,
    deps: [],
    clientKey: 'referralHomeTriggerEnabled',
    group: 'coach',
    dataClass: 'none',
    blastRadius: 'Referral payout on a friend\'s 3rd showed-up day (a second trigger beside the first-booking one)',
    rationale:
      'A second referral trigger that credits the referrer when the referred friend reaches ' +
      'their 3rd showed-up day instead of only on their first completed booking. It is ' +
      'evaluated inside journeyService.get (the journey is permanently on). Money moves on it, so it is last in the rollout ' +
      'order and stays off until the showed-up-day rules are verified on dev.',
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

/**
 * LEGACY ALWAYS-ON KEYS — retired flags that must keep being served.
 *
 * `coachJourney` and `healthVault` were removed as toggles on 2026-11-23: both
 * features are permanently on. They are NOT in FEATURE_FLAGS (so they have no
 * admin toggle, no deps, no gate anywhere in the servers) — but every already-
 * installed customer app reads `features.coachJourney.enabled` /
 * `features.healthVault.enabled` (clientKeys `coachJourneyEnabled` /
 * `healthVaultEnabled`) from GET /app-config and treats a MISSING key as OFF.
 * Dropping the keys would silently switch both features off for every user on an
 * old build. So the public response keeps emitting them as constant
 * `{ enabled: true }`, forced AFTER the stored-blob merge so no stored value (an
 * admin app that still PUTs them, an old row) can turn them off.
 *
 * Do not add new entries here lightly: this is a compatibility shim for flags that
 * were already shipped in released clients, and each entry is emitted forever (or
 * until the minimum supported app version no longer reads it).
 */
export const LEGACY_ALWAYS_ON_FLAGS = [
  { name: 'coachJourney', clientKey: 'coachJourneyEnabled' },
  { name: 'healthVault', clientKey: 'healthVaultEnabled' },
  { name: 'workoutTracking', clientKey: 'workoutTrackingEnabled' },
  { name: 'healthMetrics', clientKey: 'healthMetricsEnabled' },
  { name: 'healthLedger', clientKey: 'healthLedgerEnabled' },
  { name: 'healthPersonalisation', clientKey: 'healthPersonalisationEnabled' },
  { name: 'fitnessAssistant', clientKey: 'fitnessAssistantEnabled' },
  { name: 'brandedOnboarding', clientKey: 'brandedOnboardingEnabled' },
  { name: 'reportSubscription', clientKey: 'reportSubscriptionEnabled' },
  { name: 'coachAssistant', clientKey: 'coachAssistantEnabled' },
];
const LEGACY_NAMES = new Set(LEGACY_ALWAYS_ON_FLAGS.map((f) => f.name));
export const FEATURE_FLAGS = featureDefinitions
  .map((flag) => ({ ...flag, deps: flag.deps.filter((dependency) => !LEGACY_NAMES.has(dependency)) }));

/** `{ coachJourney: {enabled:true}, healthVault: {enabled:true} }` for the public response. */
export function legacyAlwaysOnFeatures() {
  return Object.fromEntries(LEGACY_ALWAYS_ON_FLAGS.map((f) => [f.name, { enabled: true }]));
}

/** True for a retired flag name that writes must tolerate (and ignore). */
export const isLegacyAlwaysOnFlag = (name) => LEGACY_NAMES.has(name);

/** Drops retired keys from a features blob (copy; input untouched). */
export function stripLegacyFlags(features) {
  if (!features || typeof features !== 'object' || Array.isArray(features)) return features;
  return Object.fromEntries(Object.entries(features).filter(([k]) => !LEGACY_NAMES.has(k)));
}

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
    // Retired always-on flags (see LEGACY_ALWAYS_ON_FLAGS): an admin app that
    // has not been updated yet may still send them. Accept and ignore — the
    // value is never read and never overrides the constant `true`.
    if (LEGACY_NAMES.has(name)) continue;
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
