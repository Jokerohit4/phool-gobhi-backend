import * as buddyService from '../services/buddyService.js';
import * as erasureService from '../services/erasureService.js';
import * as exportService from '../services/exportService.js';
import * as leagueService from '../services/leagueService.js';

// Error contract: { error: <readable sentence>, code }. `code` is only
// forwarded from errors this service threw on purpose (they carry a numeric
// `status`); a raw Prisma error's code (P2025 etc.) is never leaked.
function sendError(res, err) {
  const body = { error: err.error || err.message || 'Server error' };
  if (err.status && err.code) body.code = err.code;
  res.status(err.status || 500).json(body);
}

// ---- Profile ----------------------------------------------------------

export const getMyProfile = async (req, res) => {
  try {
    const profile = await buddyService.getMyProfile(req.userId);
    res.json({ data: profile });
  } catch (err) {
    sendError(res, err);
  }
};

export const upsertProfile = async (req, res) => {
  try {
    const { bio, lat, lng, isDiscoverable, socialMediaUrl } = req.body || {};
    const { profile, code } = await buddyService.createOrUpdateProfile(req.userId, { bio, lat, lng, isDiscoverable, socialMediaUrl });
    // PHOTOS_REQUIRED is a 200: the save went through, the profile just stays
    // hidden (data.isDiscoverable is false).
    if (code) {
      return res.json({ data: profile, code, message: buddyService.BUDDY_ERRORS[code].error });
    }
    res.json({ data: profile });
  } catch (err) {
    sendError(res, err);
  }
};

export const refreshProfile = async (req, res) => {
  try {
    const profile = await buddyService.refreshProfileFromAuth(req.userId);
    res.json({ data: profile });
  } catch (err) {
    sendError(res, err);
  }
};

// ---- Photos -------------------------------------------------------------

export const addPhotos = async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No photos provided' });
    const photos = await buddyService.addPhotos(req.userId, req.files);
    res.status(201).json({ data: photos });
  } catch (err) {
    sendError(res, err);
  }
};

export const addPhotoFromUrl = async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required' });
    const photo = await buddyService.addPhotoFromUrl(req.userId, url);
    res.status(201).json({ data: photo });
  } catch (err) {
    sendError(res, err);
  }
};

export const reorderPhotos = async (req, res) => {
  try {
    const { order } = req.body || {};
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of photo ids' });
    const photos = await buddyService.reorderPhotos(req.userId, order.map(Number));
    res.json({ data: photos });
  } catch (err) {
    sendError(res, err);
  }
};

export const deletePhoto = async (req, res) => {
  try {
    const result = await buddyService.deletePhoto(req.userId, parseInt(req.params.photoId));
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
};

// ---- Filters --------------------------------------------------------------

export const getFilters = async (req, res) => {
  try {
    const filters = await buddyService.getFilters(req.userId);
    res.json({ data: filters });
  } catch (err) {
    sendError(res, err);
  }
};

export const updateFilters = async (req, res) => {
  try {
    const filters = await buddyService.upsertFilters(req.userId, req.body || {}, req.userType);
    res.json({ data: filters });
  } catch (err) {
    sendError(res, err);
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
    sendError(res, err);
  }
};

export const swipe = async (req, res) => {
  try {
    const { targetUserId, action } = req.body || {};
    if (!targetUserId) return res.status(400).json({ error: 'targetUserId is required' });
    const result = await buddyService.recordSwipe(req.userId, Number(targetUserId), action);
    res.json({ data: result });
  } catch (err) {
    sendError(res, err);
  }
};

// ---- Matches & chat --------------------------------------------------------

export const getMatches = async (req, res) => {
  try {
    const matches = await buddyService.getMatches(req.userId);
    res.json({ data: matches });
  } catch (err) {
    sendError(res, err);
  }
};

export const getMatchedProfile = async (req, res) => {
  try {
    const profile = await buddyService.getMatchedProfile(req.userId, parseInt(req.params.matchId));
    res.json({ data: profile });
  } catch (err) {
    sendError(res, err);
  }
};

export const unmatch = async (req, res) => {
  try {
    const match = await buddyService.unmatch(req.userId, parseInt(req.params.matchId));
    res.json({ data: match });
  } catch (err) {
    sendError(res, err);
  }
};

export const getMessages = async (req, res) => {
  try {
    const { before, after, limit } = req.query;
    const messages = await buddyService.getMessages(req.userId, parseInt(req.params.matchId), { before, after, limit });
    res.json({ data: messages });
  } catch (err) {
    sendError(res, err);
  }
};

export const sendMessage = async (req, res) => {
  try {
    const { body } = req.body || {};
    const message = await buddyService.sendMessage(req.userId, parseInt(req.params.matchId), body);
    res.status(201).json({ data: message });
  } catch (err) {
    sendError(res, err);
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
    sendError(res, err);
  }
};

export const unblockUser = async (req, res) => {
  try {
    const result = await buddyService.unblockUser(req.userId, parseInt(req.params.userId));
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
};

export const listBlocked = async (req, res) => {
  try {
    const blocked = await buddyService.listBlocked(req.userId);
    res.json({ data: blocked });
  } catch (err) {
    sendError(res, err);
  }
};

// ---- Reports -------------------------------------------------------------

// `reason` is validated against the Prisma enum rather than cast blindly: an
// unknown value would otherwise reach create() as a Postgres enum cast error
// and surface as a 500. Free-text `details` is only accepted alongside the
// `other` reason — prose filed under `harassment` is a taxonomy bug, not a
// richer report, and letting it through would corrupt the queue's counts.
export const REPORT_REASONS = [
  'harassment', 'inappropriate_content', 'impersonation', 'spam',
  'underage', 'scam', 'threat', 'other',
];

// Old app builds send these exact label strings (build plan, Report reasons).
// They're accepted without details. "Sharing personal contact details" lands
// as `other` with the same details the new app sends for that label, so the
// admin queue reads the same whichever build filed it.
export const LEGACY_REPORT_REASONS = {
  'Inappropriate or offensive content': { reason: 'inappropriate_content' },
  'Harassment or abuse': { reason: 'harassment' },
  'Spam or scam': { reason: 'scam' },
  'Sharing personal contact details': { reason: 'other', details: 'Shared contact details' },
  'Something else': { reason: 'other' },
};

export function normalizeReportReason(reason, details) {
  const legacy = LEGACY_REPORT_REASONS[typeof reason === 'string' ? reason.trim() : reason];
  if (legacy) return { reason: legacy.reason, details: details || legacy.details };
  return { reason, details };
}

export const reportUser = async (req, res) => {
  try {
    const { userId, reason: rawReason, details: rawDetails } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required', code: 'VALIDATION_ERROR' });
    if (!rawReason) return res.status(400).json({ error: 'reason is required', code: 'VALIDATION_ERROR' });
    const { reason, details } = normalizeReportReason(rawReason, rawDetails);
    if (!REPORT_REASONS.includes(reason)) {
      return res.status(400).json({ error: `reason must be one of: ${REPORT_REASONS.join(', ')}`, code: 'VALIDATION_ERROR' });
    }
    if (details && reason !== 'other') {
      return res.status(400).json({ error: 'details is only allowed when reason is "other"', code: 'VALIDATION_ERROR' });
    }
    const result = await buddyService.reportUser(req.userId, Number(userId), reason, details);
    res.status(201).json(result);
  } catch (err) {
    // A repeat report from the same person about the same user trips the
    // [reporterId, reportedUserId] unique constraint. That is a spam guard, not
    // a server fault, and 409 keeps it from looking like a bug in the client's
    // eyes — the original report is already in the queue.
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'You have already reported this user', code: 'ALREADY_REPORTED' });
    }
    sendError(res, err);
  }
};

export const listReports = async (req, res) => {
  try {
    const { status, limit } = req.query || {};
    if (status && !['open', 'dismissed', 'actioned', 'all'].includes(status)) {
      return res.status(400).json({ error: 'status must be open, dismissed, actioned or all', code: 'VALIDATION_ERROR' });
    }
    const reports = await buddyService.listReports({ status, limit });
    res.json({ data: reports });
  } catch (err) {
    sendError(res, err);
  }
};

export const reviewReport = async (req, res) => {
  try {
    const { status, resolutionNote, suspend } = req.body || {};
    if (!status) return res.status(400).json({ error: 'status is required', code: 'VALIDATION_ERROR' });
    const result = await buddyService.reviewReport(
      req.params.id, { status, resolutionNote, suspend }, req.userId,
    );
    res.json({ data: result });
  } catch (err) {
    sendError(res, err);
  }
};

export const getReportContext = async (req, res) => {
  try {
    const result = await buddyService.getReportContext(req.params.id);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
};

export const releaseHold = async (req, res) => {
  try {
    const profile = await buddyService.releaseHold(Number(req.params.userId));
    res.json({ data: profile });
  } catch (err) {
    sendError(res, err);
  }
};

export const reinstateUser = async (req, res) => {
  try {
    const profile = await buddyService.reinstateUser(Number(req.params.userId));
    res.json({ data: profile });
  } catch (err) {
    sendError(res, err);
  }
};

export const listGenderChanges = async (req, res) => {
  try {
    const rows = await buddyService.listGenderChanges();
    res.json({ data: rows });
  } catch (err) {
    sendError(res, err);
  }
};

export const clearGenderChange = async (req, res) => {
  try {
    const profile = await buddyService.clearGenderChange(Number(req.params.userId));
    res.json({ data: profile });
  } catch (err) {
    sendError(res, err);
  }
};

export const getConsistencyLeague = async (req, res) => {
  try {
    const league = await leagueService.getConsistencyLeague(req.userId);
    res.json({ data: league });
  } catch (err) {
    sendError(res, err);
  }
};

// ---- Internal ---------------------------------------------------------

export const syncProfile = async (req, res) => {
  try {
    await buddyService.syncProfileFromAuth(parseInt(req.params.userId));
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
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
    sendError(res, err);
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
    sendError(res, err);
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
    sendError(res, err);
  }
};
