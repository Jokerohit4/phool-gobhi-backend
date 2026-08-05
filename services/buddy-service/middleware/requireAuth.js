import crypto from 'crypto';

export const requireAuth = (req, res, next) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = parseInt(userId);
  req.userRole = req.headers['x-user-role'];
  req.userType = req.headers['x-user-type'];
  next();
};

export const requireRole = (...roles) => (req, res, next) => {
  const userId = req.headers['x-user-id'];
  const role = req.headers['x-user-role'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!roles.includes(role)) return res.status(403).json({ error: 'Forbidden' });
  req.userId = parseInt(userId);
  req.userRole = role;
  req.userType = req.headers['x-user-type'];
  next();
};

// Guards service-to-service endpoints. The shared secret is known only to
// backend services; the gateway strips any client-supplied x-internal-key,
// so external callers can never satisfy this check.
export const requireInternal = (req, res, next) => {
  const key = req.headers['x-internal-key'];
  // .trim() guards against a stray trailing newline in the Secret Manager
  // value: a raw env-var read keeps it, but the same value sent as an HTTP
  // header gets it silently stripped by the caller's HTTP client —
  // producing a 1-character mismatch that looks like a wrong secret.
  const expected = (process.env.INTERNAL_API_KEY || '').trim();
  // Constant-time compare — a plain !== on a shared secret leaks a timing
  // signal proportional to how many leading bytes matched. Low-risk in
  // practice (this endpoint class is additionally gated by Cloud Run IAM,
  // which restricts callers to the gateway/deploy service accounts), but
  // cheap to close outright.
  const keyBuf = Buffer.from(String(key ?? ''));
  const expectedBuf = Buffer.from(expected);
  const valid = expected.length > 0 && keyBuf.length === expectedBuf.length && crypto.timingSafeEqual(keyBuf, expectedBuf);
  if (!valid) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};
