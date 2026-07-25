import { hash, compare } from 'bcrypt';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { generateAccessToken, generateRefreshToken } from '../utils/generateTokens.js';
import { VALID_ROLES, VALID_TYPES, VALID_GOBHI_TYPES, ROLES } from '../constants/userEnums.js';
import { ERROR_MESSAGES } from '../constants/errorMessages.js';
import { track } from '../utils/analytics.js';
import { googleIdTokenHeader } from '../utils/googleIdToken.js';

const prisma = new PrismaClient();

const GYM_SERVICE_URL = process.env.GYM_SERVICE_URL || 'http://gym-service:5004';

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
    const refreshToken = generateRefreshToken(user.id);
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
    const refreshToken = generateRefreshToken(user.id);
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
    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const user = await prisma.user.findUnique({ where: { id: payload.id } });
    if (!user) throw { status: 404, error: 'User not found', errorCode: 'USER_NOT_FOUND' };
    if (!user.isActive) throw { status: 403, error: ERROR_MESSAGES.ACCOUNT_DEACTIVATED.message, errorCode: ERROR_MESSAGES.ACCOUNT_DEACTIVATED.code };
    const accessToken = generateAccessToken(user.id, user.role, user.type);
    return { accessToken };
  } catch (err) {
    if (err.status) throw err;
    throw { status: 403, error: ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH.message, errorCode: ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH.code };
  }
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
function normalizePhone(input) {
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
  const existing = await prisma.otpCode.findUnique({ where: { phone } });
  if (existing && Date.now() - existing.sentAt.getTime() < 60 * 1000) {
    throw { status: 429, error: 'Please wait 60 seconds before requesting another OTP.', errorCode: 'OTP_RATE_LIMITED' };
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const now = new Date();
  await prisma.otpCode.upsert({
    where: { phone },
    create: { phone, code, expiresAt: new Date(now.getTime() + 5 * 60 * 1000), sentAt: now },
    update: { code, expiresAt: new Date(now.getTime() + 5 * 60 * 1000), sentAt: now },
  });
  // Skip paid SMS while ALLOW_DEV_OTP is on — the 123456 bypass makes a real
  // send pointless, and this ties "stop spending on SMS" to the same flag
  // that has to be flipped back for real verification to resume, so the two
  // can't drift out of sync.
  const skipPaidSms = process.env.ALLOW_DEV_OTP === 'true';
  const sent = await sendWhatsAppOtp(phone, code) || (!skipPaidSms && await sendFast2SmsOtp(phone, code));
  if (!sent) console.log(`OTP for ${phone}: ${code}`);
  const response = { message: 'OTP sent successfully' };
  // Echoing the OTP is opt-in (set ALLOW_DEV_OTP=true in dev only) so an
  // incomplete prod env can never leak codes.
  if (process.env.ALLOW_DEV_OTP === 'true') response.otp = code;
  return response;
}

// Human-facing labels for the cross-app role-mismatch error below — keyed on
// the account's EXISTING role (not the role the requesting app sent), since
// that's the account the phone number actually belongs to.
// Shared by both the OTP-store path (verifyOtpService) and the Firebase
// ID-token path (verifyFirebaseTokenService) — everything that happens once a
// phone number is confirmed verified, regardless of how it got verified.
async function issueSessionForUser({ phone, name, email, role = 'customer', type = 'general', gobhiType }) {
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
        updatedAt: new Date(),
      },
    });
  } else if (!user.isActive) {
    throw { status: 403, error: ERROR_MESSAGES.ACCOUNT_DEACTIVATED.message, errorCode: ERROR_MESSAGES.ACCOUNT_DEACTIVATED.code };
  }

  // Token is always keyed off the account's real DB role/type, never the
  // caller-supplied `role` above — that param only decides what a *new*
  // account gets created as. An existing account authenticates as whatever
  // it already is, regardless of which app/site the login came through
  // (e.g. an existing partner logging in via the customer website).
  const accessToken = generateAccessToken(user.id, user.role, user.type);
  const refreshToken = generateRefreshToken(user.id);

  // Activation funnel: signup_completed (new) vs login_completed (returning).
  // distinct_id is the userId so this stitches with the client's pre-login
  // anonymous events once the app calls identify(userId).
  track(isNewUser ? 'signup_completed' : 'login_completed', user.id, {
    role: user.role,
    user_type: user.type,
  });

  // Tell partners, at login, whether their gym already exists so the app can
  // route to the dashboard vs. onboarding without relying on local state. A
  // brand-new user has no gym yet; otherwise ask gym-service.
  let onboarding;
  if (user.role === ROLES.PARTNER) {
    onboarding = isNewUser
      ? { hasGym: false, approved: false, gymId: null }
      : await fetchPartnerGymSummary(user.id);
  }

  return {
    accessToken,
    refreshToken,
    isNewUser,
    ...(onboarding !== undefined && { onboarding }),
    user: { id: user.id, phone: user.phone, email: user.email, name: user.name, role: user.role, type: user.type, gobhiType: user.gobhiType },
  };
}

export async function verifyOtpService({ phone: rawPhone, otp, name, email, role = 'customer', type = 'general', gobhiType }) {
  if (!rawPhone) {
    throw { status: 400, error: ERROR_MESSAGES.PHONE_REQUIRED.message, errorCode: ERROR_MESSAGES.PHONE_REQUIRED.code };
  }
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    throw { status: 400, error: ERROR_MESSAGES.INVALID_PHONE.message, errorCode: ERROR_MESSAGES.INVALID_PHONE.code };
  }
  const isDev = process.env.ALLOW_DEV_OTP === 'true';
  const DEV_OTP = '123456';
  if (!(isDev && otp === DEV_OTP)) {
    const entry = await prisma.otpCode.findUnique({ where: { phone } });
    if (!entry || Date.now() > entry.expiresAt.getTime()) {
      if (entry) await prisma.otpCode.delete({ where: { phone } }).catch(() => {});
      throw { status: 400, error: ERROR_MESSAGES.OTP_EXPIRED.message, errorCode: ERROR_MESSAGES.OTP_EXPIRED.code };
    }
    if (entry.code !== otp) {
      throw { status: 400, error: ERROR_MESSAGES.INVALID_OTP.message, errorCode: ERROR_MESSAGES.INVALID_OTP.code };
    }
    await prisma.otpCode.delete({ where: { phone } }).catch(() => {});
  }

  return issueSessionForUser({ phone, name, email, role, type, gobhiType });
}

export async function verifyFirebaseTokenService({ idToken, name, email, role = 'customer', type = 'general', gobhiType }) {
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

  return issueSessionForUser({ phone, name, email, role, type, gobhiType });
}

// Staff-only Google sign-in (admin portal). Unlike verifyFirebaseTokenService
// above, this never creates a user — it only authenticates an email that
// already has a gobhi-role account (provisioned via the manual signup path),
// so owning a Google account alone can never grant staff/payout access.
export async function googleSignInService({ idToken }) {
  if (!idToken) {
    throw { status: 400, error: 'idToken is required', errorCode: 'ID_TOKEN_REQUIRED' };
  }
  const { verifyFirebaseIdToken } = await import('../utils/firebaseAdmin.js');
  let decoded;
  try {
    decoded = await verifyFirebaseIdToken(idToken);
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
  const refreshToken = generateRefreshToken(user.id);
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

export async function updateStaffStatusService(targetId, isActive, actorId) {
  const id = Number(targetId);
  if (id === actorId) {
    throw { status: 400, error: 'You cannot change your own access' };
  }
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target || target.role !== ROLES.GOBHI) {
    throw { status: 404, error: 'Staff account not found' };
  }
  if (!isActive) {
    const activeCount = await prisma.user.count({ where: { role: ROLES.GOBHI, isActive: true } });
    if (activeCount <= 1) {
      throw { status: 400, error: 'Cannot deactivate the last remaining active staff account' };
    }
  }
  const updated = await prisma.user.update({
    where: { id },
    data: { isActive },
    select: { id: true, name: true, email: true, gobhiType: true, isActive: true, createdAt: true },
  });
  track(isActive ? 'staff_account_reactivated' : 'staff_account_revoked', actorId, { targetUserId: id });
  return updated;
}
