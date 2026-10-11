// Tab experiment service — MINIMAL STUB as of A1 (2026-10-16).
//
// The coach journey ships an A/B on the tab bar: `bucketFor` returns which
// variant this user sees, and GET /me exposes it as `experiments.tabBar` so the
// app can branch on the first call. A1 ships the constant control (`'A'`) so the
// endpoint shape exists and nothing changes for any user yet; B14 replaces the
// body with a deterministic per-user hash (same user → same bucket, forever, no
// storage) once the treatment screens exist.
//
// Contract: 'A' | 'B', assigned per userId and stable across calls.

/**
 * Which tab-bar variant this user is in.
 *
 * @param {number} userId
 * @returns {{ tabBar: 'A' | 'B' }}
 */
export function bucketFor(userId) { // eslint-disable-line no-unused-vars
  // STUB: everyone is in the control arm. B14 makes this a stable hash of userId.
  return { tabBar: 'A' };
}
