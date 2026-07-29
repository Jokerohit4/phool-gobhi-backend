
import { PrismaClient } from '@prisma/client';
import semver from 'semver';
import { signupService, loginService, deleteUserService, refreshTokenService, logoutService, sendOtpService, verifyOtpService, verifyFirebaseTokenService, googleSignInService, listStaffService, createStaffService, updateStaffStatusService, normalizePhone } from '../services/authService.js';
import { ROLES } from '../constants/userEnums.js';
import { ERROR_MESSAGES } from '../constants/errorMessages.js';

const prisma = new PrismaClient();

const signup = async (req, res) => {
  try {
    console.log('Signup request body:', req.body);
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

const deleteUser = async (req, res) => {
  try {
    console.log('req.user', req.user);
    const result = await deleteUserService(req.user.id);
    res.json(result);
  } catch (err) {
    console.log('err', err);
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

const getOtpConfig = (req, res) => {
  res.json({ provider: process.env.OTP_PROVIDER || 'fast2sms' });
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

// Public — called by both apps on startup, before login, to decide whether
// to hard-block (forceUpdate) or show a dismissible nudge (updateAvailable).
// Never throws on a bad/missing version — always fails open (both flags
// false) so a malformed query string never locks anyone out.
const getAppConfig = async (req, res) => {
  const { app, platform, version } = req.query;
  let forceUpdate = false;
  let updateAvailable = false;
  let entry = { minVersion: '1.0.0', latestVersion: '1.0.0', updateUrl: '', message: '' };
  try {
    const config = await loadAppVersionConfig();
    entry = config?.[app]?.[platform] || entry;
    const coerced = semver.valid(semver.coerce(version));
    if (coerced) {
      forceUpdate = semver.lt(coerced, entry.minVersion);
      updateAvailable = semver.lt(coerced, entry.latestVersion);
    }
  } catch (err) {
    console.error('getAppConfig error:', err);
  }
  res.json({
    forceUpdate,
    updateAvailable,
    minVersion: entry.minVersion,
    latestVersion: entry.latestVersion,
    updateUrl: entry.updateUrl,
    message: entry.message,
  });
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
    const updated = await prisma.appVersionSetting.upsert({
      where: { id: 1 },
      create: { id: 1, config, updatedBy: req.user.id },
      update: { config, updatedBy: req.user.id },
    });
    res.json({ data: updated.config });
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
      fitnessGoals: user.fitnessGoals,
      profileImageUrl: user.profileImageUrl,
      fcmToken: user.fcmToken,
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
      select: { id: true, name: true, phone: true, profileImageUrl: true },
    });
    res.json({ data: users });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
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

export { signup, login, deleteUser, refreshToken, logout, sendOtp, verifyOtp, verifyFirebaseToken, googleSignIn, getOtpConfig, getAppConfig, getAppConfigAdmin, updateAppConfigAdmin, getMe, updateMe, getUserInternal, getUserByPhoneInternal, getUsersBatchInternal, updateFcmToken, listStaff, createStaff, updateStaffStatus };


