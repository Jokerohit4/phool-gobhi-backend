import { hash, compare } from 'bcrypt';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { generateAccessToken, generateRefreshToken } from '../utils/generateTokens.js';
import { VALID_ROLES, VALID_TYPES, VALID_GOBHI_TYPES, ROLES } from '../constants/userEnums.js';
import { ERROR_MESSAGES } from '../constants/errorMessages.js';

const prisma = new PrismaClient();

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
    const accessToken = generateAccessToken(user.id, user.role, user.type);
    return { accessToken };
  } catch (err) {
    if (err.status) throw err;
    throw { status: 403, error: ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH.message, errorCode: ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH.code };
  }
}

// In-memory OTP store: phone → { code, expiresAt }
const otpStore = new Map();

function normalizeToE164(phone) {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10 ? `91${digits}` : digits;
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
  try {
    const res = await fetch(`https://www.fast2sms.com/dev/bulkV2?authorization=${apiKey}&route=otp&variables_values=${code}&numbers=${digits}`, {
      headers: { 'cache-control': 'no-cache' },
    });
    if (!res.ok) { console.error('Fast2SMS OTP failed:', res.status); return false; }
    return true;
  } catch (err) {
    console.error('Fast2SMS OTP error:', err.message);
    return false;
  }
}

export async function sendOtpService(phone) {
  if (!phone) {
    throw { status: 400, error: ERROR_MESSAGES.PHONE_REQUIRED.message, errorCode: ERROR_MESSAGES.PHONE_REQUIRED.code };
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  otpStore.set(phone, { code, expiresAt: Date.now() + 5 * 60 * 1000 });
  const sent = await sendWhatsAppOtp(phone, code) || await sendFast2SmsOtp(phone, code);
  if (!sent) console.log(`OTP for ${phone}: ${code}`);
  const response = { message: 'OTP sent successfully' };
  if (process.env.NODE_ENV !== 'production') response.otp = code;
  return response;
}

export async function verifyOtpService({ phone, otp, name, email, role = 'customer', type = 'general', gobhiType }) {
  if (!phone) {
    throw { status: 400, error: ERROR_MESSAGES.PHONE_REQUIRED.message, errorCode: ERROR_MESSAGES.PHONE_REQUIRED.code };
  }
  if (!VALID_ROLES.includes(role)) {
    throw { status: 400, error: ERROR_MESSAGES.INVALID_ROLE.message, errorCode: ERROR_MESSAGES.INVALID_ROLE.code };
  }
  if (!VALID_TYPES.includes(type)) {
    throw { status: 400, error: ERROR_MESSAGES.INVALID_TYPE.message, errorCode: ERROR_MESSAGES.INVALID_TYPE.code };
  }
  const isDev = process.env.NODE_ENV !== 'production';
  const DEV_OTP = '12345';
  if (!(isDev && otp === DEV_OTP)) {
    const entry = otpStore.get(phone);
    if (!entry || Date.now() > entry.expiresAt) {
      otpStore.delete(phone);
      throw { status: 400, error: ERROR_MESSAGES.OTP_EXPIRED.message, errorCode: ERROR_MESSAGES.OTP_EXPIRED.code };
    }
    if (entry.code !== otp) {
      throw { status: 400, error: ERROR_MESSAGES.INVALID_OTP.message, errorCode: ERROR_MESSAGES.INVALID_OTP.code };
    }
    otpStore.delete(phone);
  }

  let user = await prisma.user.findUnique({ where: { phone } });
  const isNewUser = !user;

  if (!user) {
    user = await prisma.user.create({
      data: {
        name: name || 'User',
        phone,
        email: email || null,
        role,
        type,
        gobhiType: role === ROLES.GOBHI ? gobhiType : null,
        updatedAt: new Date(),
      },
    });
  }

  const accessToken = generateAccessToken(user.id, user.role, user.type);
  const refreshToken = generateRefreshToken(user.id);
  return {
    accessToken,
    refreshToken,
    isNewUser,
    user: { id: user.id, phone: user.phone, email: user.email, name: user.name, role: user.role, type: user.type, gobhiType: user.gobhiType },
  };
}
