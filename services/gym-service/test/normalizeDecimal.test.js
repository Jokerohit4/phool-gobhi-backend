// sanitizeApiResponse wraps gym-service responses to turn Prisma Decimals into
// numbers. It used to rebuild every object it met, which flattened a Date into
// `{}` — so a review's createdAt reached clients as `{}` and the app's
// `createdAt as String?` threw. These pin that dates stay dates (and so
// serialise as ISO strings) while Decimals still become numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '@prisma/client/runtime/library';
import { normalizeDecimal, sanitizeApiResponse } from '../utils/normalizeDecimal.js';

test('a Date survives and serialises as an ISO string', () => {
  const when = new Date('2026-01-02T03:04:05.000Z');
  const out = sanitizeApiResponse({ data: [{ rating: 5, createdAt: when }] });
  assert.ok(out.data[0].createdAt instanceof Date);
  assert.equal(
    JSON.stringify(out),
    '{"data":[{"rating":5,"createdAt":"2026-01-02T03:04:05.000Z"}]}',
  );
});

test('Decimals still become numbers next to dates', () => {
  const out = normalizeDecimal({
    pricePerSession: new Decimal('149.5'),
    updatedAt: new Date('2026-03-04T00:00:00.000Z'),
    nested: { rating: new Decimal('4.25'), list: [new Decimal('1')] },
  });
  assert.equal(out.pricePerSession, 149.5);
  assert.equal(out.nested.rating, 4.25);
  assert.deepEqual(out.nested.list, [1]);
  assert.equal(out.updatedAt.toISOString(), '2026-03-04T00:00:00.000Z');
});

test('null, undefined and plain values pass through', () => {
  assert.equal(normalizeDecimal(null), null);
  assert.equal(normalizeDecimal(undefined), undefined);
  assert.equal(normalizeDecimal('x'), 'x');
  assert.equal(normalizeDecimal(3), 3);
  assert.deepEqual(normalizeDecimal({ a: null, b: [] }), { a: null, b: [] });
});
