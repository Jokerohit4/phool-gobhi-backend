import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import proxy from 'express-http-proxy';
import jwt from 'jsonwebtoken';

const app = express();

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://user-service:5002';
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://wallet-service:5003';
const GYM_SERVICE_URL = process.env.GYM_SERVICE_URL || 'http://gym-service:5004';
const BOOKING_SERVICE_URL = process.env.BOOKING_SERVICE_URL || 'http://booking-service:5005';

// Routes that do NOT require JWT verification
const PUBLIC_ROUTES = [
  { method: 'POST', pattern: /^\/api\/auth\/(signup|login|refresh-token|forgot-password)$/ },
  { method: 'GET', pattern: /^\/api\/gyms(\?.*)?$/ },
  { method: 'GET', pattern: /^\/api\/gyms\/\d+(\?.*)?$/ },
  { method: 'GET', pattern: /^\/api\/gyms\/\d+\/slots/ },
  { method: 'GET', pattern: /^\/api\/gyms\/\d+\/reviews/ },
  { method: 'GET', pattern: /^\/health/ },
];

function isPublicRoute(method, path) {
  return PUBLIC_ROUTES.some(r => r.method === method && r.pattern.test(path));
}

function authMiddleware(req, res, next) {
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
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

app.use(authMiddleware);

app.get('/health', (req, res) => res.json({ status: 'Gateway is healthy', timestamp: new Date().toISOString() }));

app.use('/api/auth', proxy(AUTH_SERVICE_URL));
app.use('/api/users', proxy(USER_SERVICE_URL));
app.use('/api/wallet', proxy(WALLET_SERVICE_URL));
app.use('/api/gyms', proxy(GYM_SERVICE_URL));
app.use('/api/bookings', proxy(BOOKING_SERVICE_URL));

const PORT = process.env.GATEWAY_PORT || 5000;
app.listen(PORT, () => console.log(`Gateway running on port ${PORT}`));
