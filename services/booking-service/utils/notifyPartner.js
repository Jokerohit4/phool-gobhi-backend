// SETUP REQUIRED: Add FIREBASE_SERVICE_ACCOUNT_JSON to your .env file.
// Get it from: Firebase Console → phool-gobhi project → Project Settings
// → Service Accounts → Generate new private key → paste the JSON as a single line.

import admin from 'firebase-admin';
import axios from 'axios';

const GYM_SERVICE_URL = process.env.GYM_SERVICE_URL || 'http://gym-service:5004';
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';

let initialized = false;

function initAdmin() {
  if (initialized) return true;
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

export async function notifyPartner(gymId, booking) {
  try {
    if (!initAdmin()) return;

    // Get partnerId from gym-service
    const gymRes = await axios.get(`${GYM_SERVICE_URL}/api/gyms/${gymId}`);
    const partnerId = gymRes.data?.data?.partnerId;
    if (!partnerId) return;

    // Get partner FCM token from auth-service
    const userRes = await axios.get(`${AUTH_SERVICE_URL}/users/${partnerId}`, {
      headers: { 'x-user-id': String(partnerId), 'x-user-role': 'partner' },
    });
    const fcmToken = userRes.data?.data?.fcmToken;
    if (!fcmToken) return;

    // Send notification
    await admin.messaging().send({
      token: fcmToken,
      notification: {
        title: 'New Booking!',
        body: `Session on ${booking.date} at ${booking.startTime}–${booking.endTime} · ₹${booking.amount}`,
      },
      data: {
        type: 'new_booking',
        bookingId: String(booking.id),
        date: booking.date,
      },
      android: {
        priority: 'high',
        notification: { channelId: 'bookings_channel' },
      },
    });
  } catch (err) {
    console.error('[FCM] Notify partner failed:', err.message);
  }
}
