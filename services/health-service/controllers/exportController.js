import * as exportService from '../services/exportService.js';

// FR-16 — the user's own data only, always scoped to req.userId; there's no
// parameter here that could widen it to anyone else's rows.
export const exportMyData = async (req, res) => {
  try {
    const { from, to, format } = req.query || {};
    for (const [name, value] of [['from', from], ['to', to]]) {
      if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return res.status(400).json({ error: `${name} must be YYYY-MM-DD` });
      }
    }
    const series = await exportService.buildRangeSeriesService(req.userId, { from, to });

    if (format === 'csv') {
      const csv = exportService.seriesToCsv(series);
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="phool-gobhi-training-${stamp}.csv"`);
      return res.send(csv);
    }
    res.json({ data: series });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// DPDPA access right (s.11) — the read twin of eraseUserInternal. Internal
// only: auth-service authenticates the user and fans out, so the :userId in
// this URL is never attacker-controlled. Distinct from exportMyData above,
// which is FR-16's date-ranged training download; this is everything the
// service holds, unranged and unsummarised.
export const exportUserInternal = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'A numeric userId is required' });
    }
    const data = await exportService.buildFullExportService(userId);
    res.json({ data });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
