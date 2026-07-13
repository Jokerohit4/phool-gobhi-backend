import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Same normalization the website's isAllowedContact used to do locally:
// lowercase-trim for email, last-10-digits for phone (accepts +91XXXXXXXXXX,
// 91XXXXXXXXXX, or plain XXXXXXXXXX — matches auth-service's own OTP phone handling).
function normalizeContact(raw) {
  const value = String(raw ?? '').trim();
  if (value.includes('@')) {
    return { type: 'email', value: value.toLowerCase() };
  }
  const digits = value.replace(/\D/g, '');
  return { type: 'phone', value: digits.slice(-10) };
}

export async function checkPitchAccess(rawContact) {
  const { type, value } = normalizeContact(rawContact);
  if (!value) return false;
  const match = await prisma.pitchAccessContact.findUnique({
    where: { type_value: { type, value } },
  });
  return !!match;
}

export async function listPitchAccessContacts() {
  return prisma.pitchAccessContact.findMany({ orderBy: { createdAt: 'desc' } });
}

export async function addPitchAccessContact({ type, value, note }) {
  if (!['email', 'phone'].includes(type)) {
    throw { status: 400, error: 'type must be "email" or "phone"' };
  }
  const normalized = normalizeContact(value);
  if (!normalized.value || normalized.type !== type) {
    throw { status: 400, error: `Invalid ${type}` };
  }
  try {
    return await prisma.pitchAccessContact.create({
      data: { type, value: normalized.value, note: note || null },
    });
  } catch (err) {
    if (err.code === 'P2002') {
      throw { status: 409, error: 'This contact is already on the list' };
    }
    throw err;
  }
}

export async function removePitchAccessContact(id) {
  try {
    await prisma.pitchAccessContact.delete({ where: { id: Number(id) } });
  } catch (err) {
    if (err.code === 'P2025') {
      throw { status: 404, error: 'Contact not found' };
    }
    throw err;
  }
}
