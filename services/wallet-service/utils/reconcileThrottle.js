// In-process per-user throttle for the lazy Razorpay top-up reconcile that runs
// on GET /wallet/balance and GET /wallet/transactions.
//
// - A user reconciled successfully in the last 30s is skipped.
// - clearReconcileThrottle(userId) MUST be called whenever that user creates an
//   order, verifies a payment, or a webhook touches their order, so a just-paid
//   user is never delayed.
// - A reconcile that throws is NOT recorded as done (the error propagates).
// - A clear that lands while a reconcile is in flight also prevents that
//   reconcile from being recorded (generation check), so an order created
//   mid-reconcile is still picked up by the next read.
// - At most 5000 entries; oldest evicted first.
// - ttl is 0 (throttle off) under `node --test` unless WALLET_CACHE_FORCE=1.

const DEFAULT_TTL_MS = 30_000;
const MAX_ENTRIES = 5000;

// userId -> { doneAt, gen }. Map preserves insertion order for eviction.
const entries = new Map();

function ttlMs() {
  return process.env.NODE_TEST_CONTEXT && process.env.WALLET_CACHE_FORCE !== '1' ? 0 : DEFAULT_TTL_MS;
}

function put(userId, entry) {
  entries.delete(userId); // re-insert so it counts as newest
  entries.set(userId, entry);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
}

export function clearReconcileThrottle(userId) {
  if (userId === undefined || userId === null) return;
  const prev = entries.get(userId);
  put(userId, { doneAt: 0, gen: (prev?.gen ?? 0) + 1 });
}

// Runs `fn` unless this user was reconciled within the ttl. Resolves to
// { skipped: true } or { skipped: false, result }. Rejects if `fn` rejects.
export async function runReconcileThrottled(userId, fn) {
  const ttl = ttlMs();
  const prev = entries.get(userId);
  if (ttl > 0 && prev && prev.doneAt && Date.now() - prev.doneAt < ttl) {
    return { skipped: true };
  }
  const gen = prev?.gen ?? 0;
  const result = await fn();
  if (ttl > 0 && (entries.get(userId)?.gen ?? 0) === gen) {
    put(userId, { doneAt: Date.now(), gen });
  }
  return { skipped: false, result };
}

export function _resetReconcileThrottleForTests() {
  entries.clear();
}

export function _reconcileThrottleSize() {
  return entries.size;
}
