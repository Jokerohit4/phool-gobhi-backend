import { Prisma } from '@prisma/client';

// Prisma's Decimal fields (weightKg, distanceMeters — see schema.prisma's
// @db.Decimal columns) serialize to JSON as STRINGS by default
// (Prisma.Decimal's own toJSON avoids float-precision loss), not numbers.
// wallet-service handles this per-field with Number(x) at each call site;
// here the same values are buried several levels deep in nested
// session -> exercises -> sets objects, so a single recursive pass is less
// error-prone than chasing every call site by hand. Sessions/records/daily
// activity rows are plain Prisma results (objects, arrays, Decimal, Date,
// primitives) — nothing here needs to handle arbitrary class instances.
export function serializeDecimals(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Prisma.Decimal) return Number(value);
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(serializeDecimals);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = serializeDecimals(val);
    return out;
  }
  return value;
}
