import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import proxy from 'express-http-proxy';
import jwt from 'jsonwebtoken';
import { ingest } from './utils/analytics.js';

const app = express();

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://wallet-service:5003';
const GYM_SERVICE_URL = process.env.GYM_SERVICE_URL || 'http://gym-service:5004';
const BOOKING_SERVICE_URL = process.env.BOOKING_SERVICE_URL || 'http://booking-service:5005';

// Routes that do NOT require JWT verification
const PUBLIC_ROUTES = [
  { method: 'POST', pattern: /^\/api\/auth\/(signup|login|refresh-token|forgot-password|send-otp|verify-otp|verify-firebase-token)$/ },
  { method: 'GET', pattern: /^\/api\/auth\/otp-config$/ },
  { method: 'GET', pattern: /^\/api\/gyms(\?.*)?$/ },
  { method: 'GET', pattern: /^\/api\/gyms\/\d+(\?.*)?$/ },
  { method: 'GET', pattern: /^\/api\/gyms\/\d+\/slots/ },
  { method: 'GET', pattern: /^\/api\/gyms\/\d+\/availability/ },
  { method: 'GET', pattern: /^\/api\/gyms\/\d+\/reviews/ },
  { method: 'POST', pattern: /^\/api\/wallet\/webhooks\/razorpay$/ },
  { method: 'POST', pattern: /^\/api\/events$/ },
  { method: 'GET', pattern: /^\/health/ },
  { method: 'GET', pattern: /^\/wake/ },
];

function isPublicRoute(method, path) {
  return PUBLIC_ROUTES.some(r => r.method === method && r.pattern.test(path));
}

function authMiddleware(req, res, next) {
  // Never let a client inject identity/internal headers — the gateway is the only
  // component allowed to set these, derived from a verified JWT.
  delete req.headers['x-user-id'];
  delete req.headers['x-user-role'];
  delete req.headers['x-user-type'];
  delete req.headers['x-internal-key'];

  if (isPublicRoute(req.method, req.path)) return next();
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.headers['x-user-id'] = String(payload.id);
    req.headers['x-user-role'] = payload.role || '';
    req.headers['x-user-type'] = payload.type || '';
    next();
  } catch (err) {
    // An expired/invalid token is an authentication failure (401), not an
    // authorization failure (403). Returning 401 lets clients trigger their
    // refresh-token flow; 403 is reserved for authenticated-but-not-permitted.
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      error: expired ? 'Token expired' : 'Invalid token',
    });
  }
}

app.use(authMiddleware);

app.get('/health', (req, res) => res.json({ status: 'Gateway is healthy', timestamp: new Date().toISOString() }));

// Pings all downstream services so a single external monitor keeps the entire
// cluster warm. Render free-tier services hibernate after 15 min of inactivity;
// hitting this endpoint every 14 min prevents 429/502 cold-start errors.
app.get('/wake', async (req, res) => {
  const services = {
    auth:    AUTH_SERVICE_URL,
    wallet:  WALLET_SERVICE_URL,
    gym:     GYM_SERVICE_URL,
    booking: BOOKING_SERVICE_URL,
  };
  const results = await Promise.all(
    Object.entries(services).map(async ([name, url]) => {
      try {
        const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(60000) });
        return { name, status: r.status, ok: r.ok };
      } catch (err) {
        return { name, status: 0, ok: false, error: err.message };
      }
    })
  );
  const allOk = results.every(r => r.ok);
  res.status(allOk ? 200 : 207).json({ gateway: 'ok', services: results });
});

// Client analytics ingestion. Public (anonymous pre-login events are valid) and
// fire-and-forget — the client must never be blocked or fail on analytics. The
// app sends its own distinct_id (anon id pre-login, userId after identify).
// express.json is scoped to this route so it can't interfere with the proxied
// request bodies below. Accepts a single event or { events: [...] }.
app.post('/api/events', express.json({ limit: '128kb' }), (req, res) => {
  try {
    const body = req.body || {};
    const list = Array.isArray(body.events) ? body.events : [body];
    for (const e of list) {
      if (e && e.event) {
        ingest({ event: e.event, distinctId: e.distinct_id, properties: e.properties || {}, source: 'client' });
      }
    }
  } catch (_) {
    // swallow — analytics never fails the client
  }
  res.status(202).json({ ok: true });
});

app.use('/api/auth', proxy(AUTH_SERVICE_URL));
// express-http-proxy buffers the whole request body itself (via raw-body)
// before forwarding, with its own default limit far smaller than the
// multipart uploads these two routes carry (gym photos/docs, profile
// pictures) — raised to match the receiving service's own multer cap so
// that cap is what actually rejects an oversized file, not this proxy
// buffer failing first with an unparseable HTML error.
app.use('/api/users', proxy(AUTH_SERVICE_URL, {
  proxyReqPathResolver: req => '/users' + req.url,
  limit: '15mb',
}));
app.use('/api/wallet', proxy(WALLET_SERVICE_URL));
app.use('/api/gyms', proxy(GYM_SERVICE_URL, { limit: '15mb' }));
app.use('/api/bookings', proxy(BOOKING_SERVICE_URL));

const PORT = process.env.PORT || process.env.GATEWAY_PORT || 5000;
app.listen(PORT, () => console.log(`Gateway running on port ${PORT}`));
