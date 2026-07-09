// Guards service-to-service endpoints. The shared secret is known only to
// backend services; the gateway strips any client-supplied x-internal-key,
// so external callers can never satisfy this check.
const requireInternal = (req, res, next) => {
  const key = req.headers['x-internal-key'];
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected || key !== expected) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

export default requireInternal;
