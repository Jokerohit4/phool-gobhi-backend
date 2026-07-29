import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { signRefreshToken } from '../utils/generateTokens.js';

const prisma = new PrismaClient();

const FAMILY_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // matches the old flat 7d JWT expiry
// Legitimate concurrent refreshes (two tabs, or a client's own two refresh
// call sites racing before they're fixed to share one lock) present the same
// pre-rotation token within a few ms of each other. A replay of an
// already-rotated token this soon after rotation is treated as that benign
// race, not theft — see rotate() below. Anything outside this window is
// timed like an attacker replaying a stolen token, and revokes the family.
const REUSE_GRACE_MS = 10 * 1000;

// Issues the first token in a brand-new rotation family — called by every
// login path (loginService, issueSessionForUser via OTP/Firebase). Returns a
// signed refresh JWT; the DB row is what makes rotation/revocation possible.
export async function issueRefreshFamily(userId) {
  const familyId = crypto.randomUUID();
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + FAMILY_LIFETIME_MS);
  await prisma.refreshToken.create({
    data: { jti, familyId, userId, expiresAt },
  });
  return signRefreshToken(userId, jti, familyId, expiresAt);
}

// Revokes every token in a family — used by explicit logout and by reuse
// detection. Idempotent; safe to call on an already-revoked family.
export async function revokeFamily(familyId) {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// Verifies + rotates a refresh token. Returns { accessTokenPayload: {id},
// refreshToken } on success. Throws { status, error, errorCode } on any
// rejection — same shape refreshTokenService/authController already expect.
export async function rotate(token) {
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  } catch {
    throw { status: 403, error: 'Invalid or expired refresh token', errorCode: 'E109' };
  }
  const { id: userId, jti, familyId } = payload;
  if (!jti || !familyId) {
    // Pre-rotation tokens (issued before this feature shipped) carry no
    // jti/familyId and can never match a RefreshToken row — reject cleanly
    // rather than throwing on the null-jti lookup below.
    throw { status: 403, error: 'Invalid or expired refresh token', errorCode: 'E109' };
  }

  const row = await prisma.refreshToken.findUnique({ where: { jti } });
  if (!row) {
    throw { status: 403, error: 'Invalid or expired refresh token', errorCode: 'E109' };
  }
  if (row.revokedAt) {
    throw { status: 403, error: 'Session revoked, please log in again', errorCode: 'E120' };
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw { status: 403, error: 'Invalid or expired refresh token', errorCode: 'E109' };
  }

  if (row.usedAt) {
    const withinGrace = Date.now() - row.usedAt.getTime() <= REUSE_GRACE_MS;
    if (!withinGrace) {
      // Reuse of an already-rotated token well after the fact — theft
      // signal. Revoke the whole family so the stolen token (and the
      // legitimate one it was cloned from) both stop working.
      await revokeFamily(familyId);
      throw { status: 403, error: 'Session revoked, please log in again', errorCode: 'E120' };
    }
    // Benign race: re-hand-out the token this row was already rotated into,
    // rather than rotating again (which would just create a second race).
    const nextRow = row.replacedByJti
      ? await prisma.refreshToken.findUnique({ where: { jti: row.replacedByJti } })
      : null;
    if (!nextRow || nextRow.revokedAt) {
      throw { status: 403, error: 'Invalid or expired refresh token', errorCode: 'E109' };
    }
    return {
      userId,
      refreshToken: signRefreshToken(userId, nextRow.jti, familyId, nextRow.expiresAt),
    };
  }

  const newJti = crypto.randomUUID();
  await prisma.$transaction([
    prisma.refreshToken.create({
      data: { jti: newJti, familyId, userId, expiresAt: row.expiresAt },
    }),
    prisma.refreshToken.update({
      where: { jti },
      data: { usedAt: new Date(), replacedByJti: newJti },
    }),
  ]);

  return {
    userId,
    refreshToken: signRefreshToken(userId, newJti, familyId, row.expiresAt),
  };
}

// Logout: revoke the presented token's whole family. Always best-effort from
// the caller's point of view — an already-invalid/expired token is treated
// as "nothing to revoke" rather than an error, so logout never fails on this.
export async function revokeByToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  } catch {
    return;
  }
  if (!payload.familyId) return;
  await revokeFamily(payload.familyId);
}
