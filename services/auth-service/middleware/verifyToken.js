const verifyToken = (req, res, next) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  req.user = {
    id: parseInt(userId),
    role: req.headers['x-user-role'],
    type: req.headers['x-user-type'],
  };
  next();
};

export default verifyToken;
