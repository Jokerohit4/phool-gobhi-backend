import {
  submitJobApplication,
  listJobApplications,
  markJobApplicationRead,
} from '../services/jobApplicationService.js';
import { saveResume } from '../utils/gcsResume.js';

export const submitApplication = async (req, res) => {
  try {
    const resumePath = await saveResume(req.file);
    const application = await submitJobApplication(req.params.jobOpeningId, {
      ...(req.body ?? {}),
      resumePath,
    });
    res.status(201).json({ data: application });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const listApplications = async (req, res) => {
  try {
    const applications = await listJobApplications();
    res.json({ data: applications });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export const updateApplicationRead = async (req, res) => {
  try {
    const updated = await markJobApplicationRead(req.params.id, req.body?.isRead);
    res.json({ data: updated });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
