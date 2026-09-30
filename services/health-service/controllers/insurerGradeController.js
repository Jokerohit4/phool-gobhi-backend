import { PrismaClient } from '@prisma/client';
import { buildInsurerGradeService } from '../services/share/insurerGradeService.js';
import { validateRange } from '../services/share/insurerGrade.js';
import { hasNutritionConsentService } from '../services/ledger/ledgerConsentService.js';
import { isFeatureEnabled } from '../middleware/requireFeatureFlag.js';
import { recordAudit } from '../services/auditService.js';

const prisma = new PrismaClient();

// The user's own ig-v1 summary - the exact object a future insurer share would
// sign (see services/share/insurerGrade.js). Read-only, self-service, always
// scoped to req.userId: there is no parameter that could widen it to anyone
// else. Same posture as exportController.exportMyData, including the audit row.
//
// Nothing is shared from here. This is the preview half of "what you approve is
// what is sent"; the send half (ShareGrant/ShareDisclosure + signing) is Stage 2.
export const getMyInsurerGrade = async (req, res) => {
  try {
    const { from, to } = req.query || {};
    validateRange({ from, to });
    recordAudit({ userId: req.userId, actorId: req.userId, action: 'read', dataType: 'insurer-grade' });

    // Ledger inputs only when the ledger exists AND this person's ledger consent
    // is current - the same two checks every ledger route makes.
    const ledgerAllowed =
      (await isFeatureEnabled('healthLedger')) && (await hasNutritionConsentService(req.userId));

    const data = await buildInsurerGradeService(prisma, { userId: req.userId, from, to, ledgerAllowed });
    res.json({ data });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error', code: err.code });
  }
};
