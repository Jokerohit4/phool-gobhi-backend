import * as userService from '../services/userService.js';

export const createUser = async (req, res) => {
  try {
    const { authId, name, email, role } = req.body;
    const user = await userService.createUserProfile({ authId, name, email, role });
    res.status(201).json({ data: user });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getUser = async (req, res) => {
  try {
    const user = await userService.getUserProfile(parseInt(req.params.userId));
    res.json({ data: user });
  } catch (err) {
    res.status(err.status || 404).json({ error: err.error || 'Not found' });
  }
};

export const updateUser = async (req, res) => {
  try {
    const requestingUserId = req.userId; // from gateway header
    const targetUserId = parseInt(req.params.userId);
    if (requestingUserId !== targetUserId) return res.status(403).json({ error: 'Forbidden' });
    const { name, phone, profileImageUrl } = req.body;
    const user = await userService.updateUserProfile(targetUserId, { name, phone, profileImageUrl });
    res.json({ data: user });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message });
  }
};
