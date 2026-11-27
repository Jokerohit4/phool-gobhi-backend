// Optimistic concurrency for admin-edited singleton config rows.
//
// Contract (identical in every service that has a copy of this file):
//   - The admin GET returns the row's `updatedAt` (ISO string, null if no row yet).
//   - The admin PUT accepts an OPTIONAL `expectedUpdatedAt` (ISO string).
//       absent  -> behaves exactly as before (last write wins).
//       present -> the write only lands if the stored updatedAt still equals it;
//                  otherwise HTTP 409
//                  { error, errorCode: 'CONFIG_CONFLICT', currentUpdatedAt } and
//                  nothing is written.
//   - The comparison is part of the write itself (updateMany WHERE updatedAt = ?),
//     so two concurrent saves cannot both pass - no read-then-write window.
//
// No new column or migration: the existing @updatedAt column is the ETag.

export const CONFIG_CONFLICT_MESSAGE = 'This setting was changed by someone else. Reload and try again.';
export const CONFIG_CONFLICT_CODE = 'CONFIG_CONFLICT';

export function parseExpectedUpdatedAt(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = typeof raw === 'string' ? new Date(raw) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw { status: 400, error: 'expectedUpdatedAt must be an ISO date string' };
  }
  return parsed;
}

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function configConflictError(currentUpdatedAt) {
  return {
    status: 409,
    error: CONFIG_CONFLICT_MESSAGE,
    errorCode: CONFIG_CONFLICT_CODE,
    currentUpdatedAt: toIso(currentUpdatedAt),
  };
}

// Body to send for a thrown service error. Keeps the {error} shape every
// controller already uses and adds the conflict fields only when present.
export function errorBody(err, fallback = 'Server error') {
  const body = { error: err?.error || err?.message || fallback };
  if (err?.errorCode) body.errorCode = err.errorCode;
  if (err?.currentUpdatedAt !== undefined) body.currentUpdatedAt = err.currentUpdatedAt;
  return body;
}

// Writes the singleton row (id = 1). `delegate` is the Prisma model delegate
// (e.g. prisma.otpProviderSetting). Returns the saved row.
export function writeSingleton(delegate, changes) {
  return writeConfigRow(delegate, { id: 1 }, changes);
}

export async function writeConfigRow(delegate, key, { create, update, expected }) {
  if (expected === undefined) {
    return delegate.upsert({ where: key, create: { ...key, ...create }, update });
  }
  // Always move updatedAt forward by at least 1ms so two saves can never share
  // a timestamp, and set it explicitly so the response needs no second read
  // (which could observe somebody else's later write).
  const next = new Date(Math.max(Date.now(), expected.getTime() + 1));
  const { count } = await delegate.updateMany({
    where: { ...key, updatedAt: expected },
    data: { ...update, updatedAt: next },
  });
  if (count === 1) return { ...key, ...update, updatedAt: next };
  const current = await delegate.findUnique({ where: key });
  throw configConflictError(current?.updatedAt);
}
