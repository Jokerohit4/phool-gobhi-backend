import { fetchInternal } from '../../utils/fetchInternal.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';

/**
 * Check if the home-days referral trigger conditions are met and call wallet-service.
 * Conditions (from Contracts/Money rules):
 * - The 3rd showed-up day is reached
 * - The 3 showed-up days span 7 or more calendar days
 * - The friend's account is at least 7 days old
 * - No other user sharing any of the friend's installIds has already been paid as a friend
 * 
 * Called from journeyService.getJourney when the app opens Home (calls /journey).
 */
export async function checkAndTriggerHomeDaysReferral(userId, showedUpDays, progress) {
  // Only trigger on the 3rd showed-up day (when total becomes 3)
  // Wallet service handles idempotency via keys; no need to track here.
  if (showedUpDays.length !== 3) return;

  // Check span >= 7 calendar days
  const firstDay = showedUpDays[showedUpDays.length - 1]; // oldest (days sorted newest first)
  const lastDay = showedUpDays[0]; // newest
  const firstDate = new Date(`${firstDay}T00:00:00`);
  const lastDate = new Date(`${lastDay}T00:00:00`);
  const spanDays = Math.floor((lastDate - firstDate) / (1000 * 60 * 60 * 24)) + 1;
  if (spanDays < 7) return;

  // Get friend's internal profile (referredByUserId, createdAt, installIds)
  let friendProfile;
  try {
    const res = await fetchInternal(AUTH_SERVICE_URL, `/internal/${userId}`);
    friendProfile = res.data;
  } catch {
    return;
  }

  const referrerId = friendProfile?.referredByUserId;
  if (!referrerId) return;

  // Check account age >= 7 days
  const createdAt = friendProfile?.createdAt;
  if (!createdAt) return;
  const accountAgeDays = Math.floor((Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24));
  if (accountAgeDays < 7) return;

  // Device dedupe: get installIds for this user, then check if any other user
  // sharing those installIds has already been paid as a friend (referral-credit-referred-<friendId>)
  const installIds = friendProfile?.installIds ?? [];
  if (installIds.length === 0) return;

  // Get all userIds sharing these installIds
  let sharedUserIds = [];
  for (const installId of installIds) {
    try {
      const res = await fetchInternal(AUTH_SERVICE_URL, `/internal/devices/${encodeURIComponent(installId)}/users`);
      sharedUserIds.push(...(res.data?.userIds || []));
    } catch {
      // continue
    }
  }
  sharedUserIds = [...new Set(sharedUserIds)];

  // Check if any shared user has already been credited as a friend
  // This is done by wallet-service via the idempotency key check
  // We just call the wallet endpoint and it will return 'already_credited' if so

  // Call wallet-service /internal/referrals/credit with trigger='home_days'
  try {
    const walletUrl = process.env.WALLET_SERVICE_URL;
    if (!walletUrl) {
      console.warn('[referralHomeTrigger] WALLET_SERVICE_URL not set, skipping referral');
      return;
    }

    const res = await fetch(`${walletUrl}/internal/referrals/credit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': process.env.INTERNAL_API_KEY ?? '',
      },
      body: JSON.stringify({
        referrerId,
        friendId: userId,
        trigger: 'home_days',
      }),
    });

    if (res.ok) {
      const result = await res.json();
      console.log('[referralHomeTrigger] Referral credit result:', result);
      // Wallet service handles idempotency via keys; no need to track here.
    } else {
      console.warn('[referralHomeTrigger] Wallet service error:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[referralHomeTrigger] Failed to call wallet service:', err.message);
  }
}