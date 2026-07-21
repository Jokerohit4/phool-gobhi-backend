import {
  listActiveJobOpenings,
  listAllJobOpenings,
  createJobOpening,
  setJobOpeningActive,
  deleteJobOpening,
} from '../services/jobOpeningService.js';

export const listPublicJobOpenings = async (req, res) => {
  try {
    const jobs = await listActiveJobOpenings();
    res.json({ data: jobs });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const listAdminJobOpenings = async (req, res) => {
  try {
    const jobs = await listAllJobOpenings();
    res.json({ data: jobs });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const addJobOpening = async (req, res) => {
  try {
    const job = await createJobOpening(req.body ?? {});
    res.status(201).json({ data: job });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const updateJobOpeningStatus = async (req, res) => {
  try {
    const job = await setJobOpeningActive(req.params.id, req.body?.isActive);
    res.json({ data: job });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const removeJobOpening = async (req, res) => {
  try {
    await deleteJobOpening(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
