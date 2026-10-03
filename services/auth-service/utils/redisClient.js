import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL?.trim();

// LAZY + LOUD by design. The original version created the client at import
// time with an infinite retryStrategy, which meant any environment without
// a Redis server (unit tests, local runs) kept a reconnect timer forever
// alive and the process never exited — node --test hung indefinitely, and
// importing authService.js at all connected to Redis even for call sites
// that never use it (every auth-service test imports authService).
//
// Unlike health-service's cache (no-op without REDIS_URL is fine there),
// the OTP store is correctness-bearing: a silent no-op would let
// send-otp appear to succeed while every verify-otp fails with
// OTP_EXPIRED — a support-ticket-shaped mystery. So with REDIS_URL unset
// the first use throws, with the fix spelled out.
let client = null;

function getClient() {
  if (client) return client;
  if (!redisUrl) {
    throw new Error(
      'REDIS_URL is not configured — the Redis-backed OTP store is unavailable. ' +
        'Set REDIS_URL (e.g. Memorystore) in the service secret before switching ' +
        'the OTP provider off Firebase/skip.',
    );
  }
  const c = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      return times < 20 ? delay : null;
    },
  });
  c.on('error', (err) => {
    console.error('Redis Client Error:', err.message);
  });
  c.on('connect', () => {
    console.log('Connected to Redis for Auth Service');
  });
  client = c;
  return c;
}

export default new Proxy(
  {},
  {
    get(_target, prop) {
      const c = getClient();
      if (prop in c && typeof c[prop] === 'function') {
        return c[prop].bind(c);
      }
      return undefined;
    },
  },
);