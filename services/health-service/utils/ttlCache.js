// Tiny in-process TTL cache with single-flight loading and explicit eviction.
//
// Zero infrastructure on purpose (no Redis / Memorystore): it is a per-instance
// optimisation, never load-bearing for correctness. Each Cloud Run instance has
// its own copy, so keep TTLs short and evict on every write path you own.
//
// - get(key, loader): returns a fresh hit, else joins the load already in
//   flight for that key (an app launch fans out into several routes that all
//   want the same value), else runs `loader`.
// - invalidate(key): drops the entry AND detaches any in-flight load so a load
//   that started before the write can never repopulate the cache with stale data.
// - Failed loads are never cached; `cacheable(value)` lets a loader opt out of
//   caching a degraded result (e.g. a fallback after an upstream error).
//
// TTL 0 disables the cache entirely (loader runs every call). It defaults to 0
// under `node --test` (NODE_TEST_CONTEXT) so unit tests that reuse a userId with
// different mocked state never see each other's results.

export function createTtlCache({ ttlMs, maxEntries = 1000, forceEnabled = false } = {}) {
  // forceEnabled (or HEALTH_CACHE_FORCE=1) lets a test opt back in to real caching.
  const effectiveTtl = process.env.NODE_TEST_CONTEXT && !forceEnabled && process.env.HEALTH_CACHE_FORCE !== '1' ? 0 : ttlMs;
  const entries = new Map(); // key -> { value, expiresAt }
  const inflight = new Map(); // key -> { promise }

  function store(key, value) {
    if (entries.size >= maxEntries && !entries.has(key)) {
      // FIFO eviction: Map iterates in insertion order. Drop expired first.
      const now = Date.now();
      for (const [k, e] of entries) if (e.expiresAt <= now) entries.delete(k);
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
    }
    entries.set(key, { value, expiresAt: Date.now() + effectiveTtl });
  }

  async function get(key, loader, { cacheable = () => true } = {}) {
    if (!(effectiveTtl > 0)) return loader();
    const hit = entries.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const running = inflight.get(key);
    if (running) return running.promise;

    const rec = {};
    inflight.set(key, rec); // before running the loader so a sync throw can't leak a record
    rec.promise = (async () => {
      try {
        const value = await loader();
        // Only store if we are still the current load (not invalidated meanwhile).
        if (inflight.get(key) === rec && cacheable(value)) store(key, value);
        return value;
      } finally {
        if (inflight.get(key) === rec) inflight.delete(key);
      }
    })();
    return rec.promise;
  }

  function invalidate(key) {
    entries.delete(key);
    inflight.delete(key);
  }

  function clear() {
    entries.clear();
    inflight.clear();
  }

  return { get, invalidate, clear, get size() { return entries.size; } };
}
