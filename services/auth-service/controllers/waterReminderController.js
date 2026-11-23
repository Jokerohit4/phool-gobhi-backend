import { runWaterReminderService } from '../services/waterReminderService.js';

// POST /internal/water-reminder/run  { dryRun?: boolean }
// Guarded by requireInternalOrScheduler (see routes/auth.js).
export const runWaterReminderInternal = async (req, res) => {
  try {
    const dryRun = req.body?.dryRun === true;
    const result = await runWaterReminderService({ dryRun });
    res.json({ data: result });
  } catch (err) {
    console.error('[water-reminder] run failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
};
