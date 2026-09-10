import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Health+ FR-04 / Tech S08. Both blueprints call an audit log P0 and
// neither shipped one.
//
// Records the ACTOR and the data class, never the data. An audit trail
// that copies the sensitive rows it audits has doubled the exposure it
// exists to control - so there are no values here, no marker names, no
// biometric readings.
//
// Fire-and-forget on purpose: a failure to write the audit row must never
// fail the export or the deletion it was auditing. A user losing their
// erasure because a log insert timed out is a far worse outcome than a
// gap in the log, which is why this swallows rather than throws.
export function recordAudit({ userId, actorId = null, action, dataType }) {
  prisma.healthDataAuditLog
    .create({ data: { userId, actorId, action, dataType } })
    .catch((err) => console.error('[audit] write failed:', err.message));
}
