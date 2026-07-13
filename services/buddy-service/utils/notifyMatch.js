import admin from 'firebase-admin';
import { getUserInternal } from '../services/authClient.js';

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

// Best-effort push telling both sides of a new match. Never throws — a
// failed push must not fail the swipe/match request that triggered it.
export async function notifyMatch(userId, otherUserName) {
  try {
    if (!initAdmin()) return;
    const user = await getUserInternal(userId);
    if (!user?.fcmToken) return;

    await admin.messaging().send({
      token: user.fcmToken,
      notification: {
        title: "It's a match!",
        body: `You and ${otherUserName} both liked each other. Say hi!`,
      },
      android: {
        priority: 'high',
        notification: { channelId: 'buddy_match_channel' },
      },
    });
  } catch (err) {
    console.error('[FCM] Notify match failed:', err.message);
  }
}
