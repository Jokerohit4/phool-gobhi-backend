// Tiny in-process TTL cache with single-flight, for read-mostly settings.
//
// - get(key, loader): returns the cached value while it is younger than ttlMs,
//   otherwise runs loader() — concurrent callers for one key share ONE run.
// - A loader that throws is NOT cached; the error reaches every waiting caller
//   and the next call retries.
// - evict(key) / clear() drop the entry AND detach any in-flight load, so a
//   load that started before an admin write can never repopulate stale data.
// - ttlMs is 0 (cache off) under `node --test` (NODE_TEST_CONTEXT) unless a
//   test sets CHALLENGE_CACHE_FORCE=1, so tests that reseed fake data keep working.
// Per-instance only (no shared store): each Cloud Run instance converges within
// ttlMs of a write made on another instance.
export function createTtlCache(ttlMs) {
  const entries = new Map(); // key -> { value, at }
  const inFlight = new Map(); // key -> promise
  let generation = 0;
  const effectiveTtl = () => (process.env.NODE_TEST_CONTEXT && process.env.CHALLENGE_CACHE_FORCE !== '1' ? 0 : ttlMs);

  function get(key, loader) {
    const ttl = effectiveTtl();
    if (ttl > 0) {
      const hit = entries.get(key);
      if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.value);
    }
    const running = inFlight.get(key);
    if (running) return running;
    const startedGen = generation;
    const p = (async () => {
      try {
        const value = await loader();
        if (ttl > 0 && startedGen === generation) entries.set(key, { value, at: Date.now() });
        return value;
      } finally {
        if (inFlight.get(key) === p) inFlight.delete(key);
      }
    })();
    inFlight.set(key, p);
    return p;
  }

  function evict(key) {
    generation++;
    entries.delete(key);
    inFlight.delete(key);
  }

  function clear() {
    generation++;
    entries.clear();
    inFlight.clear();
  }

  return { get, evict, clear };
}
