import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const VALID_PROVIDERS = ['fast2sms', 'firebase', 'skip'];

// Same last-10-digits normalization pitchAccessService uses for phone
// contacts — accepts +91XXXXXXXXXX, 91XXXXXXXXXX, or plain XXXXXXXXXX.
function normalizePhone(raw) {
  return String(raw ?? '').replace(/\D/g, '').slice(-10);
}

// Defaults to "firebase" until an admin has ever saved a row — same "no row
// yet" convention as loadAppVersionConfig/loadLaunchGate in authController.js.
// The legacy OTP_PROVIDER env fallback is gone: fast2sms is only ever active
// when an admin explicitly selects it via the admin portal (PUT
// /api/auth/otp-config/admin), never by environment alone.
export async function loadOtpProvider() {
  const row = await prisma.otpProviderSetting.findUnique({ where: { id: 1 } });
  return row?.provider || 'firebase';
}

export async function loadOtpProviderAdmin() {
  const row = await prisma.otpProviderSetting.findUnique({ where: { id: 1 } });
  return {
    provider: row?.provider || 'firebase',
    updatedAt: row?.updatedAt || null,
  };
}

export async function updateOtpProvider(provider, updatedBy) {
  if (!VALID_PROVIDERS.includes(provider)) {
    throw { status: 400, error: `provider must be one of ${VALID_PROVIDERS.join(', ')}` };
  }
  return prisma.otpProviderSetting.upsert({
    where: { id: 1 },
    create: { id: 1, provider, updatedBy },
    update: { provider, updatedBy },
  });
}

export async function isSkipAllowlisted(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  const match = await prisma.otpSkipAllowlistEntry.findUnique({ where: { phone: normalized } });
  return !!match;
}

export async function listSkipAllowlist() {
  return prisma.otpSkipAllowlistEntry.findMany({ orderBy: { createdAt: 'desc' } });
}

export async function addSkipAllowlistEntry({ phone, note }) {
  const normalized = normalizePhone(phone);
  if (normalized.length !== 10) {
    throw { status: 400, error: 'Enter a valid 10-digit phone number' };
  }
  try {
    return await prisma.otpSkipAllowlistEntry.create({
      data: { phone: normalized, note: note || null },
    });
  } catch (err) {
    if (err.code === 'P2002') {
      throw { status: 409, error: 'This number is already on the list' };
    }
    throw err;
  }
}

export async function removeSkipAllowlistEntry(id) {
  try {
    await prisma.otpSkipAllowlistEntry.delete({ where: { id: Number(id) } });
  } catch (err) {
    if (err.code === 'P2025') {
      throw { status: 404, error: 'Entry not found' };
    }
    throw err;
  }
}
