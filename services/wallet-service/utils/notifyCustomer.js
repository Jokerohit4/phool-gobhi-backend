import admin from 'firebase-admin';
import axios from 'axios';
import { googleIdTokenHeader } from './googleIdToken.js';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

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

// Best-effort push to a customer — same shape as booking-service's
// notifyCustomer (duplicated rather than shared, matching this codebase's
// existing convention of copying small per-service utils, e.g. analytics.js).
// Used for the subscription gift-day/attendance-bonus close-out notice.
export async function notifyCustomer(customerId, { title, body, data = {} }) {
  try {
    if (!initAdmin()) return;

    const userRes = await axios.get(`${AUTH_SERVICE_URL}/internal/${customerId}`, {
      headers: { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(AUTH_SERVICE_URL)) },
    });
    const fcmToken = userRes.data?.fcmToken;
    if (!fcmToken) return;

    await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      android: {
        priority: 'high',
        notification: { channelId: 'bookings_channel' },
      },
      apns: {
        headers: {
          'apns-priority': '10',
        },
        payload: {
          aps: {
            'mutable-content': 1,
            sound: 'default',
          },
        },
      },
    });
  } catch (err) {
    console.error('[FCM] Notify customer failed:', err.message);
  }
}
