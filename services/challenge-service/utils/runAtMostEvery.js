// Wraps an idempotent async task so it runs at most once per `intervalMs`, with
// concurrent callers sharing one in-flight run.
//
// Used for catalog seeding: GET /challenges and GET /coins/catalog used to
// re-run every seed upsert (~30 sequential queries plus an advisory-lock
// transaction) on EVERY request, although the seeds only ever need to exist.
// Now the first request on an instance seeds and the rest skip it; the interval
// re-checks occasionally so a row deleted by hand is put back without a restart.
//
// - A failed run is NOT remembered: the next caller retries, and the failure
//   still reaches the caller that triggered it (same as before).
// - intervalMs 0 (the default under `node --test`, NODE_TEST_CONTEXT) runs the
//   task on every call, so tests that reseed a fake DB between cases keep working.
export function runAtMostEvery(intervalMs, task) {
  // CHALLENGE_CACHE_FORCE=1 lets a test opt back in to the real behaviour.
  const effective = process.env.NODE_TEST_CONTEXT && process.env.CHALLENGE_CACHE_FORCE !== '1' ? 0 : intervalMs;
  let lastOkAt = 0;
  let inFlight = null;

  return function run() {
    if (effective > 0 && lastOkAt && Date.now() - lastOkAt < effective) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        await task();
        lastOkAt = Date.now();
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}
