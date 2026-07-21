import * as buddyService from '../services/buddyService.js';

// ---- Profile ----------------------------------------------------------

export const getMyProfile = async (req, res) => {
  try {
    const profile = await buddyService.getMyProfile(req.userId);
    res.json({ data: profile });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const upsertProfile = async (req, res) => {
  try {
    const { bio, lat, lng, isDiscoverable } = req.body || {};
    const profile = await buddyService.createOrUpdateProfile(req.userId, { bio, lat, lng, isDiscoverable });
    res.json({ data: profile });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const refreshProfile = async (req, res) => {
  try {
    const profile = await buddyService.refreshProfileFromAuth(req.userId);
    res.json({ data: profile });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// ---- Photos -------------------------------------------------------------

export const addPhotos = async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No photos provided' });
    const photos = await buddyService.addPhotos(req.userId, req.files);
    res.status(201).json({ data: photos });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const reorderPhotos = async (req, res) => {
  try {
    const { order } = req.body || {};
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of photo ids' });
    const photos = await buddyService.reorderPhotos(req.userId, order.map(Number));
    res.json({ data: photos });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const deletePhoto = async (req, res) => {
  try {
    const result = await buddyService.deletePhoto(req.userId, parseInt(req.params.photoId));
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// ---- Filters --------------------------------------------------------------

export const getFilters = async (req, res) => {
  try {
    const filters = await buddyService.getFilters(req.userId);
    res.json({ data: filters });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const updateFilters = async (req, res) => {
  try {
    const filters = await buddyService.upsertFilters(req.userId, req.body || {}, req.userType);
    res.json({ data: filters });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// ---- Discovery / swipes -----------------------------------------------------

export const getDiscoveryFeed = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const feed = await buddyService.getFeed(req.userId, { page, limit });
    res.json(feed);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const swipe = async (req, res) => {
  try {
    const { targetUserId, action } = req.body || {};
    if (!targetUserId) return res.status(400).json({ error: 'targetUserId is required' });
    const result = await buddyService.recordSwipe(req.userId, parseInt(targetUserId), action);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// ---- Matches & chat --------------------------------------------------------

export const getMatches = async (req, res) => {
  try {
    const matches = await buddyService.getMatches(req.userId);
    res.json({ data: matches });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getMatchedProfile = async (req, res) => {
  try {
    const profile = await buddyService.getMatchedProfile(req.userId, parseInt(req.params.matchId));
    res.json({ data: profile });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const unmatch = async (req, res) => {
  try {
    const match = await buddyService.unmatch(req.userId, parseInt(req.params.matchId));
    res.json({ data: match });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getMessages = async (req, res) => {
  try {
    const { before, after, limit } = req.query;
    const messages = await buddyService.getMessages(req.userId, parseInt(req.params.matchId), { before, after, limit });
    res.json({ data: messages });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const sendMessage = async (req, res) => {
  try {
    const { body } = req.body || {};
    const message = await buddyService.sendMessage(req.userId, parseInt(req.params.matchId), body);
    res.status(201).json({ data: message });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// ---- Blocks (v1 safety) ----------------------------------------------------

export const blockUser = async (req, res) => {
  try {
    const { userId, reason } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const result = await buddyService.blockUser(req.userId, parseInt(userId), reason);
    res.status(201).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const unblockUser = async (req, res) => {
  try {
    const result = await buddyService.unblockUser(req.userId, parseInt(req.params.userId));
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const listBlocked = async (req, res) => {
  try {
    const blocked = await buddyService.listBlocked(req.userId);
    res.json({ data: blocked });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// ---- Internal ---------------------------------------------------------

export const syncProfile = async (req, res) => {
  try {
    await buddyService.syncProfileFromAuth(parseInt(req.params.userId));
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
