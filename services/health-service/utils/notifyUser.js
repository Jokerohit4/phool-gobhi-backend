import admin from 'firebase-admin';

import { fetchUserProfileInternal } from './fetchUserProfile.js';

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
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    initialized = true;
    return true;
  } catch (err) {
    console.error('[FCM] Admin init failed:', err.message);
    return false;
  }
}

// Best-effort push, same shape as booking-service's notifyCustomer. Reuses
// fetchUserProfileInternal for the token rather than adding a second call
// path to auth-service.
//
// The payload carries routing keys only - a nudge tells someone to open a
// screen, and a notification is rendered by the OS on a lock screen, so no
// weight, no gym, no session detail goes into it (PRD S10.2 "no PII in FCM
// payloads"). Returns whether it actually sent, because the nudge log must
// only record what left the building.
export async function notifyUser(userId, { title, body, data = {} }) {
  try {
    if (!initAdmin()) return false;

    const profile = await fetchUserProfileInternal(userId);
    const fcmToken = profile?.fcmToken;
    if (!fcmToken) return false;

    await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    });
    return true;
  } catch (err) {
    console.error('[FCM] notifyUser failed for', userId, err.message);
    return false;
  }
}
