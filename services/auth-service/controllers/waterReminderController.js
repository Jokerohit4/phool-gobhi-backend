import { runReminderService } from '../services/reminderService.js';

// POST /internal/reminders/run          { dryRun?: boolean, slot?: 'all' | 'HH:MM' }
// POST /internal/water-reminder/run     (older path, same handler)
// Guarded by requireInternalOrScheduler (see routes/auth.js). `slot` is only
// honoured for dry runs; a real run always sends the slot whose time is due.
export const runRemindersInternal = async (req, res) => {
  try {
    const dryRun = req.body?.dryRun === true;
    const raw = req.body?.slot;
    const slot = typeof raw === 'string' && (raw === 'all' || /^\d{2}:\d{2}$/.test(raw)) ? raw : undefined;
    const result = await runReminderService({ dryRun, slot });
    res.json({ data: result });
  } catch (err) {
    console.error('[reminders] run failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
};

export const runWaterReminderInternal = runRemindersInternal;
