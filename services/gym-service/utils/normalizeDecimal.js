import { Decimal } from '@prisma/client/runtime/library';

export function normalizeDecimal(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Decimal) return Number(value.toNumber());
  if (Array.isArray(value)) return value.map(normalizeDecimal);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizeDecimal(v);
    }
    return out;
  }
  return value;
}

export function sanitizeApiResponse(payload) {
  return normalizeDecimal(payload);
}
