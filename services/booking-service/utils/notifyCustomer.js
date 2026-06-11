import admin from 'firebase-admin';
import axios from 'axios';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';

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

// Best-effort push to a customer. Used for booking confirmation / cancellation / completion.
export async function notifyCustomer(customerId, { title, body, data = {} }) {
  try {
    if (!initAdmin()) return;

    const userRes = await axios.get(`${AUTH_SERVICE_URL}/users/${customerId}`, {
      headers: { 'x-user-id': String(customerId), 'x-user-role': 'customer' },
    });
    const fcmToken = userRes.data?.data?.fcmToken;
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
    });
  } catch (err) {
    console.error('[FCM] Notify customer failed:', err.message);
  }
}
