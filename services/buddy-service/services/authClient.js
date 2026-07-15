// Wraps calls into auth-service's requireInternal-guarded routes (shared
// secret via x-internal-key, plus a Google ID token on Cloud Run — see
// utils/googleIdToken.js — now that auth-service's Cloud Run invoker no
// longer allows anonymous callers). Deliberately does NOT use the pattern
// notifyCustomer.js (booking-service) uses — a direct GET /users/:id call
// with a spoofed x-user-id header that happens to equal the target id.
// That route just had its ownership check tightened (any authenticated
// caller could previously read anyone's profile by guessing an id), and the
// spoofing trick works by coincidence, not because it's actually secured.
// The wallet-service already does this the right way (GET /internal/:id +
// x-internal-key) — this file follows that precedent.
import { googleIdTokenHeader } from '../utils/googleIdToken.js';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
// .trim() guards against a stray trailing newline in the Secret Manager
// value being silently dropped when placed into an HTTP header (undici
// sanitizes invalid header bytes) while the *unsent* copy used in a direct
// string comparison elsewhere (auth-service's own requireInternal) keeps
// it — a 1-character mismatch that looks like a wrong secret but isn't.
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

async function internalGet(path) {
  const res = await fetch(`${AUTH_SERVICE_URL}${path}`, {
    headers: { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(AUTH_SERVICE_URL)) },
  });
  if (!res.ok) {
    throw { status: 502, error: `auth-service internal call failed (${res.status})` };
  }
  return res.json();
}

// Full profile fields needed to seed/refresh a BuddyProfile's denormalized
// gender/dateOfBirth/fitnessGoals cache, plus fcmToken/profileImageUrl for
// notifications and display.
export async function getUserInternal(userId) {
  return internalGet(`/internal/${userId}`);
}

// Batched display-field lookup for a discovery/matches page — one round
// trip for N candidates instead of N internal calls.
export async function getUsersBatchInternal(ids) {
  if (!ids.length) return [];
  const res = await fetch(`${AUTH_SERVICE_URL}/internal/users/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-key': INTERNAL_API_KEY,
      ...(await googleIdTokenHeader(AUTH_SERVICE_URL)),
    },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    throw { status: 502, error: `auth-service batch lookup failed (${res.status})` };
  }
  const body = await res.json();
  return body.data || [];
}
