export const requireAuth = (req, res, next) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = parseInt(userId);
  req.userRole = req.headers['x-user-role'];
  next();
};
