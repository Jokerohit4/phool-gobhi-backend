import User from '../models/user.js';

export async function createUserProfile({ authId, name, email, role }) {
  const existing = await User.findOne({ authId });
  if (existing) return existing;
  return await User.create({ authId, name, email, role });
}

export async function getUserProfile(authId) {
  const user = await User.findOne({ authId });
  if (!user) throw { status: 404, error: 'User profile not found' };
  return user;
}

export async function updateUserProfile(authId, updates) {
  const user = await User.findOneAndUpdate(
    { authId },
    { $set: updates },
    { new: true, upsert: false }
  );
  if (!user) throw { status: 404, error: 'User profile not found' };
  return user;
}
