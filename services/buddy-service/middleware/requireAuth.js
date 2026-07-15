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
  if (!expected || key !== expected) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};
