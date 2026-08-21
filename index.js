import './bootstrap-secrets.js';
import dotenv from 'dotenv';
dotenv.config();
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import express from 'express';
import proxy from 'express-http-proxy';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { UAParser } from 'ua-parser-js';
import { ingest } from './utils/analytics.js';
import { withGoogleIdToken } from './utils/googleIdToken.js';

const app = express();

// Single source of truth for valid event names (docs/analytics-events.json,
// checked for drift by scripts/check-analytics-events.cjs). Only the
// 'client'-sourced subset is relevant here — server events never touch this
// route, they're tracked in-process. Read via fs rather than an ESM JSON
// import assertion to avoid Node-version-specific import syntax.
const __dirname = dirname(fileURLToPath(import.meta.url));
const analyticsEventsRegistry = JSON.parse(
  readFileSync(join(__dirname, 'docs', 'analytics-events.json'), 'utf8')
);
const CLIENT_EVENT_ALLOWLIST = new Set(
  Object.entries(analyticsEventsRegistry)
    .filter(([key, v]) => !key.startsWith('$') && v.source === 'client')
    .map(([key]) => key)
);

// Cloud Run sits in front of this gateway behind its own load balancer, so
// without this req.ip is the LB's internal address for every request —
// making IP-based rate limiting below either bucket everyone together or
// throw on express-rate-limit's own misconfigured-trust-proxy check.
app.set('trust proxy', 1);

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://wallet-service:5003';
const GYM_SERVICE_URL = process.env.GYM_SERVICE_URL || 'http://gym-service:5004';
const BOOKING_SERVICE_URL = process.env.BOOKING_SERVICE_URL || 'http://booking-service:5005';
const BUDDY_SERVICE_URL = process.env.BUDDY_SERVICE_URL || 'http://buddy-service:5007';

// Routes that do NOT require JWT verification
const PUBLIC_ROUTES = [
  { method: 'POST', pattern: /^\/api\/auth\/(signup|login|refresh-token|logout|forgot-password|send-otp|verify-otp|verify-firebase-token|google|pitch-access\/check|contact)$/ },
  { method: 'GET', pattern: /^\/api\/auth\/otp-config$/ },
  { method: 'GET', pattern: /^\/api\/auth\/app-config(\?.*)?$/ },
  { method: 'GET', pattern: /^\/api\/auth\/launch-status(\?.*)?$/ },
  { method: 'GET', pattern: /^\/api\/auth\/jobs(\?.*)?$/ },
  { method: 'GET', pattern: /^\/api\/auth\/platform-reviews(\?.*)?$/ },
  { method: 'POST', pattern: /^\/api\/auth\/jobs\/\d+\/apply$/ },
  { method: 'GET', pattern: /^\/api\/gyms(\?.*)?$/ },
  { method: 'GET', pattern: /^\/api\/gyms\/nearest-distance(\?.*)?$/ },
  { method: 'GET', pattern: /^\/api\/gyms\/\d+(\?.*)?$/ },
  { method: 'GET', pattern: /^\/api\/gyms\/\d+\/slots/ },
  { method: 'GET', pattern: /^\/api\/gyms\/\d+\/availability/ },
  { method: 'GET', pattern: /^\/api\/gyms\/\d+\/reviews/ },
  { method: 'GET', pattern: /^\/api\/gyms\/\d+\/subscription-plans/ },
  { method: 'GET', pattern: /^\/api\/gyms\/\d+\/operating-hours/ },
  // Also covers GET /api/gyms/:id/classes/:classId/occurrences — mutating
  // methods (POST/PUT/DELETE) aren't matched here (isPublicRoute checks
  // method too) and still require partner auth via requireRole('partner')
  // in gym-service.
  { method: 'GET', pattern: /^\/api\/gyms\/\d+\/classes/ },
  { method: 'POST', pattern: /^\/api\/wallet\/webhooks\/razorpay$/ },
  { method: 'POST', pattern: /^\/api\/events$/ },
  { method: 'GET', pattern: /^\/api\/bookings\/public\/attendance-stats(\?.*)?$/ },
  { method: 'GET', pattern: /^\/health/ },
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

// IP-keyed only, by necessity: express-http-proxy consumes the raw request
// body itself (via raw-body) before forwarding — see the comment on the
// /api/users mount below — so nothing upstream of the proxy can parse the
// body (e.g. to key a limiter on phone number) without breaking proxied
// request bodies downstream. This is a coarse outer backstop against one IP
// hammering many phones/accounts; auth-service's own per-phone 60s OTP
// cooldown (OtpCode table, survives cold starts/scale-out) remains the
// primary throttle for send-otp specifically.
const authAttemptLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a few minutes.' },
});
const walletAttemptLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a few minutes.' },
});
// Deliberately generous — pre-login screens fire several events in quick
// succession (screen views, OTP request+submit) from one IP/device, and this
// is a backstop against abuse, not a per-user throttle.
const eventsIngestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many events' },
});
const RATE_LIMITED_ROUTES = [
  { method: 'POST', pattern: /^\/api\/auth\/(send-otp|verify-otp|login|signup|contact)$/, limiter: authAttemptLimiter },
  { method: 'POST', pattern: /^\/api\/auth\/jobs\/\d+\/apply$/, limiter: authAttemptLimiter },
  { method: 'POST', pattern: /^\/api\/wallet\/(orders|verify)$/, limiter: walletAttemptLimiter },
  { method: 'POST', pattern: /^\/api\/events$/, limiter: eventsIngestLimiter },
];
app.use((req, res, next) => {
  const match = RATE_LIMITED_ROUTES.find(r => r.method === req.method && r.pattern.test(req.path));
  if (!match) return next();
  match.limiter(req, res, next);
});

app.get('/health', (req, res) => res.json({ status: 'Gateway is healthy', timestamp: new Date().toISOString() }));

// Client analytics ingestion. Public (anonymous pre-login events are valid) and
// fire-and-forget — the client must never be blocked or fail on analytics. The
// app sends its own distinct_id (anon id pre-login, userId after identify).
// express.json is scoped to this route so it can't interfere with the proxied
// request bodies below. Accepts a single event or { events: [...] }.
app.post('/api/events', express.json({ limit: '128kb' }), (req, res) => {
  try {
    // Parsed once per request (same header applies to every event in a
    // batch). This is a backstop, not the primary source: the apps already
    // send their own richer platform/os_version/device_model directly, so
    // these only fill gaps (website traffic, or any future client that
    // forgets a field) — never overwrite what the client already sent.
    const userAgent = req.headers['user-agent'];
    const ip = req.ip;
    const uaResult = userAgent ? new UAParser(userAgent).getResult() : null;
    const uaProps = uaResult && {
      os_name: uaResult.os.name,
      os_version: uaResult.os.version,
      browser_name: uaResult.browser.name,
      browser_version: uaResult.browser.version,
      device_type: uaResult.device.type || 'desktop',
    };

    const body = req.body || {};
    const list = Array.isArray(body.events) ? body.events : [body];
    for (const e of list) {
      if (!e || typeof e.event !== 'string') continue;
      // Silently drop anything not in the registry — never tell the caller
      // which names are valid, that just makes probing easier. Still 202.
      if (!CLIENT_EVENT_ALLOWLIST.has(e.event)) continue;
      if (typeof e.distinct_id !== 'undefined' && (typeof e.distinct_id !== 'string' || e.distinct_id.length > 200)) continue;
      const properties = e.properties;
      if (properties != null && (typeof properties !== 'object' || Array.isArray(properties))) continue;

      const enriched = { ...(properties || {}) };
      if (userAgent && enriched.user_agent == null) enriched.user_agent = userAgent;
      if (uaProps) {
        for (const [key, value] of Object.entries(uaProps)) {
          if (value != null && enriched[key] == null) enriched[key] = value;
        }
      }
      if (ip && enriched.ip == null) enriched.ip = ip;

      ingest({ event: e.event, distinctId: e.distinct_id, properties: enriched, source: 'client' });
    }
  } catch (_) {
    // swallow — analytics never fails the client
  }
  res.status(202).json({ ok: true });
});

// Each proxy call attaches a Google ID token scoped to that specific backend
// service's URL (see utils/googleIdToken.js) — on Cloud Run this is what lets
// each service's IAM invoker check confirm the call genuinely came from this
// gateway, rather than trusting the x-user-id headers alone. No-ops locally.
app.use('/api/auth', proxy(AUTH_SERVICE_URL, {
  proxyReqOptDecorator: withGoogleIdToken(AUTH_SERVICE_URL),
  // Raised for the same reason as /api/users and /api/gyms below — this
  // mount now also carries the careers page's resume-upload multipart body.
  limit: '15mb',
}));
// express-http-proxy buffers the whole request body itself (via raw-body)
// before forwarding, with its own default limit far smaller than the
// multipart uploads these two routes carry (gym photos/docs, profile
// pictures) — raised to match the receiving service's own multer cap so
// that cap is what actually rejects an oversized file, not this proxy
// buffer failing first with an unparseable HTML error.
app.use('/api/users', proxy(AUTH_SERVICE_URL, {
  proxyReqPathResolver: req => '/users' + req.url,
  proxyReqOptDecorator: withGoogleIdToken(AUTH_SERVICE_URL),
  limit: '15mb',
}));
app.use('/api/wallet', proxy(WALLET_SERVICE_URL, {
  proxyReqOptDecorator: withGoogleIdToken(WALLET_SERVICE_URL),
}));
app.use('/api/gyms', proxy(GYM_SERVICE_URL, {
  proxyReqOptDecorator: withGoogleIdToken(GYM_SERVICE_URL),
  limit: '15mb',
}));
app.use('/api/bookings', proxy(BOOKING_SERVICE_URL, {
  proxyReqOptDecorator: withGoogleIdToken(BOOKING_SERVICE_URL),
}));
// Buddy matchmaking: no public routes (nothing added to PUBLIC_ROUTES above)
// — discovery/swipes/matches/chat all require a verified JWT. Raised limit
// to match the multi-photo profile upload, same reasoning as /api/gyms.
app.use('/api/buddy', proxy(BUDDY_SERVICE_URL, {
  proxyReqOptDecorator: withGoogleIdToken(BUDDY_SERVICE_URL),
  limit: '15mb',
}));

const PORT = process.env.PORT || process.env.GATEWAY_PORT || 5000;
app.listen(PORT, () => console.log(`Gateway running on port ${PORT}`));
