// composeDailyBriefing — the pure body-builder behind the 9am IST partner
// briefing push. Same convention as memberActivity.test.js: bookingService's
// heavy deps are mocked once so the import works, and only the exported pure
// helper is exercised here.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let composeDailyBriefing;

test('setup: mock dependencies once, import bookingService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: { PrismaClient: class {}, Prisma: {} },
  });
  t.mock.module('axios', {
    exports: { default: {} },
  });
  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });
  t.mock.module(new URL('../utils/notifyPartner.js', import.meta.url).href, {
    exports: { notifyPartner: async () => {}, sendPartnerPush: async () => true },
  });
  ({ composeDailyBriefing } = await import('../services/bookingService.js'));
  assert.equal(typeof composeDailyBriefing, 'function');
});

test('money and check-ins both present, with peak', () => {
  assert.equal(
    composeDailyBriefing({ revenue: 1239.6, checkins: 14, peak: { weekday: 2, hour: 18, count: 9 } }),
    'Yesterday: ₹1240 in bookings · 14 check-ins. Busiest: Tue 6pm',
  );
});

test('check-ins only, no revenue', () => {
  assert.equal(
    composeDailyBriefing({ revenue: 0, checkins: 3, peak: null }),
    'Yesterday: 3 check-ins',
  );
});

test('revenue only', () => {
  assert.equal(
    composeDailyBriefing({ revenue: 500, checkins: 0, peak: null }),
    'Yesterday: ₹500 in bookings',
  );
});

test('one check-in stays singular', () => {
  assert.equal(
    composeDailyBriefing({ revenue: 0, checkins: 1, peak: null }),
    'Yesterday: 1 check-in',
  );
});

test('zero day nudges instead of reporting zeros', () => {
  assert.equal(
    composeDailyBriefing({ revenue: 0, checkins: 0, peak: null }),
    'No check-ins yesterday — share your gym to fill today.',
  );
});

test('peak with zero count is not appended', () => {
  assert.equal(
    composeDailyBriefing({ revenue: 100, checkins: 2, peak: { weekday: 0, hour: 0, count: 0 } }),
    'Yesterday: ₹100 in bookings · 2 check-ins',
  );
});

test('midnight peak formats as 12am, noon as 12pm', () => {
  assert.equal(
    composeDailyBriefing({ revenue: 0, checkins: 1, peak: { weekday: 3, hour: 0, count: 4 } }),
    'Yesterday: 1 check-in. Busiest: Wed 12am',
  );
  assert.equal(
    composeDailyBriefing({ revenue: 0, checkins: 1, peak: { weekday: 3, hour: 12, count: 4 } }),
    'Yesterday: 1 check-in. Busiest: Wed 12pm',
  );
});
