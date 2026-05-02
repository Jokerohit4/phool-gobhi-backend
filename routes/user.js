// routes/user.js
import express from 'express';
const router = express.Router();
import User from '../models/user.js';


// Create a user
router.post('/', async (req, res) => {
  try {
    const user = new User(req.body);
    const saved = await user.save();
    res.json(saved);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get all users
router.get('/', async (req, res) => {
  const users = await User.find();
  res.json(users);
});

export default router;
