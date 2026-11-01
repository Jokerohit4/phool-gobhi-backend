// Cursor pagination helpers (additive contract shared by wallet-service
// /transactions, health-service /sessions and booking-service /bookings/mine).
//
//   ?limit=<int>   default and max are per endpoint; invalid or < 1 -> default,
//                  > max -> max
//   ?cursor=<id>   numeric id of the LAST item the client already has; absent
//                  (or not a positive integer) -> first page
//
// Responses keep their existing shape and add
//   meta: { nextCursor: <id of last returned item | null>, hasMore: boolean }
//
// Callers must query with a STABLE total order ending in `id` (e.g.
// [{ createdAt: 'desc' }, { id: 'desc' }]) so rows with identical timestamps
// never duplicate or drop across a page boundary.

export function parseLimit(raw, defaultLimit, maxLimit) {
  if (raw === undefined || raw === null || raw === '') return defaultLimit;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return defaultLimit;
  return Math.min(n, maxLimit);
}

export function parseCursor(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Prisma findMany args for one page: fetches limit + 1 rows to detect hasMore.
export function pageArgs({ limit, cursor }) {
  return { take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) };
}

// Trims the extra look-ahead row and builds meta from the rows fetched.
export function finishPage(rows, limit) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items,
    meta: { nextCursor: hasMore ? items[items.length - 1].id : null, hasMore },
  };
}
