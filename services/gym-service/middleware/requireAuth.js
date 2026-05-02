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
