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

// Best-effort push for a new chat message. Never throws — a failed push
// must not fail the send-message request that triggered it.
export async function notifyMessage(recipientId, { senderName, preview, matchId }) {
  try {
    if (!initAdmin()) return;
    const user = await getUserInternal(recipientId);
    if (!user?.fcmToken) return;

    await admin.messaging().send({
      token: user.fcmToken,
      notification: { title: senderName, body: preview },
      data: { matchId: String(matchId), type: 'buddy_message' },
      android: {
        priority: 'high',
        notification: { channelId: 'buddy_chat_channel' },
      },
    });
  } catch (err) {
    console.error('[FCM] Notify message failed:', err.message);
  }
}
