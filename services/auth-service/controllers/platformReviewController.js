import {
  listApprovedPlatformReviews,
  listAllPlatformReviews,
  upsertPlatformReview,
  setPlatformReviewApproval,
  deletePlatformReview,
} from '../services/platformReviewService.js';

export const listPublicPlatformReviews = async (req, res) => {
  try {
    const reviews = await listApprovedPlatformReviews();
    res.json({ data: reviews });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const listAdminPlatformReviews = async (req, res) => {
  try {
    const reviews = await listAllPlatformReviews();
    res.json({ data: reviews });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const submitPlatformReview = async (req, res) => {
  try {
    const review = await upsertPlatformReview(req.user.id, req.body ?? {});
    res.status(201).json({ data: review });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const updatePlatformReviewApproval = async (req, res) => {
  try {
    const review = await setPlatformReviewApproval(req.params.id, req.body?.isApproved);
    res.json({ data: review });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const removePlatformReview = async (req, res) => {
  try {
    await deletePlatformReview(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
