// Tab experiment service — the A/B test is ENDED (2026-10-14).
//
// The coach journey shipped an A/B on the tab bar: B14 replaced the constant
// control with a deterministic per-user hash, and GET /me exposes the bucket as
// `experiments.tabBar` so the app can branch on the first call. The founder
// ended the experiment on 2026-10-14 — at roughly 60 users the 50/50 split could
// not produce a meaningful result — so `bucketFor` now pins every user to the
// control.
//
// 'A' = no Bookings tab. The app's variant-B code is removed in a later task.
// The function signature and the `experiments.tabBar` field on /me stay exactly
// as they are, because installed app builds still read that field.
//
// Contract: 'A' | 'B', assigned per userId and stable across calls.

/**
 * Which tab-bar variant this user is in.
 *
 * @param {number} userId
 * @returns {{ tabBar: 'A' | 'B' }}
 */
export function bucketFor(userId) { // eslint-disable-line no-unused-vars
  // The A/B test is over: everyone is in the control, so no user gets the
  // Bookings tab. `userId` is unused but kept in the signature (and above the
  // no-unused-vars lint) so the endpoint contract is unchanged.
  return { tabBar: 'A' };
}
