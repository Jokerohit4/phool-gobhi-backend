import admin from 'firebase-admin';

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
export async function notifyUser(fcmToken, { title, body, data = {} }) {
  if (!fcmToken) return;
  try {
    if (!initAdmin()) return;
    await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high' },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: { aps: { 'mutable-content': 1, sound: 'default' } },
      },
    });
  } catch (err) {
    console.error('[FCM] Notify user failed:', err.message);
  }
}
