import admin from 'firebase-admin';
import { sendWithTelemetry } from './pushTelemetry.js';

// Separate from firebaseAdmin.js's initAdmin (used for ID-token verification,
// where a missing/broken Firebase config should fail the caller's request)
// — this one is best-effort by design, mirroring booking-service's and
// wallet-service's notifyCustomer.js: a missed push notification must never
// be a fatal error for whatever triggered it.
let initialized = false;

function initAdmin() {
  if (initialized) return true;
  if (admin.apps.length) {
    initialized = true;
    return true;
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return false;
  try {
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    initialized = true;
    return true;
  } catch (err) {
    console.error('[FCM] Admin init failed:', err.message);
    return false;
  }
}

// Best-effort push, given an fcmToken directly — unlike booking-service's/
// wallet-service's copies, auth-service already has the User row in hand
// wherever this is called from, so there's no need for the cross-service
// HTTP round trip those two do just to fetch the token.
// telemetry = { recipientId, recipientRole } for the push_sent/push_failed events
// (auth-service has the user row at every call site; omit and no event is emitted).
export async function notifyUser(fcmToken, { title, body, data = {} }, telemetry = {}) {
  if (!fcmToken) return;
  try {
    if (!initAdmin()) return;
    await sendWithTelemetry((message) => admin.messaging().send(message), {
      token: fcmToken,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high' },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: { aps: { 'mutable-content': 1, sound: 'default' } },
      },
    }, { ...telemetry, service: 'auth-service' });
  } catch (err) {
    console.error('[FCM] Notify user failed:', err.message);
  }
}

// Best-effort batch push (one FCM message per recipient, up to 500 per call).
// Returns the per-message results ({success, error}) in input order, or null
// when FCM is not configured/initialised. Never throws: a failed batch is
// reported by the caller as "all failed" rather than aborting a scheduled run.
export async function sendEachPush(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  try {
    if (!initAdmin()) return null;
    const batch = await admin.messaging().sendEach(messages);
    return batch.responses;
  } catch (err) {
    console.error('[FCM] Batch send failed:', err.message);
    return null;
  }
}
