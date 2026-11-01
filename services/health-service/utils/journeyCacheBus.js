// Dependency-free hook so write paths elsewhere in the service (workout finish,
// consent erase) can evict the journey / showed-up-days caches without importing
// the journey module graph (which would risk import cycles and drag real Prisma
// clients into modules whose tests mock their dependencies).
//
// journeyService registers its evictor at load; if it was never loaded in this
// process there is nothing cached, so emitting is a harmless no-op.
const listeners = new Set();

export function onJourneyInvalidate(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitJourneyInvalidate(userId) {
  for (const fn of listeners) {
    try { fn(userId); } catch (err) { console.error('[journeyCacheBus] listener failed:', err.message); }
  }
}
