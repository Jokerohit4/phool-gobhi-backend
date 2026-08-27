import { hash, compare } from 'bcrypt';
import crypto from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { generateAccessToken } from '../utils/generateTokens.js';
import { issueRefreshFamily, rotate as rotateRefreshToken, revokeByToken } from './refreshTokenService.js';
import { VALID_ROLES, VALID_TYPES, VALID_GOBHI_TYPES, ROLES } from '../constants/userEnums.js';
import { ERROR_MESSAGES } from '../constants/errorMessages.js';
import { track } from '../utils/analytics.js';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';
import { notifyUser } from '../utils/notifyUser.js';
import { loadOtpProvider, isSkipAllowlisted } from './otpProviderService.js';

const SKIP_OTP_CODE = '123456';
const OTP_MAX_ATTEMPTS = 5;

const prisma = new PrismaClient();

// Constant-time string compare — a plain !== on a guessable secret (an OTP
// code here) leaks a timing signal proportional to how many leading
// characters matched. Low-risk in practice (bounded by the OTP's 5-minute
// lifetime, the gateway's per-IP rate limit, and now OTP_MAX_ATTEMPTS below),
// but cheap to close outright rather than rely solely on those.
function safeCompareStrings(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const GYM_SERVICE_URL = process.env.GYM_SERVICE_URL || 'http://gym-service:5004';
const BOOKING_SERVICE_URL = process.env.BOOKING_SERVICE_URL || 'http://booking-service:5005';
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://wallet-service:5003';

// Best-effort onboarding summary for a partner, fetched from gym-service. Lets
// the partner app route on login (dashboard vs. resume onboarding) from the
// server's source of truth — gym existence — instead of trusting local state.
// Returns null if gym-service is unreachable so the app can fall back gracefully.
async function fetchPartnerGymSummary(partnerId) {
  try {
    const res = await fetch(`${GYM_SERVICE_URL}/internal/partner/${partnerId}/summary`, {
      headers: {
        'x-internal-key': (process.env.INTERNAL_API_KEY || '').trim(),
        ...(await googleIdTokenHeader(GYM_SERVICE_URL)),
      },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.data || null;
  } catch (err) {
    console.error('fetchPartnerGymSummary error:', err.message);
    return null;
  }
}

// Verifies the requesting partner actually owns gymId before this service
// hands back gym-scoped data (the member roster) — same posture as
// booking-service's assertPartnerOwnsGym / wallet-service's ownership checks,
// duplicated per-service rather than shared since these are independent
// microservices with no shared code layer.
export async function assertPartnerOwnsGym(gymId, partnerId) {
  let gym;
  try {
    const res = await fetch(`${GYM_SERVICE_URL}/internal/${gymId}`, {
      headers: {
        'x-internal-key': (process.env.INTERNAL_API_KEY || '').trim(),
        ...(await googleIdTokenHeader(GYM_SERVICE_URL)),
      },
    });
    if (!res.ok) throw new Error('not ok');
    const body = await res.json();
    gym = body.data || body;
  } catch (_) {
    throw { status: 404, error: 'Gym not found' };
  }
  if (!gym || gym.partnerId !== partnerId) throw { status: 403, error: 'Forbidden' };
  return gym;
}

// Bulk "which of these customerIds have activity" lookup against another
// service's batch endpoint — a failed/unreachable service degrades to "no
// one there has activity" (empty array) rather than blocking the whole
// sweep, same fail-open posture as fetchPartnerGymSummary above.
async function fetchCustomerIdsWithActivity(serviceUrl, path, customerIds) {
  try {
    const res = await fetch(`${serviceUrl}${path}`, {
      method: 'POST',
      headers: {
        'x-internal-key': (process.env.INTERNAL_API_KEY || '').trim(),
        'Content-Type': 'application/json',
        ...(await googleIdTokenHeader(serviceUrl)),
      },
      body: JSON.stringify({ customerIds }),
    });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body.data) ? body.data : [];
  } catch (err) {
    console.error(`fetchCustomerIdsWithActivity(${path}) error:`, err.message);
    return [];
  }
}

const REENGAGEMENT_AFTER_DAYS = Number(process.env.REENGAGEMENT_AFTER_DAYS) || 3;
// Caps how many candidates one sweep run processes — if there's ever a
// backlog bigger than this, the oldest-signed-up candidates (ordered by
// createdAt) get resolved first, and the rest wait for tomorrow's run
// rather than the sweep growing unbounded in a single invocation.
const REENGAGEMENT_BATCH_SIZE = 500;

// Attendance-SaaS wedge: nudges a gym-linked signup who has shown no
// activity (no completed booking, no subscription purchase) N days after
// registering — at most once ever per user (see reengagementNudgedAt).
// Runs on a schedule (see .github/workflows), not on-demand.
export async function runAttendanceSaasReengagementSweepService() {
  const cutoff = new Date(Date.now() - REENGAGEMENT_AFTER_DAYS * 24 * 60 * 60 * 1000);
  const candidates = await prisma.user.findMany({
    where: { linkedGymId: { not: null }, createdAt: { lt: cutoff }, reengagementNudgedAt: null },
    orderBy: { createdAt: 'asc' },
    take: REENGAGEMENT_BATCH_SIZE,
    select: { id: true, fcmToken: true, linkedGymId: true },
  });

  if (!candidates.length) return { candidates: 0, nudged: 0, alreadyActive: 0 };

  const customerIds = candidates.map((c) => c.id);
  const [withBooking, withSubscription] = await Promise.all([
    fetchCustomerIdsWithActivity(BOOKING_SERVICE_URL, '/internal/bookings/has-completed-batch', customerIds),
    fetchCustomerIdsWithActivity(WALLET_SERVICE_URL, '/internal/subscriptions/has-purchased-batch', customerIds),
  ]);
  const activeIds = new Set([...withBooking, ...withSubscription]);

  let nudged = 0;
  let alreadyActive = 0;
  for (const user of candidates) {
    // Per-candidate try/catch — one bad row (e.g. a DB hiccup on the
    // resolving update) must never abort the rest of the batch.
    try {
      if (activeIds.has(user.id)) {
        alreadyActive++;
      } else {
        await notifyUser(user.fcmToken, {
          title: "Don't lose your streak!",
          body: 'Check in at your gym on Phool Gobhi to keep your attendance on record.',
          data: { type: 'attendance_saas_reengagement' },
        });
        track('attendance_saas_reengagement_sent', user.id, {
          linked_gym_id: user.linkedGymId,
          had_fcm_token: Boolean(user.fcmToken),
        });
        nudged++;
      }
      await prisma.user.update({ where: { id: user.id }, data: { reengagementNudgedAt: new Date() } });
    } catch (err) {
      console.error(`Reengagement sweep failed for user ${user.id}:`, err.message);
    }
  }

  return { candidates: candidates.length, nudged, alreadyActive };
}

export async function signupService({ name, email, password, role, type, gobhiType }) {
  // Validate role and type
  if (!VALID_ROLES.includes(role)) {
    throw { status: 400, error: ERROR_MESSAGES.INVALID_ROLE.message, errorCode: ERROR_MESSAGES.INVALID_ROLE.code };
  }
  if (!VALID_TYPES.includes(type)) {
    throw { status: 400, error: ERROR_MESSAGES.INVALID_TYPE.message, errorCode: ERROR_MESSAGES.INVALID_TYPE.code };
  }
  // If role is gobhi, validate gobhiType
  if (role === ROLES.GOBHI) {
    if (!VALID_GOBHI_TYPES.includes(gobhiType)) {
      throw { status: 400, error: ERROR_MESSAGES.INVALID_GOBHI_TYPE.message, errorCode: ERROR_MESSAGES.INVALID_GOBHI_TYPE.code };
    }
  }
  try {
    const hashed = await hash(password, 10);
    const user = await prisma.user.create({
      data: { 
        name, 
        email, 
        password: hashed, 
        role, 
        type, 
        gobhiType: role === ROLES.GOBHI ? gobhiType : null,
        updatedAt: new Date(), // Explicitly set updatedAt
      },
    });
    const accessToken = generateAccessToken(user.id, user.role, user.type);
    const refreshToken = await issueRefreshFamily(user.id);
    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        type: user.type,
        gobhiType: user.gobhiType,
      },
    };
  } catch (err) {
    // Log the full error for debugging
    console.error('Signup error - Full details:', JSON.stringify({
      code: err.code,
      message: err.message,
      meta: err.meta,
      name: err.name,
      stack: err.stack?.substring(0, 500),
    }, null, 2));
    
    if (err.name === 'PrismaClientInitializationError') {
      console.error('Database connection error:', err);
      throw { status: 500, error: ERROR_MESSAGES.SERVER_ERROR.message, errorCode: ERROR_MESSAGES.SERVER_ERROR.code };
    }
    
    // Prisma unique constraint violation error code is 'P2002'
    if (err.code === 'P2002') {
      const targetFields = err.meta?.target || [];
      const isEmailError = Array.isArray(targetFields) && (
        targetFields.includes('email') || 
        targetFields.some(field => String(field).toLowerCase().includes('email'))
      );
      
      if (isEmailError) {
        console.error('Signup error: Email already exists');
        throw { status: 400, error: ERROR_MESSAGES.EMAIL_EXISTS.message, errorCode: ERROR_MESSAGES.EMAIL_EXISTS.code };
      }
      
      // Any unique constraint violation
      console.error('Signup error: Unique constraint violation');
      throw { status: 400, error: ERROR_MESSAGES.EMAIL_EXISTS.message, errorCode: ERROR_MESSAGES.EMAIL_EXISTS.code };
    }
    
    // For any other Prisma error, include original error for debugging
    console.error('Signup error - Unhandled Prisma error:', {
      code: err.code,
      message: err.message,
      name: err.name,
    });
    throw { 
      status: 400, 
      error: ERROR_MESSAGES.USER_EXISTS_OR_INVALID.message, 
      errorCode: ERROR_MESSAGES.USER_EXISTS_OR_INVALID.code,
      originalError: {
        code: err.code,
        message: err.message,
        name: err.name,
      }
    };
  }
}

export async function loginService({ email, password }) {
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw { status: 404, error: ERROR_MESSAGES.USER_NOT_FOUND.message, errorCode: ERROR_MESSAGES.USER_NOT_FOUND.code };
    const isMatch = await compare(password, user.password);
    if (!isMatch) throw { status: 401, error: ERROR_MESSAGES.INVALID_CREDENTIALS.message, errorCode: ERROR_MESSAGES.INVALID_CREDENTIALS.code };
    if (!user.isActive) throw { status: 403, error: ERROR_MESSAGES.ACCOUNT_DEACTIVATED.message, errorCode: ERROR_MESSAGES.ACCOUNT_DEACTIVATED.code };
    const accessToken = generateAccessToken(user.id, user.role, user.type);
    const refreshToken = await issueRefreshFamily(user.id);
    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        type: user.type,
        gobhiType: user.gobhiType,
      },
    };
  } catch (err) {
    if (err.name === 'PrismaClientInitializationError') {
      console.error('Database connection error:', err);
      throw { status: 500, error: ERROR_MESSAGES.SERVER_ERROR.message, errorCode: ERROR_MESSAGES.SERVER_ERROR.code };
    }
    if (err.status && err.errorCode) throw err;
    throw { status: 500, error: ERROR_MESSAGES.SERVER_ERROR.message, errorCode: ERROR_MESSAGES.SERVER_ERROR.code };
  }
}

export async function deleteUserService(userId) {
  try {
    await prisma.user.delete({ where: { id: userId } });
    return { message: 'User deleted' };
  } catch (err) {
    if (err.name === 'PrismaClientInitializationError') {
      console.error('Database connection error:', err);
      throw { status: 500, error: ERROR_MESSAGES.SERVER_ERROR.message, errorCode: ERROR_MESSAGES.SERVER_ERROR.code };
    }
    // Log all other errors with full details
    console.error('Error deleting user:', err);
    throw { status: 500, error: ERROR_MESSAGES.ERROR_DELETING_USER.message, errorCode: ERROR_MESSAGES.ERROR_DELETING_USER.code };
  }
}

export async function refreshTokenService(token) {
  if (!token) throw { status: 401, error: ERROR_MESSAGES.NO_REFRESH_TOKEN.message, errorCode: ERROR_MESSAGES.NO_REFRESH_TOKEN.code };
  try {
    // rotateRefreshToken verifies the JWT, looks up its RefreshToken row, and
    // either rotates it (issuing a new one) or rejects it (revoked/reused/
    // expired) — see refreshTokenService.js for the full state machine.
    const { userId, refreshToken } = await rotateRefreshToken(token);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw { status: 404, error: 'User not found', errorCode: 'USER_NOT_FOUND' };
    if (!user.isActive) throw { status: 403, error: ERROR_MESSAGES.ACCOUNT_DEACTIVATED.message, errorCode: ERROR_MESSAGES.ACCOUNT_DEACTIVATED.code };
    const accessToken = generateAccessToken(user.id, user.role, user.type);
    return { accessToken, refreshToken };
  } catch (err) {
    if (err.status) throw err;
    throw { status: 403, error: ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH.message, errorCode: ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH.code };
  }
}

// Explicit logout — revokes the token's whole rotation family so it (and any
// clone of it) stops working immediately, rather than waiting out its
// natural 7-day expiry. Never throws on a bad/missing token: logout should
// always succeed from the caller's point of view.
export async function logoutService(token) {
  if (token) {
    try {
      await revokeByToken(token);
    } catch (err) {
      console.error('logoutService: revoke failed (ignored)', err);
    }
  }
  return { ok: true };
}

// OTP store lives in Postgres (OtpCode model, one row per phone) rather than
// an in-memory Map — a Cloud Run cold start or scale-out to multiple
// instances would otherwise silently invalidate in-flight OTPs, since each
// instance would have its own empty Map.

// Canonical phone key for everything in this service — OTP-store lookups,
// User.phone storage/matching, and both the OTP-store and Firebase verify
// paths — so "+919354859197", "919354859197", and "9354859197" all resolve
// to the exact same OTP entry and the exact same account. Without this, the
// two client apps (which formatted phone differently) could each reach a
// different account for the same real phone number. Returns null if the
// input isn't a valid 10-digit Indian mobile number.
export function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  const local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2)
    : digits.length === 11 && digits.startsWith('0') ? digits.slice(1)
    : digits;
  return /^[6-9]\d{9}$/.test(local) ? local : null;
}

function normalizeToE164(phone) {
  return `91${phone}`;
}

async function sendWhatsAppOtp(phone, code) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME;
  if (!phoneNumberId || !accessToken || !templateName) return false;
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: normalizeToE164(phone),
        type: 'template',
        template: {
          name: templateName,
          language: { code: 'en' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: code }] }],
        },
      }),
    });
    if (!res.ok) { console.error('WhatsApp OTP failed:', await res.text()); return false; }
    return true;
  } catch (err) {
    console.error('WhatsApp OTP error:', err.message);
    return false;
  }
}

async function sendFast2SmsOtp(phone, code) {
  const apiKey = process.env.FAST2SMS_API_KEY;
  if (!apiKey) return false;
  const digits = phone.replace(/\D/g, '').slice(-10);
  // route=otp requires no DLT registration (Fast2SMS delivers it via their own
  // pre-approved template), but the message is fixed as "Your OTP: {value}" —
  // no custom/branded text or Sender ID is possible on this route.
  try {
    const res = await fetch(`https://www.fast2sms.com/dev/bulkV2?authorization=${apiKey}&route=otp&variables_values=${code}&numbers=${digits}`, {
      headers: { 'cache-control': 'no-cache' },
    });
    const body = await res.json().catch(() => null);
    // Fast2SMS sometimes returns HTTP 200 with {return:false} on logical failures
    // (e.g. account gates) — res.ok alone isn't enough to detect that.
    if (!res.ok || body?.return === false) {
      console.error('Fast2SMS OTP failed:', res.status, body);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Fast2SMS OTP error:', err.message);
    return false;
  }
}

export async function sendOtpService(rawPhone) {
  if (!rawPhone) {
    throw { status: 400, error: ERROR_MESSAGES.PHONE_REQUIRED.message, errorCode: ERROR_MESSAGES.PHONE_REQUIRED.code };
  }
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    throw { status: 400, error: ERROR_MESSAGES.INVALID_PHONE.message, errorCode: ERROR_MESSAGES.INVALID_PHONE.code };
  }
  // provider is the admin-configurable switch between WhatsApp/Fast2SMS,
  // Firebase, and skip (see GET /otp-config, admin-editable via
  // /otp-config/admin) — but the switch previously only advised clients
  // which path to take; this function itself would still attempt a real
  // WhatsApp/Fast2SMS send regardless. That let Fast2SMS fire (and silently
  // "succeed" per the 200 below even when delivery failed) for any caller of
  // this endpoint even while the platform is on Firebase.
  // Guard it here so "provider=firebase" is an actual guarantee, not just a
  // hint — Fast2SMS/WhatsApp are disabled while it's set.
  const provider = await loadOtpProvider();
  if (provider === 'firebase') {
    throw { status: 400, error: 'OTP delivery is handled by Firebase phone auth — use verify-firebase-token, not send-otp.', errorCode: 'FIREBASE_OTP_ONLY' };
  }
  const existing = await prisma.otpCode.findUnique({ where: { phone } });
  if (existing && Date.now() - existing.sentAt.getTime() < 60 * 1000) {
    throw { status: 429, error: 'Please wait 60 seconds before requesting another OTP.', errorCode: 'OTP_RATE_LIMITED' };
  }
  // Skip mode only bypasses the real send for phones on the allowlist. No
  // OtpCode row is written for a bypassed number since verifyOtpService
  // short-circuits before ever reading one.
  if (provider === 'skip' && await isSkipAllowlisted(phone)) {
    return { message: 'OTP sent successfully' };
  }
  // Anyone else while provider is "skip" (i.e. not on the allowlist) must
  // NOT get a real WhatsApp/Fast2SMS send — only an explicit provider of
  // "fast2sms" is allowed to reach that below. Same error/code the
  // "firebase" branch above throws, so callers handle both identically:
  // fall back to the Firebase client-side phone-auth flow instead.
  if (provider === 'skip') {
    throw { status: 400, error: 'OTP delivery is handled by Firebase phone auth — use verify-firebase-token, not send-otp.', errorCode: 'FIREBASE_OTP_ONLY' };
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const now = new Date();
  await prisma.otpCode.upsert({
    where: { phone },
    create: { phone, code, expiresAt: new Date(now.getTime() + 5 * 60 * 1000), sentAt: now },
    update: { code, expiresAt: new Date(now.getTime() + 5 * 60 * 1000), sentAt: now },
  });
  const sent = await sendWhatsAppOtp(phone, code) || await sendFast2SmsOtp(phone, code);
  if (!sent) console.log(`OTP for ${phone}: ${code}`);
  return { message: 'OTP sent successfully' };
}

// Human-facing labels for the cross-app role-mismatch error below — keyed on
// the account's EXISTING role (not the role the requesting app sent), since
// that's the account the phone number actually belongs to.
// Shared by both the OTP-store path (verifyOtpService) and the Firebase
// ID-token path (verifyFirebaseTokenService) — everything that happens once a
// phone number is confirmed verified, regardless of how it got verified.
// Deterministic own-code derivation — see the referralCode field's schema
// comment. Called only after the row exists (needs a real id).
function referralCodeFor(userId) {
  return `PG${userId.toString(36).toUpperCase()}`;
}

async function issueSessionForUser({ phone, name, email, role = 'customer', type = 'general', gobhiType, referralCode, linkedGymId }) {
  if (!VALID_ROLES.includes(role)) {
    throw { status: 400, error: ERROR_MESSAGES.INVALID_ROLE.message, errorCode: ERROR_MESSAGES.INVALID_ROLE.code };
  }
  // Phone/OTP and Firebase sign-in are both public, unauthenticated entry
  // points (customer + partner apps only) — gobhi/staff accounts must only
  // ever be created via the authenticated POST /admin/staff path. Without
  // this, anyone could verify an OTP for a brand-new phone number with
  // role:'gobhi' and self-provision a staff account.
  if (role === ROLES.GOBHI) {
    throw { status: 403, error: ERROR_MESSAGES.GOBHI_SIGNUP_FORBIDDEN.message, errorCode: ERROR_MESSAGES.GOBHI_SIGNUP_FORBIDDEN.code };
  }
  if (!VALID_TYPES.includes(type)) {
    throw { status: 400, error: ERROR_MESSAGES.INVALID_TYPE.message, errorCode: ERROR_MESSAGES.INVALID_TYPE.code };
  }

  let user = await prisma.user.findUnique({ where: { phone } });
  const isNewUser = !user;

  if (!user) {
    // Unlike GOBHI's block above (unconditional — gobhi never legitimately
    // logs in via phone/OTP at all), this only guards NEW-account creation:
    // an existing trainer (created by their employing partner via
    // createTrainerService) must still be able to log in through this same
    // phone/OTP flow — see the "token is always keyed off the account's
    // real DB role" comment below for why the caller-supplied `role` is
    // irrelevant once the row already exists.
    if (role === ROLES.TRAINER) {
      throw { status: 403, error: 'Trainer accounts can only be created by a gym partner.' };
    }
    // Resolve an incoming referral code to the referrer's id — silently
    // ignored if the code doesn't match anyone (typo'd code shouldn't block
    // signup). Self-referral is structurally impossible: this user's own row
    // (and the code derived from it) doesn't exist yet at this point.
    let referredByUserId = null;
    if (referralCode && typeof referralCode === 'string' && referralCode.trim()) {
      const referrer = await prisma.user.findUnique({ where: { referralCode: referralCode.trim().toUpperCase() } });
      if (referrer) referredByUserId = referrer.id;
    }
    // No existence check against gym-service here (a different service's
    // database) — same posture as an unrecognized referralCode: a bad/typo'd
    // gymId shouldn't be able to block signup. Worst case is a stale/invalid
    // linkedGymId that later fails to resolve client-side, not a broken login.
    const resolvedLinkedGymId = Number.isInteger(Number(linkedGymId)) && Number(linkedGymId) > 0
      ? Number(linkedGymId)
      : null;
    try {
      user = await prisma.user.create({
        data: {
          // Phone+OTP signup never collects a name, so this is left null rather
          // than a placeholder like 'User' — each app prompts for it once,
          // after first login, when it sees name is missing.
          name: name || null,
          phone,
          email: email || null,
          role,
          type,
          gobhiType: role === ROLES.GOBHI ? gobhiType : null,
          referredByUserId,
          linkedGymId: resolvedLinkedGymId,
          updatedAt: new Date(),
        },
      });
    } catch (err) {
      // P2002 on the phone-unique constraint means a concurrent verify call
      // for this same brand-new phone (double-tap, or a client retry on a
      // flaky connection) already created the account between our
      // findUnique above and this create. Fall through with the now-
      // existing row and let the referralCode step below no-op to the same
      // value, instead of surfacing a raw 500 for what should be a
      // successful login.
      if (err.code === 'P2002') {
        user = await prisma.user.findUnique({ where: { phone } });
        if (!user) throw err;
      } else {
        throw err;
      }
    }
    // Follow-up update rather than a single create: the code is derived
    // from the id Postgres just assigned, so it can't be known beforehand.
    user = await prisma.user.update({
      where: { id: user.id },
      data: { referralCode: referralCodeFor(user.id) },
    });
  } else if (!user.isActive) {
    throw { status: 403, error: ERROR_MESSAGES.ACCOUNT_DEACTIVATED.message, errorCode: ERROR_MESSAGES.ACCOUNT_DEACTIVATED.code };
  }

  // Attendance-SaaS wedge: if an existing user logs in via a gym's join link
  // and they don't already have a linkedGymId, backfill it. Only sets when
  // currently null — once set it's immutable (same contract as new-user flow).
  if (user && !user.linkedGymId) {
    const resolvedLinkedGymId = Number.isInteger(Number(linkedGymId)) && Number(linkedGymId) > 0
      ? Number(linkedGymId)
      : null;
    if (resolvedLinkedGymId) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { linkedGymId: resolvedLinkedGymId },
      });
    }
  }

  // Token is always keyed off the account's real DB role/type, never the
  // caller-supplied `role` above — that param only decides what a *new*
  // account gets created as. An existing account authenticates as whatever
  // it already is, regardless of which app/site the login came through
  // (e.g. an existing partner logging in via the customer website).
  const accessToken = generateAccessToken(user.id, user.role, user.type);
  const refreshToken = await issueRefreshFamily(user.id);

  // Activation funnel: signup_completed (new) vs login_completed (returning).
  // distinct_id is the userId so this stitches with the client's pre-login
  // anonymous events once the app calls identify(userId). linked_gym_id
  // (attendance-SaaS wedge) is only ever non-null on a genuine signup_completed
  // — an existing user's linkedGymId can't change on a later login (see the
  // resolvedLinkedGymId comment above), so this measures the /join funnel
  // without a separate event name.
  track(isNewUser ? 'signup_completed' : 'login_completed', user.id, {
    role: user.role,
    user_type: user.type,
    linked_gym_id: user.linkedGymId ?? null,
  });

  // Tell partners, at login, whether their gym already exists so the app can
  // route to the dashboard vs. onboarding without relying on local state. A
  // brand-new user has no gym yet; otherwise ask gym-service.
  let onboarding;
  if (user.role === ROLES.PARTNER) {
    onboarding = isNewUser
      ? { hasGym: false, approved: false, gymId: null, rejectionReason: null, gymCount: 0, hasOtherGyms: false }
      : await fetchPartnerGymSummary(user.id);
  }

  return {
    accessToken,
    refreshToken,
    isNewUser,
    ...(onboarding !== undefined && { onboarding }),
    user: { id: user.id, phone: user.phone, email: user.email, name: user.name, role: user.role, type: user.type, gobhiType: user.gobhiType, linkedGymId: user.linkedGymId, trainerGymId: user.trainerGymId },
  };
}

export async function verifyOtpService({ phone: rawPhone, otp, name, email, role = 'customer', type = 'general', gobhiType, referralCode, linkedGymId }) {
  if (!rawPhone) {
    throw { status: 400, error: ERROR_MESSAGES.PHONE_REQUIRED.message, errorCode: ERROR_MESSAGES.PHONE_REQUIRED.code };
  }
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    throw { status: 400, error: ERROR_MESSAGES.INVALID_PHONE.message, errorCode: ERROR_MESSAGES.INVALID_PHONE.code };
  }
  const provider = await loadOtpProvider();
  const skipBypass = provider === 'skip' && otp === SKIP_OTP_CODE && await isSkipAllowlisted(phone);
  if (!skipBypass) {
    const entry = await prisma.otpCode.findUnique({ where: { phone } });
    if (!entry || Date.now() > entry.expiresAt.getTime()) {
      if (entry) await prisma.otpCode.delete({ where: { phone } }).catch(() => {});
      throw { status: 400, error: ERROR_MESSAGES.OTP_EXPIRED.message, errorCode: ERROR_MESSAGES.OTP_EXPIRED.code };
    }
    if (entry.attempts >= OTP_MAX_ATTEMPTS) {
      // Too many wrong guesses against this exact code — force a fresh
      // resend rather than continuing to allow guesses for the rest of its
      // 5-minute window. Previously the only ceiling here was the gateway's
      // per-IP rate limit, which a distributed-IP attacker isn't bound by.
      await prisma.otpCode.delete({ where: { phone } }).catch(() => {});
      throw { status: 400, error: ERROR_MESSAGES.OTP_EXPIRED.message, errorCode: ERROR_MESSAGES.OTP_EXPIRED.code };
    }
    if (!safeCompareStrings(entry.code, otp)) {
      await prisma.otpCode.update({ where: { phone }, data: { attempts: { increment: 1 } } }).catch(() => {});
      throw { status: 400, error: ERROR_MESSAGES.INVALID_OTP.message, errorCode: ERROR_MESSAGES.INVALID_OTP.code };
    }
    await prisma.otpCode.delete({ where: { phone } }).catch(() => {});
  }

  return issueSessionForUser({ phone, name, email, role, type, gobhiType, referralCode, linkedGymId });
}

export async function verifyFirebaseTokenService({ idToken, name, email, role = 'customer', type = 'general', gobhiType, referralCode, linkedGymId }) {
  if (!idToken) {
    throw { status: 400, error: 'idToken is required', errorCode: 'ID_TOKEN_REQUIRED' };
  }
  const { verifyFirebaseIdToken } = await import('../utils/firebaseAdmin.js');
  let decoded;
  try {
    decoded = await verifyFirebaseIdToken(idToken);
  } catch (err) {
    console.error('Firebase ID token verification failed:', err.message);
    throw { status: 401, error: 'Invalid or expired Firebase token', errorCode: 'INVALID_FIREBASE_TOKEN' };
  }
  if (!decoded.phone_number) {
    throw { status: 400, error: 'Firebase token has no verified phone number', errorCode: 'NO_PHONE_IN_TOKEN' };
  }
  // Firebase returns E.164 (+91XXXXXXXXXX); existing users are keyed on the
  // same canonical bare-10-digit phone the OTP-store path uses — normalize so
  // the same person resolves to the same account regardless of which
  // provider verified them.
  const phone = normalizePhone(decoded.phone_number);
  if (!phone) {
    throw { status: 400, error: 'Firebase token has an invalid phone number', errorCode: 'INVALID_PHONE_IN_TOKEN' };
  }

  return issueSessionForUser({ phone, name, email, role, type, gobhiType, referralCode, linkedGymId });
}

// Staff-only Google sign-in (admin portal). Unlike verifyFirebaseTokenService
// above, this never creates a user — it only authenticates an email that
// already has a gobhi-role account (provisioned via the manual signup path),
// so owning a Google account alone can never grant staff/payout access.
export async function googleSignInService({ idToken }) {
  if (!idToken) {
    throw { status: 400, error: 'idToken is required', errorCode: 'ID_TOKEN_REQUIRED' };
  }
  const { verifyStaffFirebaseIdToken } = await import('../utils/firebaseAdmin.js');
  let decoded;
  try {
    decoded = await verifyStaffFirebaseIdToken(idToken);
  } catch (err) {
    console.error('Google ID token verification failed:', err.message);
    throw { status: 401, error: 'Invalid or expired Google sign-in token', errorCode: 'INVALID_FIREBASE_TOKEN' };
  }
  if (!decoded.email || !decoded.email_verified) {
    throw { status: 400, error: 'Google account has no verified email', errorCode: 'NO_EMAIL_IN_TOKEN' };
  }

  const user = await prisma.user.findUnique({ where: { email: decoded.email } });
  if (!user || user.role !== ROLES.GOBHI) {
    throw { status: 403, error: 'No staff account exists for this email', errorCode: 'NO_STAFF_ACCOUNT' };
  }
  if (!user.isActive) {
    throw { status: 403, error: ERROR_MESSAGES.ACCOUNT_DEACTIVATED.message, errorCode: ERROR_MESSAGES.ACCOUNT_DEACTIVATED.code };
  }

  const accessToken = generateAccessToken(user.id, user.role, user.type);
  const refreshToken = await issueRefreshFamily(user.id);
  track('login_completed', user.id, { role: user.role, user_type: user.type, method: 'google' });

  return {
    accessToken,
    refreshToken,
    user: { id: user.id, phone: user.phone, email: user.email, name: user.name, role: user.role, type: user.type, gobhiType: user.gobhiType },
  };
}

// --- Staff (gobhi) management, driven by the admin portal's own Staff page ---

export async function listStaffService() {
  const staff = await prisma.user.findMany({
    where: { role: ROLES.GOBHI },
    select: { id: true, name: true, email: true, gobhiType: true, isActive: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  return staff;
}

// Reuses signupService's validation/creation, but hardcodes role to gobhi —
// the client can never smuggle in a different role through this endpoint,
// unlike the public /signup route this wraps.
export async function createStaffService({ name, email, password, gobhiType }, actorId) {
  const result = await signupService({ name, email, password, role: ROLES.GOBHI, type: 'general', gobhiType });
  track('staff_account_created', actorId, { newUserId: result.user.id, gobhiType });
  return result;
}

const STAFF_STATUS_MAX_ATTEMPTS = 4;
const STAFF_STATUS_RETRY_BASE_MS = 40;

export async function updateStaffStatusService(targetId, isActive, actorId) {
  const id = Number(targetId);
  if (id === actorId) {
    throw { status: 400, error: 'You cannot change your own access' };
  }
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target || target.role !== ROLES.GOBHI) {
    throw { status: 404, error: 'Staff account not found' };
  }

  for (let attempt = 1; attempt <= STAFF_STATUS_MAX_ATTEMPTS; attempt++) {
    try {
      const updated = await prisma.$transaction(async (tx) => {
        if (!isActive) {
          // Serializable isolation makes the count-check-then-update atomic
          // against a concurrent deactivation of a DIFFERENT staff account:
          // Postgres detects the overlapping read (active-gobhi count) vs.
          // write (a gobhi row's isActive) between two such transactions and
          // aborts one as a serialization failure (P2034) instead of letting
          // both commit and zero out active staff. Same retry-on-P2034
          // pattern as booking-service's reserveBookingSlot.
          const activeCount = await tx.user.count({ where: { role: ROLES.GOBHI, isActive: true } });
          if (activeCount <= 1) {
            throw { status: 400, error: 'Cannot deactivate the last remaining active staff account' };
          }
        }
        return tx.user.update({
          where: { id },
          data: { isActive },
          select: { id: true, name: true, email: true, gobhiType: true, isActive: true, createdAt: true },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      track(isActive ? 'staff_account_reactivated' : 'staff_account_revoked', actorId, { targetUserId: id });
      return updated;
    } catch (err) {
      if (err && err.status) throw err;
      if (err?.code === 'P2034' && attempt < STAFF_STATUS_MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, STAFF_STATUS_RETRY_BASE_MS * attempt));
        continue;
      }
      throw err;
    }
  }
}

// Partner-only — mirrors createStaffService's "never public self-signup"
// posture (see the ROLES.TRAINER guard in issueSessionForUser above), but
// phone+OTP instead of email+password since a gym trainer is exactly the
// kind of individual who already expects that login pattern from the
// customer/partner apps. assertPartnerOwnsGym is the same ownership check
// booking-service/wallet-service already use for their own gym-scoped
// partner endpoints — duplicated here for the same reason those are
// duplicated per-service (independent microservices, no shared code layer).
export async function createTrainerService({ name, phone: rawPhone }, gymId, partnerId) {
  await assertPartnerOwnsGym(gymId, partnerId);

  const phone = normalizePhone(rawPhone);
  if (!phone) {
    throw { status: 400, error: ERROR_MESSAGES.INVALID_PHONE.message, errorCode: ERROR_MESSAGES.INVALID_PHONE.code };
  }
  const trimmedName = (name || '').trim();
  if (!trimmedName) {
    throw { status: 400, error: 'name is required' };
  }

  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    throw {
      status: 409,
      error: existing.role === ROLES.TRAINER
        ? 'This phone number is already registered as a trainer.'
        : `This phone number is already registered as a ${existing.role}. A phone number can only be one account.`,
    };
  }

  const trainer = await prisma.user.create({
    data: {
      name: trimmedName,
      phone,
      role: ROLES.TRAINER,
      type: 'general',
      trainerGymId: gymId,
      updatedAt: new Date(),
    },
  });
  track('trainer_account_created', partnerId, { trainerId: trainer.id, gymId });
  return { id: trainer.id, name: trainer.name, phone: trainer.phone, isActive: trainer.isActive, createdAt: trainer.createdAt };
}

export async function listTrainersForGymService(gymId, partnerId) {
  await assertPartnerOwnsGym(gymId, partnerId);
  return prisma.user.findMany({
    where: { role: ROLES.TRAINER, trainerGymId: gymId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, phone: true, isActive: true, createdAt: true },
  });
}

// No "last active trainer" floor (unlike updateStaffStatusService) — a gym
// can legitimately have zero active trainers, that's just a gym without
// trainers, not a locked-out platform.
export async function updateTrainerStatusService(trainerId, isActive, gymId, partnerId) {
  await assertPartnerOwnsGym(gymId, partnerId);
  const trainer = await prisma.user.findUnique({ where: { id: trainerId } });
  if (!trainer || trainer.role !== ROLES.TRAINER || trainer.trainerGymId !== gymId) {
    throw { status: 404, error: 'Trainer not found at this gym' };
  }
  const updated = await prisma.user.update({
    where: { id: trainerId },
    data: { isActive },
    select: { id: true, name: true, phone: true, isActive: true, createdAt: true },
  });
  track(isActive ? 'trainer_account_reactivated' : 'trainer_account_deactivated', partnerId, { trainerId, gymId });
  return updated;
}
