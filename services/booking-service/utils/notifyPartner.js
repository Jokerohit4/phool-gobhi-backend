// SETUP REQUIRED: Add FIREBASE_SERVICE_ACCOUNT_JSON to your .env file.
// Get it from: Firebase Console → phool-gobhi project → Project Settings
// → Service Accounts → Generate new private key → paste the JSON as a single line.

import admin from 'firebase-admin';
import axios from 'axios';
import { googleIdTokenHeader } from './googleIdToken.js';

const GYM_SERVICE_URL = process.env.GYM_SERVICE_URL || 'http://gym-service:5004';
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

/// Resolve the partner's FCM token for a gym (gym-service -> auth-service).
/// Exported for sendDailyBriefings — the booking fan-out below and the
/// daily 9am briefing share one token-resolution path.
export async function resolvePartnerFcmToken(gymId) {
  const gymRes = await axios.get(`${GYM_SERVICE_URL}/internal/${gymId}`, {
    headers: { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(GYM_SERVICE_URL)) },
  });
  const gym = gymRes.data?.data;
  const partnerId = gym?.partnerId;
  if (!partnerId) return null;
  const userRes = await axios.get(`${AUTH_SERVICE_URL}/internal/${partnerId}`, {
    headers: { 'x-internal-key': INTERNAL_API_KEY, ...(await googleIdTokenHeader(AUTH_SERVICE_URL)) },
  });
  const fcmToken = userRes.data?.fcmToken;
  return fcmToken ? { fcmToken, gymName: gym?.name || '' } : null;
}

/// Fire one FCM push at a gym's partner. Best-effort like notifyPartner —
/// a briefing must never take down the caller.
export async function sendPartnerPush(gymId, title, body, data = {}) {
  try {
    if (!initAdmin()) return false;
    const resolved = await resolvePartnerFcmToken(gymId);
    if (!resolved) return false;
    await admin.messaging().send({
      token: resolved.fcmToken,
      notification: { title, body },
      data: { ...data, gymId: String(gymId), gymName: resolved.gymName },
      android: {
        priority: 'high',
        notification: { channelId: 'bookings_channel' },
      },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: { aps: { 'mutable-content': 1, sound: 'default' } },
      },
    });
    return true;
  } catch (err) {
    console.error('[FCM] sendPartnerPush failed:', err.message);
    return false;
  }
}

export async function notifyPartner(gymId, booking) {
  try {
    if (!initAdmin()) return;

    const resolved = await resolvePartnerFcmToken(gymId);
    if (!resolved) return;

    await admin.messaging().send({
      token: resolved.fcmToken,
      notification: {
        title: resolved.gymName ? `New Booking — ${resolved.gymName}` : 'New Booking!',
        body: `Session on ${booking.date} at ${booking.startTime}–${booking.endTime} · ₹${booking.amount}`,
      },
      data: {
        type: 'new_booking',
        bookingId: String(booking.id),
        date: booking.date,
        gymId: String(gymId),
        gymName: resolved.gymName || '',
      },
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
    console.error('[FCM] Notify partner failed:', err.message);
  }
}
