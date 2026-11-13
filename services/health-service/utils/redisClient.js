import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL;

// LAZY + OPTIONAL by design. The original version created the client at
// import time, which meant:
//  - any environment without a Redis server (unit tests, local runs, CI)
//    kept a reconnect timer forever alive and the process never exited —
//    node --test hung indefinitely;
//  - importing the module at all connected to Redis, even for call sites
//    that never touch the cache.
// Now the connection happens on FIRST METHOD USE, and when REDIS_URL is
// unset the cache degrades to a no-op (get -> null, set -> no-op): the
// cache is an optimization and must never be load-bearing for correctness.
let client = null;

function getClient() {
  if (!redisUrl) return null;
  if (client) return client;
  // Don't retry forever on a first-use connection problem in the same
  // process — a broken cache shouldn't turn into a zombie reconnect loop.
  // The author's original options are preserved for the healthy path.
  const c = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      return times < 20 ? delay : null;
    },
  });
  c.on('error', (err) => {
    console.error('Health Service Redis Error:', err.message);
  });
  c.on('connect', () => {
    console.log('Connected to Redis for Health Service');
  });
  client = c;
  return c;
}

const noCache = {
  get: async () => null,
  set: async () => null,
};

// Keeps the `import redis from '.../redisClient.js'` API working for every
// ioredis method (get/set/del/incr/...) while remaining lazy + optional.
const proxy = new Proxy(noCache, {
  get(_target, prop) {
    if (!redisUrl) return noCache[prop] ?? (async () => null);
    const c = getClient();
    if (prop in c && typeof c[prop] === 'function') {
      return c[prop].bind(c);
    }
    return noCache[prop] ?? (async () => null);
  },
});

export default proxy;