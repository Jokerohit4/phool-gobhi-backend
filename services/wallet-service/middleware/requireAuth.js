export const extractUser = (req, res, next) => {
  const userId = req.headers['x-user-id'];
  if (userId) req.userId = parseInt(userId);
  req.userRole = req.headers['x-user-role'];
  next();
};

export const requireAuth = (req, res, next) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!roles.includes(req.userRole)) return res.status(403).json({ error: 'Forbidden' });
  next();
};

// Guards service-to-service endpoints (credit/debit). The shared secret is known
// only to backend services; the gateway strips any client-supplied x-internal-key,
// so external callers can never satisfy this check.
export const requireInternal = (req, res, next) => {
  const key = req.headers['x-internal-key'];
  // .trim() guards against a stray trailing newline in the Secret Manager
  // value: a raw env-var read keeps it, but the same value sent as an HTTP
  // header gets it silently stripped by the caller's HTTP client —
  // producing a 1-character mismatch that looks like a wrong secret.
  const expected = (process.env.INTERNAL_API_KEY || '').trim();
  if (!expected || key !== expected) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};
