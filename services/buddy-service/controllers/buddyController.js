import * as buddyService from '../services/buddyService.js';
import * as erasureService from '../services/erasureService.js';
import * as exportService from '../services/exportService.js';
import * as leagueService from '../services/leagueService.js';

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
    const { bio, lat, lng, isDiscoverable, socialMediaUrl } = req.body || {};
    const profile = await buddyService.createOrUpdateProfile(req.userId, { bio, lat, lng, isDiscoverable, socialMediaUrl });
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

export const addPhotoFromUrl = async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required' });
    const photo = await buddyService.addPhotoFromUrl(req.userId, url);
    res.status(201).json({ data: photo });
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

// ---- Reports -------------------------------------------------------------

// `reason` is validated against the Prisma enum rather than cast blindly: an
// unknown value would otherwise reach create() as a Postgres enum cast error
// and surface as a 500. Free-text `details` is only accepted alongside the
// `other` reason — prose filed under `harassment` is a taxonomy bug, not a
// richer report, and letting it through would corrupt the queue's counts.
const REPORT_REASONS = [
  'harassment', 'inappropriate_content', 'impersonation', 'spam',
  'underage', 'scam', 'threat', 'other',
];

export const reportUser = async (req, res) => {
  try {
    const { userId, reason, details } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!reason) return res.status(400).json({ error: 'reason is required' });
    if (!REPORT_REASONS.includes(reason)) {
      return res.status(400).json({ error: `reason must be one of: ${REPORT_REASONS.join(', ')}` });
    }
    if (details && reason !== 'other') {
      return res.status(400).json({ error: 'details is only allowed when reason is "other"' });
    }
    const result = await buddyService.reportUser(
      req.userId, parseInt(userId), reason, details,
    );
    res.status(201).json(result);
  } catch (err) {
    // A repeat report from the same person about the same user trips the
    // [reporterId, reportedUserId] unique constraint. That is a spam guard, not
    // a server fault, and 409 keeps it from looking like a bug in the client's
    // eyes — the original report is already in the queue.
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'You have already reported this user' });
    }
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const listReports = async (req, res) => {
  try {
    const { status, limit } = req.query || {};
    if (status && !['open', 'dismissed', 'actioned', 'all'].includes(status)) {
      return res.status(400).json({ error: 'status must be open, dismissed, actioned or all' });
    }
    const reports = await buddyService.listReports({ status, limit });
    res.json({ data: reports });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const reviewReport = async (req, res) => {
  try {
    const { status, resolutionNote } = req.body || {};
    if (!status) return res.status(400).json({ error: 'status is required' });
    const result = await buddyService.reviewReport(
      req.params.id, { status, resolutionNote }, req.userId,
    );
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getConsistencyLeague = async (req, res) => {
  try {
    const league = await leagueService.getConsistencyLeague(req.userId);
    res.json({ data: league });
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

// Called by challenge-service to authorize a paired-streak opt-in.
export const verifyMatchMembership = async (req, res) => {
  try {
    const result = await buddyService.verifyActiveMatchMembership(
      req.params.matchId, parseInt(req.params.userId),
    );
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// DPDPA erasure — called by auth-service's account-deletion orchestration
// (see its deleteUserService). Internal-only: a user reaches this through
// deleting their account, never directly.
export const eraseUser = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'A numeric userId is required' });
    }
    const result = await erasureService.eraseUserService(userId);
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};


// ---- DPDPA access right (s.11) -------------------------------------------
// Internal only: auth-service authenticates the user and fans out to every
// service that holds their data, then assembles one document. Never exposed
// at the gateway, so there is no path where a userId in a URL could let one
// person read another's slice.
export const exportUserInternal = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'A numeric userId is required' });
    }
    const data = await exportService.buildExportService(userId);
    res.json({ data });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
