
import { buildFullExportService } from '../services/exportService.js';
import { PrismaClient } from '@prisma/client';
import semver from 'semver';
import { signupService, loginService, deleteUserService, refreshTokenService, logoutService, sendOtpService, verifyOtpService, verifyFirebaseTokenService, googleSignInService, listStaffService, createStaffService, updateStaffStatusService, normalizePhone, runAttendanceSaasReengagementSweepService, countGymJoinedUsersByMonthService, assertPartnerOwnsGym, createTrainerService, listTrainersForGymService, updateTrainerStatusService } from '../services/authService.js';
import { ROLES } from '../constants/userEnums.js';
import { ERROR_MESSAGES } from '../constants/errorMessages.js';
import {
  loadOtpProvider,
  loadOtpProviderAdmin,
  updateOtpProvider,
  listSkipAllowlist,
  addSkipAllowlistEntry,
  removeSkipAllowlistEntry,
} from '../services/otpProviderService.js';
import {
  loadProfileCompletionBonusAmount,
  loadProfileCompletionBonusAdmin,
  updateProfileCompletionBonusAmount,
} from '../services/profileCompletionBonusService.js';
import {
  FLAG_SCHEMA_VERSION,
  defaultFeatures,
  flagNames,
  flagRegistry,
  // Pure, dependency-free helpers that moved here from this file so the admin
  // route, the contract tests and scripts/seedFeatureFlags.js cannot disagree
  // about what a valid flag payload is. Re-exported below: callers that
  // already import validateFeaturePayload from here keep working.
  validateFeaturePayload,
  diffChangedFlags,
} from '../config/featureFlagRegistry.js';

const prisma = new PrismaClient();

const signup = async (req, res) => {
  try {
    // This route is public (no auth) — gobhi/staff accounts must only ever be
    // created via the authenticated POST /admin/staff path (createStaffService),
    // which calls signupService directly and bypasses this check. Without this,
    // any anonymous caller could POST role:'gobhi' here and self-provision a
    // staff account with full admin-portal access.
    if (req.body?.role === ROLES.GOBHI) {
      return res.status(403).json({
        error: ERROR_MESSAGES.GOBHI_SIGNUP_FORBIDDEN.message,
        errorCode: ERROR_MESSAGES.GOBHI_SIGNUP_FORBIDDEN.code,
      });
    }
    const result = await signupService(req.body ?? {});
    res.status(201).json(result);
  } catch (err) {
    console.error('Signup controller error:', JSON.stringify(err, null, 2));
    // Include error code in response for debugging
    const response = { error: err.error || 'Unknown error' };
    if (err.errorCode) {
      response.errorCode = err.errorCode;
    }
    // In development, include more error details
    if (process.env.NODE_ENV !== 'production' && err.originalError) {
      response.details = {
        code: err.originalError.code,
        message: err.originalError.message,
        name: err.originalError.name,
      };
    }
    res.status(err.status || 500).json(response);
  }
};



const login = async (req, res) => {
  try {
    const result = await loginService(req.body ?? {});
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Unknown error' });
  }
};

// DPDPA access right (s.11). Always scoped to req.user.id — there is no
// parameter here that could widen it to anyone else's record, which is why
// this lives on the authenticated session and the per-service twins are
// internal-only.
//
// ?format=download sets Content-Disposition so a browser saves the file
// instead of rendering it; the default returns JSON inline so an app can
// display it. Same document either way.
const exportMyData = async (req, res) => {
  try {
    const data = await buildFullExportService(req.user.id);
    if (req.query?.format === 'download') {
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="phool-gobhi-my-data-${stamp}.json"`);
      return res.send(JSON.stringify(data, null, 2));
    }
    res.json({ data });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Unknown error' });
  }
};

const deleteUser = async (req, res) => {
  try {
    const result = await deleteUserService(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Unknown error' });
  }
};

const refreshToken = async (req, res) => {
  try {
    const result = await refreshTokenService(req.body?.token);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Unknown error' });
  }
};

// Public (like refresh-token) so logout still revokes the session even if
// the access token has already expired. Always 200 — see logoutService.
const logout = async (req, res) => {
  const result = await logoutService(req.body?.token);
  res.json(result);
};

const sendOtp = async (req, res) => {
  try {
    const result = await sendOtpService(req.body?.phone);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Server error', errorCode: err.errorCode });
  }
};

const verifyOtp = async (req, res) => {
  try {
    const result = await verifyOtpService(req.body ?? {});
    res.status(result.isNewUser ? 201 : 200).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Server error', errorCode: err.errorCode });
  }
};

const verifyFirebaseToken = async (req, res) => {
  try {
    const result = await verifyFirebaseTokenService(req.body ?? {});
    res.status(result.isNewUser ? 201 : 200).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Server error', errorCode: err.errorCode });
  }
};

const googleSignIn = async (req, res) => {
  try {
    const result = await googleSignInService(req.body ?? {});
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Server error', errorCode: err.errorCode });
  }
};

const getOtpConfig = async (req, res) => {
  try {
    const provider = await loadOtpProvider();
    res.json({ provider });
  } catch (err) {
    console.error('getOtpConfig error:', err);
    res.json({ provider: 'firebase' });
  }
};

// gobhi-only — admin portal's raw view/edit of the OTP provider (Settings page).
const getOtpConfigAdmin = async (req, res) => {
  try {
    const { provider, updatedAt } = await loadOtpProviderAdmin();
    res.json({ data: { provider }, updatedAt });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

const updateOtpConfigAdmin = async (req, res) => {
  try {
    const updated = await updateOtpProvider(req.body?.provider, req.user.id);
    res.json({ data: { provider: updated.provider }, updatedAt: updated.updatedAt });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// gobhi-only — admin portal's view/edit of the one-time profile-completion
// bonus amount (Settings page). Also served to the customer app inside
// GET /api/auth/app-config (features.profileCompletionBonus.amount) so the
// app never hardcodes a stale ₹ value.
const getProfileCompletionBonusAdmin = async (req, res) => {
  try {
    const { amount, updatedAt } = await loadProfileCompletionBonusAdmin();
    res.json({ data: { amount }, updatedAt });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

const updateProfileCompletionBonusAdmin = async (req, res) => {
  try {
    const updated = await updateProfileCompletionBonusAmount(req.body?.amount, req.user.id);
    res.json({ data: { amount: updated.amount }, updatedAt: updated.updatedAt });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

const listOtpSkipAllowlist = async (req, res) => {
  try {
    const data = await listSkipAllowlist();
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

const addOtpSkipAllowlist = async (req, res) => {
  try {
    const entry = await addSkipAllowlistEntry(req.body ?? {});
    res.status(201).json({ data: entry });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

const removeOtpSkipAllowlist = async (req, res) => {
  try {
    await removeSkipAllowlistEntry(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Default config used whenever no AppVersionSetting row exists yet — both
// apps ship with this inert (minVersion/latestVersion match the current
// build) so the feature does nothing until an admin deliberately raises a
// version in the admin portal.
const DEFAULT_APP_VERSION_CONFIG = {
  customer: {
    android: { minVersion: '1.0.0', latestVersion: '1.0.0', updateUrl: 'https://play.google.com/store/apps/details?id=in.phoolgobi.customer', message: '' },
    ios: { minVersion: '1.0.0', latestVersion: '1.0.0', updateUrl: '', message: '' },
  },
  partner: {
    android: { minVersion: '1.0.0', latestVersion: '1.0.0', updateUrl: 'https://play.google.com/store/apps/details?id=in.phoolgobi.partner', message: '' },
    ios: { minVersion: '1.0.0', latestVersion: '1.0.0', updateUrl: '', message: '' },
  },
};

async function loadAppVersionConfig() {
  const row = await prisma.appVersionSetting.findUnique({ where: { id: 1 } });
  return row?.config || DEFAULT_APP_VERSION_CONFIG;
}

// Kill-switch defaults for customer-app features, derived from the registry —
// see config/featureFlagRegistry.js for the full rationale on every flag. This
// used to be a hand-maintained literal duplicating the customer app's
// AppConfigModel and the admin portal's own copy, and the three drifted (see the
// registry header). Adding a flag there is now the only step needed to make it
// reachable from the portal and covered by the contract test.
//
// These are only DEFAULTS: a stored app-config blob (written by the admin
// portal's /settings page) overrides them key by key, so the portal is the live
// switch and this is what an environment with no blob starts as.
//
// The inert-by-default convention is deliberate and load-bearing. Flipped ON then
// back OFF on 2026-09-10: the owner asked for all flags on; turning the DEFAULTS
// on turned out to be the wrong mechanism, because prod's blob says nothing about
// these keys and main was 73 commits behind. Promoting main with true defaults
// would have switched the entire programme on for real users at deploy —
// including the cron that sends push notifications — rather than landing it dark.
// So features land OFF in a new environment and are enabled per environment from
// the portal, the one place that decision is visible and reversible without a
// deploy.
//
// `referral` fails OPEN (it is live, so a missing/unknown flag must resolve to
// on rather than hide a shipped feature). `buddy` now fails CLOSED: it was
// flipped to defaultEnabled:false in W3, because the safety backstop (reports,
// hold, suspend) is the reason it can be shown at all, so an unknown flag must
// hide it rather than reveal an unverified feature. Everything else fails
// CLOSED: it collects or moves state, so a backend hiccup must hide it rather
// than risk the app calling a route that isn't ready. The one open exception is
// marked in the registry and is deliberate.
//
// otp.provider and profileCompletionBonus.amount are NOT registry entries — they
// are served from their own singleton setting rows and overridden on top of this
// in getAppConfig. Their entries below only keep the response shape safe before
// (or without) those rows existing.
const DEFAULT_FEATURES = {
  ...defaultFeatures(),
  otp: { provider: 'firebase' },
  profileCompletionBonus: { amount: 20 },
};

// Maintenance-window config for the customer website's wallet and gym
// sections. Admin-editable from the admin portal's /settings page; served
// publicly through /app-config so the website can gate the affected surfaces
// (and, in future, the apps can too). Each feature is independent — wallet
// and gyms can be put down separately or together. `enabled` is an immediate
// manual hold; if startsAt/endsAt are also set the window additionally
// auto-engages while `now` falls between them and releases once it passes.
// Same inert-by-default convention as the other settings.
const DEFAULT_MAINTENANCE_CONFIG = {
  wallet: { enabled: false, startsAt: null, endsAt: null, message: '' },
  gyms: { enabled: false, startsAt: null, endsAt: null, message: '' },
};

function isMaintenanceActive(entry) {
  if (entry?.enabled) return true;
  const startsAt = entry?.startsAt ? new Date(entry.startsAt) : null;
  const endsAt = entry?.endsAt ? new Date(entry.endsAt) : null;
  if (
    startsAt && endsAt &&
    !Number.isNaN(startsAt.getTime()) && !Number.isNaN(endsAt.getTime())
  ) {
    const now = Date.now();
    return now >= startsAt.getTime() && now <= endsAt.getTime();
  }
  return false;
}

// Merge whatever the stored blob carries over the defaults, one entry per
// feature, and compute the live `active` flag (manual hold OR now inside the
// scheduled window).
function resolveMaintenance(config) {
  const raw = config?.maintenance || {};
  const resolved = {};
  for (const [feature, defaults] of Object.entries(DEFAULT_MAINTENANCE_CONFIG)) {
    const entry = { ...defaults, ...(raw[feature] || {}) };
    resolved[feature] = {
      active: isMaintenanceActive(entry),
      enabled: !!entry.enabled,
      startsAt: entry.startsAt || null,
      endsAt: entry.endsAt || null,
      message: entry.message || '',
    };
  }
  return resolved;
}

// Public — called by both apps on startup, before login, to decide whether
// to hard-block (forceUpdate) or show a dismissible nudge (updateAvailable).
// Never throws on a bad/missing version — always fails open (both flags
// false) so a malformed query string never locks anyone out.
const getAppConfig = async (req, res) => {
  const { app, platform, version } = req.query;
  let forceUpdate = false;
  let updateAvailable = false;
  let entry = { minVersion: '1.0.0', latestVersion: '1.0.0', updateUrl: '', message: '' };
  let features = DEFAULT_FEATURES;
  let maintenance = resolveMaintenance(null);
  try {
    const config = await loadAppVersionConfig();
    entry = config?.[app]?.[platform] || entry;
    maintenance = resolveMaintenance(config);
    // Shallow-merge so a config blob that predates the features key (or only
    // carries one flag) still resolves every feature to a sane default. The
    // OTP provider and profile-completion bonus amount are served from their
    // own singleton setting rows (single source of truth for the admin
    // panel's /settings edits), overriding whatever an old blob carried.
    //
    // The merge is key-by-key and additive, so a flag absent from the stored
    // blob still resolves to its registry default and therefore still appears
    // in the response. That matters more than it looks: before FLAG_SCHEMA_VERSION
    // existed, a service deployed from an older revision had a smaller
    // DEFAULT_FEATURES literal, so its response simply omitted flags the client
    // knew about — and the client's `?? false` made "deliberately off" and
    // "this server predates that flag" indistinguishable. flagsKnown below
    // makes the difference observable in one log line.
    const [otpProvider, bonusAmount] = await Promise.all([
      loadOtpProvider(),
      loadProfileCompletionBonusAmount(),
    ]);
    features = {
      ...DEFAULT_FEATURES,
      ...(config?.features || {}),
      otp: { provider: otpProvider },
      profileCompletionBonus: { amount: bonusAmount },
    };
    const coerced = semver.valid(semver.coerce(version));
    if (coerced) {
      forceUpdate = semver.lt(coerced, entry.minVersion);
      updateAvailable = semver.lt(coerced, entry.latestVersion);
    }
  } catch (err) {
    console.error('getAppConfig error:', err);
  }
  res.json({
    schemaVersion: FLAG_SCHEMA_VERSION,
    // What THIS service build knows about. A client can diff this against its
    // own flag list to tell "off" apart from "my server is older than this
    // flag" — which is the failure that silently turned prod's workout logging
    // into visible-but-403 buttons.
    flagsKnown: flagNames(),
    forceUpdate,
    updateAvailable,
    minVersion: entry.minVersion,
    latestVersion: entry.latestVersion,
    updateUrl: entry.updateUrl,
    message: entry.message,
    features,
    maintenance,
  });
};

// gobhi-only — the flag registry itself, so the admin portal renders toggles
// from this list instead of redeclaring it. That redeclaration was the root of
// every flag drift (see config/featureFlagRegistry.js): a flag added server-side
// with no portal entry was unreachable, and a flag declared in the portal with
// no server entry was dead. Deriving the UI from here makes an unreachable flag
// impossible to create again.
const getFeatureFlagRegistry = async (req, res) => {
  try {
    const config = await loadAppVersionConfig();
    const stored = config?.features || {};
    res.json({
      data: flagRegistry().map((flag) => ({
        ...flag,
        // The live value, so the portal does not have to merge two responses.
        enabled: stored[flag.name]?.enabled ?? flag.defaultEnabled,
      })),
      schemaVersion: FLAG_SCHEMA_VERSION,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// gobhi-only — admin portal's raw view/edit of the full config blob.
const getAppConfigAdmin = async (req, res) => {
  try {
    const config = await loadAppVersionConfig();
    res.json({ data: config });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};


const updateAppConfigAdmin = async (req, res) => {
  try {
    const config = req.body?.config;
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'config is required' });
    }
    if (config.features !== undefined) {
      if (config.features === null || typeof config.features !== 'object' || Array.isArray(config.features)) {
        return res.status(400).json({ error: 'config.features must be an object of flagName -> { enabled }' });
      }
      const { unknown, malformed } = validateFeaturePayload(config.features);
      if (unknown.length) {
        return res.status(400).json({
          error: `unknown feature flag(s): ${unknown.join(', ')} - not in the registry, so nothing reads them`,
          unknown,
          knownFlags: flagNames(),
        });
      }
      if (malformed.length) {
        return res.status(400).json({
          error: `these flags must be { "enabled": true|false }: ${malformed.join(', ')}`,
          malformed,
        });
      }
    }
    const previous = await loadAppVersionConfig();

    const updated = await prisma.appVersionSetting.upsert({
      where: { id: 1 },
      create: { id: 1, config, updatedBy: req.user.id },
      update: { config, updatedBy: req.user.id },
    });
    // Audit only the flags that actually moved. A history row is written for
    // each, in one insert, so "which flag changed at 14:03" is one indexed
    // lookup rather than a scan over every save ever made.
    //
    // Best-effort by design: an audit write that fails must not fail the save
    // that already succeeded. A toggle switched on with no history row is bad,
    // but a toggle that cannot be switched on because the audit insert hit a
    // constraint is worse — the flag is the live control and the history is
    // bookkeeping.
    const changedFlags = diffChangedFlags(previous?.features, config.features);
    if (changedFlags.length) {
      try {
        await prisma.appConfigHistory.create({
          data: {
            changedFlags,
            before: previous?.features ?? undefined,
            after: config.features ?? {},
            note: req.body?.note || null,
            changedBy: req.user.id,
          },
        });
      } catch (auditErr) {
        console.error(
          `app-config saved but history write failed (flags: ${changedFlags.join(', ')}):`,
          auditErr.message,
        );
      }
    }
    res.json({ data: updated.config, changedFlags });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// gobhi-only — who switched which flag, when, from what. The read twin of the
// write in updateAppConfigAdmin; `flag` narrows to one flag (the incident
// question), otherwise it is the general log.
const listAppConfigHistory = async (req, res) => {
  try {
    const flag = req.query?.flag;
    const where = flag ? { changedFlags: { has: flag } } : {};
    const rows = await prisma.appConfigHistory.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(req.query?.limit) || 100, 500),
    });
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// Default when no LaunchGateSetting row exists yet — inert, same convention
// as DEFAULT_APP_VERSION_CONFIG, so the feature does nothing until an admin
// deliberately turns it on from the admin portal's /settings page.
const DEFAULT_LAUNCH_GATE = { enabled: false, launchAt: null };

async function loadLaunchGate() {
  const row = await prisma.launchGateSetting.findUnique({ where: { id: 1 } });
  if (!row) return DEFAULT_LAUNCH_GATE;
  return { enabled: row.enabled, launchAt: row.launchAt };
}

// Public — called by the website before rendering gym browse/detail/booking
// pages. `enabled=false` (or no row) is always live. `enabled=true` with no
// launchAt is gated indefinitely (manual hold). `enabled=true` with a
// launchAt is gated until that instant passes. Fails CLOSED on a DB error —
// unlike getAppConfig's fail-open, leaking gym visibility/bookings a few
// seconds early is worse here than a transient false "not live yet".
const getLaunchStatus = async (req, res) => {
  try {
    const gate = await loadLaunchGate();
    if (!gate.enabled) return res.json({ launchAt: null, isLive: true });
    if (!gate.launchAt) return res.json({ launchAt: null, isLive: false });
    const launchAt = gate.launchAt.toISOString();
    res.json({ launchAt, isLive: Date.now() >= gate.launchAt.getTime() });
  } catch (err) {
    console.error('getLaunchStatus error:', err);
    res.json({ launchAt: null, isLive: false });
  }
};

// gobhi-only — admin portal's raw view/edit of the launch gate (Settings page).
const getLaunchGateAdmin = async (req, res) => {
  try {
    const gate = await loadLaunchGate();
    res.json({ data: gate });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

const updateLaunchGateAdmin = async (req, res) => {
  try {
    const { enabled, launchAt } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) is required' });
    }
    let parsedLaunchAt = null;
    if (launchAt) {
      parsedLaunchAt = new Date(launchAt);
      if (Number.isNaN(parsedLaunchAt.getTime())) {
        return res.status(400).json({ error: 'launchAt must be a valid date' });
      }
    }
    const updated = await prisma.launchGateSetting.upsert({
      where: { id: 1 },
      create: { id: 1, enabled, launchAt: parsedLaunchAt, updatedBy: req.user.id },
      update: { enabled, launchAt: parsedLaunchAt, updatedBy: req.user.id },
    });
    res.json({ data: { enabled: updated.enabled, launchAt: updated.launchAt } });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

const listStaff = async (req, res) => {
  try {
    const staff = await listStaffService();
    res.json({ data: staff });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

const createStaff = async (req, res) => {
  try {
    const result = await createStaffService(req.body ?? {}, req.user.id);
    res.status(201).json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Server error', errorCode: err.errorCode });
  }
};

const updateStaffStatus = async (req, res) => {
  try {
    const updated = await updateStaffStatusService(req.params.id, !!req.body?.isActive, req.user.id);
    res.json({ data: updated });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Server error' });
  }
};

const getMe = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: user.id,
      phone: user.phone,
      name: user.name,
      email: user.email,
      role: user.role,
      type: user.type,
      gender: user.gender,
      dateOfBirth: user.dateOfBirth,
      fitnessGoals: user.fitnessGoals,
      referralCode: user.referralCode,
      linkedGymId: user.linkedGymId,
      trainerGymId: user.trainerGymId,
      leaderboardOptIn: user.leaderboardOptIn,
      // Onboarding branch — appMode in particular is read at app boot to pick
      // which Home to render, alongside linkedGymId directly above. Shipping
      // it on /me (not only on the profile endpoint) is what lets the app
      // branch on the first call rather than after a second round trip.
      currentlyWorksOut: user.currentlyWorksOut ?? null,
      trainingLocationPref: user.trainingLocationPref,
      trainingLocationOther: user.trainingLocationOther,
      appMode: user.appMode,
      freeTimeWindow: user.freeTimeWindow,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// Internal: minimal profile lookup for other services to enforce "profile
// must be complete before X" rules (e.g. booking-service before createBooking)
// without duplicating user data or exposing it through a public route.
// Extended for buddy-service: gender/fitnessGoals seed its denormalized
// discovery-filter cache, profileImageUrl/fcmToken back match/chat display
// and push notifications (services/buddy-service/services/authClient.js).
// Also extended for booking-service: referredByUserId lets completeBooking
// check, on a customer's first completed session, whether to fire the
// referral wallet credit.
const getUserInternal = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: user.id,
      name: user.name,
      phone: user.phone,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      // Copied into buddy-service's BuddyProfile cache on profile sync: a
      // gender changed to "female" (and not since cleared by an admin) blocks
      // the user from women-only discovery (BuddyProfile.womenOnlyBlocked).
      genderChangedAt: user.genderChangedAt ?? null,
      genderChangedTo: user.genderChangedTo ?? null,
      fitnessGoals: user.fitnessGoals,
      // Onboarding answers health-service reads to seed a weekly training
      // goal (FR-04) instead of measuring everyone against one hardcoded
      // number. Preferences, not sensitive data — the same class as
      // fitnessGoals directly above.
      experienceLevel: user.experienceLevel,
      weeklyFrequencyIntent: user.weeklyFrequencyIntent,
      // The rest of the onboarding branch, for health-service: the AI coach
      // is told how this person trains (a home trainee asked "what should I
      // do today" must not be sent to a gym), and comeback nudges are timed
      // to freeTimeWindow. Same class as the preferences above — how someone
      // likes to train, not anything about their health.
      currentlyWorksOut: user.currentlyWorksOut ?? null,
      trainingLocationPref: user.trainingLocationPref || null,
      appMode: user.appMode || null,
      freeTimeWindow: user.freeTimeWindow || null,
      profileImageUrl: user.profileImageUrl,
      fcmToken: user.fcmToken,
      referredByUserId: user.referredByUserId,
      linkedGymId: user.linkedGymId,
      trainerGymId: user.trainerGymId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// Backs the admin portal's user-journey phone search (analytics-service has
// no User table of its own, only a distinct_id) — normalizes the same way
// login/OTP does so "+919354859197", "919354859197", and "9354859197" all
// resolve to the one account, then hands back just the id (the caller
// re-fetches the fuller profile via getUserInternal with that id).
const getUserByPhoneInternal = async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    if (!phone) return res.status(400).json({ error: 'Invalid phone number' });
    const user = await prisma.user.findUnique({ where: { phone } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, name: user.name, phone: user.phone });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// Internal: batched display-field lookup so a caller resolving N user ids
// (e.g. buddy-service rendering a discovery page/matches list, or
// wallet-service enriching partner-balance/payout admin views) can do it in
// one round trip instead of N. Deliberately narrow — display-only fields
// that are safe to fan out widely, unlike getUserInternal's fuller payload
// above (no fcmToken/dateOfBirth/fitnessGoals here).
const getUsersBatchInternal = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return res.json({ data: [] });
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, phone: true, profileImageUrl: true, leaderboardOptIn: true },
    });
    res.json({ data: users });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// Scheduled trigger (see .github/workflows) for the attendance-SaaS
// re-engagement sweep — nudges gym-linked signups with no activity.
const runAttendanceSaasReengagementSweep = async (req, res) => {
  try {
    const result = await runAttendanceSaasReengagementSweepService();
    res.json({ data: result });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// Internal (requireInternal): count of users who joined each gym in a given
// calendar month (YYYY-MM, IST) — the "users joined" numerator behind the
// attendance-SaaS monthly flat-per-user bill (wallet-service computes
// amount = joinedCount x flatFee and debits the partner wallet).
const countGymJoinedUsersByMonthInternal = async (req, res) => {
  try {
    const gymIds = Array.isArray(req.body?.gymIds) ? req.body.gymIds.map(Number).filter(Number.isFinite) : [];
    if (!gymIds.length) return res.status(400).json({ error: 'gymIds required' });
    const counts = await countGymJoinedUsersByMonthService(gymIds, req.body?.month);
    res.json({ data: { month: req.body?.month, counts } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Gobhi-only roster of a single gym's linked members (attendance-SaaS
// wedge) — admin's /attendance-saas dashboard previously only had
// gym-level aggregates (see wallet-service's getSubscriptionSummaryByGymService);
// this is the individual-member list behind those numbers.
const listAttendanceSaasMembers = async (req, res) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const members = await prisma.user.findMany({
      where: { linkedGymId: gymId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, phone: true, createdAt: true },
    });
    res.json({ data: members });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// Partner-facing member roster (attendance-SaaS gap-analysis finding: every
// competitor treats "see your own members" as day-one baseline, and this
// existed in code but was gobhi-only). Same query as
// listAttendanceSaasMembers above, minus phone — partners must never see a
// customer's phone number (same rule bookingController's getGymBookings
// already enforces for the booking-history roster).
export const listGymMembersForPartner = async (req, res) => {
  try {
    if (req.user.role !== 'partner') return res.status(403).json({ error: 'Forbidden' });
    const gymId = parseInt(req.params.gymId);
    await assertPartnerOwnsGym(gymId, req.user.id);
    const members = await prisma.user.findMany({
      where: { linkedGymId: gymId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, createdAt: true },
    });
    res.json({ data: members });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Partner-only — creates a gym-employed trainer account (never public
// self-signup, see the ROLES.TRAINER guard in issueSessionForUser). The
// trainer subsequently logs in via the normal /send-otp + /verify-otp flow
// using the phone number given here.
export const createTrainer = async (req, res) => {
  try {
    if (req.user.role !== 'partner') return res.status(403).json({ error: 'Forbidden' });
    const gymId = parseInt(req.params.gymId);
    const trainer = await createTrainerService(req.body ?? {}, gymId, req.user.id);
    res.status(201).json({ data: trainer });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const listTrainers = async (req, res) => {
  try {
    if (req.user.role !== 'partner') return res.status(403).json({ error: 'Forbidden' });
    const gymId = parseInt(req.params.gymId);
    const trainers = await listTrainersForGymService(gymId, req.user.id);
    res.json({ data: trainers });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const updateTrainerStatus = async (req, res) => {
  try {
    if (req.user.role !== 'partner') return res.status(403).json({ error: 'Forbidden' });
    const gymId = parseInt(req.params.gymId);
    const trainerId = parseInt(req.params.trainerId);
    const isActive = req.body?.isActive === true;
    const trainer = await updateTrainerStatusService(trainerId, isActive, gymId, req.user.id);
    res.json({ data: trainer });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Lets a customer/partner set their name after signup, since phone+OTP
// signup never collects one (see authService.js issueSessionForUser). Each
// app nudges for this once name is null rather than blocking signup on it.
const updateMe = async (req, res) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name is required' });
    const user = await prisma.user.update({ where: { id: req.user.id }, data: { name } });
    res.json({ id: user.id, name: user.name });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// Partner-only self-service — for the attendance-SaaS bank-settlement flow.
// No masking on the way back to the partner: it's their own data, and admin
// separately needs the full details to actually make the transfer, so
// there's nothing gained by hiding it from the one person it belongs to.
const getBankAccount = async (req, res) => {
  try {
    if (req.user.role !== 'partner') return res.status(403).json({ error: 'Forbidden' });
    const account = await prisma.partnerBankAccount.findUnique({ where: { userId: req.user.id } });
    res.json({ data: account });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

const updateBankAccount = async (req, res) => {
  try {
    if (req.user.role !== 'partner') return res.status(403).json({ error: 'Forbidden' });
    const { accountHolderName, accountNumber, ifscCode, upiId } = req.body ?? {};
    if (!accountHolderName?.trim() || !accountNumber?.trim() || !ifscCode?.trim()) {
      return res.status(400).json({ error: 'accountHolderName, accountNumber, and ifscCode are required' });
    }
    const data = {
      accountHolderName: accountHolderName.trim(),
      accountNumber: accountNumber.trim(),
      ifscCode: ifscCode.trim().toUpperCase(),
      upiId: upiId?.trim() || null,
    };
    const account = await prisma.partnerBankAccount.upsert({
      where: { userId: req.user.id },
      update: data,
      create: { userId: req.user.id, ...data },
    });
    res.json({ data: account });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// Gobhi-only — admin needs the full bank details to actually make the
// manual settlement transfer (see wallet-service's PartnerBankSettlement).
const getBankAccountAdmin = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const account = await prisma.partnerBankAccount.findUnique({ where: { userId } });
    res.json({ data: account });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

const updateFcmToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ error: 'fcmToken required' });
    await prisma.user.update({ where: { id: req.user.id }, data: { fcmToken } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// Per-gym attendance leaderboards (booking-service) are on by default — a
// check-in is public on the boards it would rank on. This opt-out is the only
// way leaderboardOptIn ever changes, and it is reachable from the customer
// app's profile screen only (no toggle on the board itself).
const updateLeaderboardOptIn = async (req, res) => {
  try {
    const { optIn } = req.body;
    if (typeof optIn !== 'boolean') return res.status(400).json({ error: 'optIn (boolean) required' });
    await prisma.user.update({ where: { id: req.user.id }, data: { leaderboardOptIn: optIn } });
    res.json({ ok: true, leaderboardOptIn: optIn });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// Map collectibles (veggie pickups) -- a standalone currency, deliberately
// NOT coins and NOT tied to gyms/bookings/badges. Spawn points are
// deterministic client-side (fixed grid, see the customer app's
// VeggieCollectibleGrid); there's no server-side catalog, so this is purely
// which ids a user has found.
const listMyCollectibles = async (req, res) => {
  try {
    const finds = await prisma.collectibleFind.findMany({
      where: { userId: req.user.id },
      select: { collectibleId: true },
    });
    res.json({ data: finds.map((f) => f.collectibleId) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

const collectCollectible = async (req, res) => {
  try {
    const { collectibleId } = req.params;
    if (!collectibleId) return res.status(400).json({ error: 'collectibleId required' });
    // Idempotent: walking near an already-found spawn point again (or a
    // retried request) is a no-op, not an error.
    await prisma.collectibleFind.upsert({
      where: { userId_collectibleId: { userId: req.user.id, collectibleId } },
      create: { userId: req.user.id, collectibleId },
      update: {},
    });
    res.json({ ok: true, collectibleId });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export { signup, login, deleteUser, exportMyData, refreshToken, logout, sendOtp, verifyOtp, verifyFirebaseToken, googleSignIn, getOtpConfig, getOtpConfigAdmin, updateOtpConfigAdmin, listOtpSkipAllowlist, addOtpSkipAllowlist, removeOtpSkipAllowlist, getAppConfig, getAppConfigAdmin, updateAppConfigAdmin, validateFeaturePayload, listAppConfigHistory, getFeatureFlagRegistry, getLaunchStatus, getLaunchGateAdmin, updateLaunchGateAdmin, getProfileCompletionBonusAdmin, updateProfileCompletionBonusAdmin, getMe, updateMe, getUserInternal, getUserByPhoneInternal, getUsersBatchInternal, runAttendanceSaasReengagementSweep, listAttendanceSaasMembers, getBankAccount, updateBankAccount, getBankAccountAdmin, updateFcmToken, updateLeaderboardOptIn, listMyCollectibles, collectCollectible, listStaff, createStaff, updateStaffStatus, countGymJoinedUsersByMonthInternal };


