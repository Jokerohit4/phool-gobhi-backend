import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import prisma from '../db/prisma.js';
import { signRefreshToken } from '../utils/generateTokens.js';


// Each successful refresh renews the session for 30 days. There is no fixed
// cutoff from the original login; an unused session still expires naturally.
const REFRESH_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
// Legitimate concurrent refreshes (two tabs, or a client's own two refresh
// call sites racing before they're fixed to share one lock) present the same
// pre-rotation token within a few ms of each other. A replay of an
// already-rotated token this soon after rotation is treated as that benign
// race, not theft — see rotate() below. Anything outside this window is
// timed like an attacker replaying a stolen token, and revokes the family.
const REUSE_GRACE_MS = 10 * 1000;
// How long after a rotation a client may still present the PREVIOUS token and
// be handed the (still unused) successor — see handleAlreadyUsedToken. It only
// applies while nothing has used that successor, so it does not let a replay
// fork or outlive a live session. Bounded so an old stolen token cannot be
// exchanged indefinitely.
const LOST_ROTATION_RECOVERY_MS = 7 * 24 * 60 * 60 * 1000;

// Issues the first token in a brand-new rotation family — called by every
// login path (loginService, issueSessionForUser via OTP/Firebase). Returns a
// signed refresh JWT; the DB row is what makes rotation/revocation possible.
export async function issueRefreshFamily(userId) {
  const familyId = crypto.randomUUID();
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_LIFETIME_MS);
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

// Every 403 below maps to one of two client-visible codes (E109 / E120), so
// the response alone cannot say WHY a session ended. This logs the specific
// reason (never the token) so a "users got signed out" report can be traced to
// a cause from Cloud Run logs instead of guessed at. The thrown shape is
// unchanged.
function reject(error, errorCode, reason, ctx = {}) {
  console.warn(JSON.stringify({ message: 'refresh_rejected', reason, errorCode, ...ctx }));
  return { status: 403, error, errorCode };
}

const INVALID = 'Invalid or expired refresh token';
const REVOKED = 'Session revoked, please log in again';

// Verifies + rotates a refresh token. Returns { accessTokenPayload: {id},
// refreshToken } on success. Throws { status, error, errorCode } on any
// rejection — same shape refreshTokenService/authController already expect.
export async function rotate(token, { beforeRotate } = {}) {
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  } catch (err) {
    // TokenExpiredError vs JsonWebTokenError (bad signature/malformed) tells a
    // lapsed session apart from a secret mismatch or a corrupted client token.
    throw reject(INVALID, 'E109', 'jwt_verify_failed', { jwtError: err?.name });
  }
  const { id: userId, jti, familyId } = payload;
  if (!jti || !familyId) {
    // Pre-rotation tokens (issued before this feature shipped) carry no
    // jti/familyId and can never match a RefreshToken row — reject cleanly
    // rather than throwing on the null-jti lookup below.
    throw reject(INVALID, 'E109', 'legacy_token_without_jti', { userId });
  }

  const row = await prisma.refreshToken.findUnique({ where: { jti } });
  if (!row) {
    throw reject(INVALID, 'E109', 'token_row_not_found', { userId, familyId, jti });
  }
  if (row.revokedAt) {
    throw reject(REVOKED, 'E120', 'family_already_revoked', {
      userId, familyId, jti,
      revokedAgoMs: Date.now() - row.revokedAt.getTime(),
      wasUsed: Boolean(row.usedAt),
    });
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw reject(INVALID, 'E109', 'token_row_expired', { userId, familyId, jti });
  }

  // Finish fallible account checks before consuming this single-use token.
  // A database outage during those checks must leave it available to retry.
  if (beforeRotate) await beforeRotate(userId);

  if (row.usedAt) {
    return handleAlreadyUsedToken(row, userId, familyId);
  }

  // Atomically claim this token for rotation — the conditional
  // updateMany(usedAt: null) and the successor's create happen in one
  // transaction, so two concurrent rotate() calls presenting the same
  // not-yet-used token (two tabs, a client retry racing the original
  // request, or a stolen token replayed at the same instant) can never both
  // "win" and fork two independent successor chains from one predecessor —
  // a plain findUnique-then-separately-write let exactly that happen,
  // because both calls could pass the old `!row.usedAt` check before either
  // wrote. Here, exactly one call's updateMany matches (count 1); the loser
  // gets count 0 and falls through to the same reuse-grace/theft-detection
  // path a delayed re-presentation of an already-used token goes through —
  // so a benign race now genuinely hands both callers the same successor
  // token, instead of silently forking the session.
  const newJti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_LIFETIME_MS);
  const claimed = await prisma.$transaction(async (tx) => {
    const result = await tx.refreshToken.updateMany({
      where: { jti, usedAt: null },
      data: { usedAt: new Date(), replacedByJti: newJti },
    });
    if (result.count === 0) return false;
    await tx.refreshToken.create({
      data: { jti: newJti, familyId, userId, expiresAt },
    });
    return true;
  });

  if (!claimed) {
    const freshRow = await prisma.refreshToken.findUnique({ where: { jti } });
    return handleAlreadyUsedToken(freshRow, userId, familyId);
  }

  return {
    userId,
    refreshToken: signRefreshToken(userId, newJti, familyId, expiresAt),
  };
}

// Shared by the top-of-function "already used" check and the fallback after
// losing the atomic claim above — a delayed re-presentation and a
// same-instant lost race land in the exact same state (row.usedAt set,
// replacedByJti pointing at whoever won) and are handled identically.
async function handleAlreadyUsedToken(row, userId, familyId) {
  const sinceUsedMs = Date.now() - row.usedAt.getTime();
  const withinGrace = sinceUsedMs <= REUSE_GRACE_MS;
  if (!withinGrace) {
    // Lost-rotation recovery. A mobile client can be killed or suspended (iOS
    // background launches, a dropped response, a slow cold start) after the
    // server rotated but before the new token reached its secure storage.
    // Production evidence (2026-11-23): three users were signed out because
    // the token minted by their LAST refresh was never used — the next launch
    // replayed the previous, already-consumed token and the family was revoked.
    // If the successor of the presented token has never been used, revoked or
    // expired, the session has not diverged: nobody has advanced past it, so
    // handing the same successor out again exposes nothing the lost response
    // did not. Once that successor is used, a later replay of this token
    // still hits the theft path below, and anything older than the recovery
    // window is treated as theft too.
    const head = row.replacedByJti
      ? await prisma.refreshToken.findUnique({ where: { jti: row.replacedByJti } })
      : null;
    if (
      head &&
      !head.usedAt &&
      !head.revokedAt &&
      head.expiresAt.getTime() > Date.now() &&
      sinceUsedMs <= LOST_ROTATION_RECOVERY_MS
    ) {
      console.warn(JSON.stringify({
        message: 'refresh_recovered_lost_rotation',
        userId, familyId, jti: row.jti, headJti: head.jti, sinceUsedMs,
      }));
      return {
        userId,
        refreshToken: signRefreshToken(userId, head.jti, familyId, head.expiresAt),
      };
    }

    // Reuse of an already-rotated token well after the fact — theft
    // signal. Revoke the whole family so the stolen token (and the
    // legitimate one it was cloned from) both stop working.
    await revokeFamily(familyId);
    // sinceUsedMs is the key number for diagnosis: just over the grace window
    // points at a client that missed/lost its rotation response, a large value
    // at a stale or cloned credential (restored backup, second device).
    throw reject(REVOKED, 'E120', 'reuse_after_grace_family_revoked', {
      userId, familyId, jti: row.jti, sinceUsedMs, graceMs: REUSE_GRACE_MS,
    });
  }
  // Benign race: re-hand-out the token this row was already rotated into,
  // rather than rotating again (which would just create a second race).
  const nextRow = row.replacedByJti
    ? await prisma.refreshToken.findUnique({ where: { jti: row.replacedByJti } })
    : null;
  if (!nextRow || nextRow.revokedAt) {
    throw reject(INVALID, 'E109', 'grace_successor_missing_or_revoked', {
      userId, familyId, jti: row.jti, sinceUsedMs,
    });
  }
  return {
    userId,
    refreshToken: signRefreshToken(userId, nextRow.jti, familyId, nextRow.expiresAt),
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
