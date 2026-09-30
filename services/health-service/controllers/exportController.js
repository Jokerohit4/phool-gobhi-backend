import * as exportService from '../services/exportService.js';
import { recordAudit } from '../services/auditService.js';
import { isFeatureEnabled } from '../middleware/requireFeatureFlag.js';
import { hasCycleConsentService } from '../services/cycleTrackingService.js';
import { seriesToWellnessBundle, FHIR_DEFAULT_INCLUDES } from '../services/fhir/wellnessBundle.js';

// FR-16 — the user's own data only, always scoped to req.userId; there's no
// parameter here that could widen it to anyone else's rows.
export const exportMyData = async (req, res) => {
  try {
    const { from, to, format } = req.query || {};
    // Self-service: actor and subject are the same person. (The FHIR branch
    // audits itself, after its flag check, with its own dataType.)
    if (format !== 'fhir') {
      recordAudit({ userId: req.userId, actorId: req.userId, action: 'export', dataType: 'sessions+biometrics' });
    }
    for (const [name, value] of [['from', from], ['to', to]]) {
      if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return res.status(400).json({ error: `${name} must be YYYY-MM-DD` });
      }
    }
    if (format === 'fhir') return await exportFhir(req, res, { from, to });

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

// ABHA-FHIR-INTEGRATION.md Stage 0: the same range, as an FHIR R4 document
// Bundle (NRCeS WellnessRecord). Same route, same `gated` middleware, same
// audit trail as the JSON/CSV download - a new format of the user's own data,
// not a new kind of access.
//
// Behind its own admin flag (`fhirExport`, off by default) on top of
// healthMetrics: until the HAPI validator passes against the NRCeS IG we must
// not hand anyone a file labelled as a government-standard record.
//
// Cycle logs are opt-in PER EXPORT (`includeCycle=true`) and additionally need
// live cycle consent. Refusing that combination does not fail the export; it
// withholds the slice and says why, the medical-records pattern.
async function exportFhir(req, res, { from, to }) {
  if (!(await isFeatureEnabled('fhirExport'))) {
    return res.status(403).json({ error: 'FEATURE_DISABLED' });
  }
  const wantsCycle = req.query?.includeCycle === 'true';
  let cycleIncluded = false;
  let cycleReason;
  if (wantsCycle) {
    // Fails closed like requireCycleConsent: an unverifiable consent is no consent.
    const consented = await hasCycleConsentService(req.userId).catch(() => false);
    cycleIncluded = consented;
    if (!consented) cycleReason = 'cycle logs were requested but cycle-tracking consent is not currently granted';
  }
  recordAudit({
    userId: req.userId,
    actorId: req.userId,
    action: 'export',
    dataType: cycleIncluded ? 'fhir+cycle' : 'fhir',
  });

  const include = [...FHIR_DEFAULT_INCLUDES, ...(cycleIncluded ? ['cycleLogged'] : [])];
  const [series, withheld] = await Promise.all([
    exportService.buildRangeSeriesService(req.userId, { from, to }, { include }),
    exportService.countFhirWithheldService(req.userId, { cycleIncluded, cycleReason }),
  ]);
  const { bundle, conversionWarnings } = seriesToWellnessBundle(series, {
    userId: req.userId,
    generatedAt: new Date(),
  });
  res.json({ data: { bundle, withheld, conversionWarnings } });
}

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
    // Fan-out from auth-service's platform export. The actor is the user
    // themselves - this path is only ever reached by their own request -
    // but it is logged separately because it returns strictly more than
    // the self-service export above.
    recordAudit({ userId, actorId: userId, action: 'export', dataType: 'all' });
    const data = await exportService.buildFullExportService(userId);
    res.json({ data });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
