// Mirrors requireGobhi.js's pattern for the one other role this service
// needs to gate a route on.
const requireCustomer = (req, res, next) => {
  const userId = req.headers['x-user-id'];
  const role = req.headers['x-user-role'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (role !== 'customer') return res.status(403).json({ error: 'Forbidden' });
  req.user = { id: parseInt(userId), role, type: req.headers['x-user-type'] };
  next();
};

export default requireCustomer;
