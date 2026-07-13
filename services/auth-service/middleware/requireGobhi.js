// Mirrors gym-service/wallet-service's requireRole('gobhi') pattern. The
// gateway is the only thing allowed to set x-user-role (derived from a
// verified JWT), so trusting it here is safe.
const requireGobhi = (req, res, next) => {
  const userId = req.headers['x-user-id'];
  const role = req.headers['x-user-role'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (role !== 'gobhi') return res.status(403).json({ error: 'Forbidden' });
  req.user = { id: parseInt(userId), role, type: req.headers['x-user-type'] };
  next();
};

export default requireGobhi;
