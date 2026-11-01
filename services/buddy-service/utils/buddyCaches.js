import { createTtlCache } from './ttlCache.js';

// Per-instance caches for the hot read paths (see each use site). Per-instance
// only: another Cloud Run instance converges within the TTL of a write made here.

// Sorted, filtered discovery list per viewer (GET /discover pages 2+ slice it).
export const feedCache = createTtlCache(45_000);
// BuddyProfile.isActive per user, for the chat guard on the ~3s poll.
export const activeCache = createTtlCache(30_000);

// The viewer's own deck changed (own swipe, block, report): drop just that entry.
export function evictFeed(...userIds) {
  for (const id of userIds) feedCache.evict(id);
}

// Anything about a profile (own or someone else's) that shapes who appears in
// whose deck: visibility, photos, bio, location, filters, suspension, hold,
// erasure. A candidate's edit cannot be mapped to the viewers who cached it, so
// every cached deck is dropped (profile writes are rare next to deck reads).
export function profileChanged(userId) {
  feedCache.clear();
  if (userId != null) activeCache.evict(userId);
}
