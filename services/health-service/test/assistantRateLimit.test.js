// Per-user rate limiting for the fitness assistant. Run with:
//   node --experimental-test-module-mocks --test
//
// This is the only thing standing between one user and an unbounded provider
// bill, so the boundaries are pinned rather than assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let rows = []; // {userId, sentAt}
let canSendMessageService, recordMessageSentService, MAX_PER_HOUR, MAX_PER_DAY;

test('setup: stub Prisma, import the service once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.assistantRateLimitLog = {
            count: async ({ where: { userId, sentAt } }) =>
              rows.filter((r) => r.userId === userId && r.sentAt >= sentAt.gte).length,
            create: async ({ data }) => {
              const row = { userId: data.userId, sentAt: data.sentAt ?? new Date() };
              rows.push(row);
              return row;
            },
          };
        }
      },
      Prisma: {},
    },
  });
  ({ canSendMessageService, recordMessageSentService, MAX_PER_HOUR, MAX_PER_DAY } =
    await import('../services/assistant/rateLimitService.js'));
});

function seed(userId, count, minutesAgoEach) {
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    rows.push({ userId, sentAt: new Date(now - minutesAgoEach * (i + 1) * 60000) });
  }
}

test('an unused account may send', async () => {
  rows = [];
  const res = await canSendMessageService(1);
  assert.equal(res.allowed, true);
});

test('one under the hourly cap is still allowed', async () => {
  rows = [];
  seed(1, MAX_PER_HOUR - 1, 1);
  assert.equal((await canSendMessageService(1)).allowed, true);
});

test('exactly at the hourly cap is refused', async () => {
  rows = [];
  seed(1, MAX_PER_HOUR, 1);
  const res = await canSendMessageService(1);
  assert.equal(res.allowed, false);
  assert.equal(res.reason, 'hourly_cap');
  // The UI tells the user when to come back, so this has to be present.
  assert.ok(res.retryAfterSeconds > 0);
});

test('the hourly window rolls — older messages stop counting', async () => {
  rows = [];
  // Spaced two hours apart, so none fall inside the trailing hour.
  seed(1, MAX_PER_HOUR, 120);
  assert.equal((await canSendMessageService(1)).allowed, true);
});

test('the daily cap catches slow abuse the hourly cap never sees', async () => {
  rows = [];
  // Spread across the day: never more than a couple in any one hour, but well
  // past the daily allowance.
  seed(1, MAX_PER_DAY, 20);
  const res = await canSendMessageService(1);
  assert.equal(res.allowed, false);
  assert.equal(res.reason, 'daily_cap');
});

test('limits are per user, not global', async () => {
  rows = [];
  seed(1, MAX_PER_HOUR, 1);
  assert.equal((await canSendMessageService(1)).allowed, false);
  assert.equal((await canSendMessageService(2)).allowed, true);
});

test('recording a send counts toward the window', async () => {
  rows = [];
  for (let i = 0; i < MAX_PER_HOUR; i++) await recordMessageSentService(7);
  assert.equal((await canSendMessageService(7)).allowed, false);
});
