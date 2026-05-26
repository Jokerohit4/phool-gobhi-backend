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
