// Wraps calls into auth-service's requireInternal-guarded routes (shared
// secret via x-internal-key). Deliberately does NOT use the pattern
// notifyCustomer.js (booking-service) uses — a direct GET /users/:id call
// with a spoofed x-user-id header that happens to equal the target id.
// That route just had its ownership check tightened (any authenticated
// caller could previously read anyone's profile by guessing an id), and the
// spoofing trick works by coincidence, not because it's actually secured.
// The wallet-service already does this the right way (GET /internal/:id +
// x-internal-key) — this file follows that precedent.
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

async function internalGet(path) {
  const res = await fetch(`${AUTH_SERVICE_URL}${path}`, {
    headers: { 'x-internal-key': INTERNAL_API_KEY },
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
    headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_API_KEY },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    throw { status: 502, error: `auth-service batch lookup failed (${res.status})` };
  }
  const body = await res.json();
  return body.data || [];
}
