// Guards service-to-service endpoints. The shared secret is known only to
// backend services; the gateway strips any client-supplied x-internal-key,
// so external callers can never satisfy this check.
const requireInternal = (req, res, next) => {
  const key = req.headers['x-internal-key'];
  // .trim() guards against a stray trailing newline in the Secret Manager
  // value: a raw env-var read keeps it, but the same value sent as an HTTP
  // header gets it silently stripped by the HTTP client on the caller's
  // side — producing a 1-character mismatch that looks like a wrong secret.
  const expected = (process.env.INTERNAL_API_KEY || '').trim();
  if (!expected || key !== expected) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

export default requireInternal;
