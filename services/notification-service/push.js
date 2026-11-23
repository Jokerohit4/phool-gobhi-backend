import { initializeApp, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { sendWithTelemetry } from './utils/pushTelemetry.js';

let messaging;

export function pushMessage({ id, campaign_id, config }, userId, token) {
  const { title, subtitle, imageUrl, deepLink } = config;
  return {
    token,
    notification: { title, body: subtitle },
    data: {
      type: 'notification_campaign', title, subtitle, deepLink,
      imageUrl, campaignId: campaign_id, notificationId: id, recipientId: String(userId),
    },
    android: {
      priority: 'high', ttl: 3600000,
      ...(imageUrl && { notification: { imageUrl } }),
    },
    apns: {
      headers: { 'apns-priority': '10', 'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600) },
      payload: { aps: { sound: 'default', ...(imageUrl && { mutableContent: true }) } },
    },
  };
}

export async function sendPush(run, userId, token) {
  messaging ??= getMessaging(initializeApp({
    credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
  }, 'notification-campaigns'));
  return sendWithTelemetry((message) => messaging.send(message), pushMessage(run, userId, token), {
    recipientId: userId, recipientRole: 'customer', pushType: 'campaign', campaignId: run.campaign_id, service: 'notification-service',
  });
}
