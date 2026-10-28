// The attendance-SaaS monthly bill (authService.countGymJoinedUsersByMonthService)
// counts people joining a gym, not GymLink rows. Persona switching makes
// leave/rejoin cheap, so a member who leaves and comes back must not bill the
// gym twice. Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let links = [];

function inRange(value, cond) {
  if (!cond) return true;
  if (cond.gte && !(value >= cond.gte)) return false;
  if (cond.lt && !(value < cond.lt)) return false;
  if (cond.not === null && value == null) return false;
  return true;
}
function matches(where, row) {
  if (where.gymId?.in && !where.gymId.in.includes(row.gymId)) return false;
  if (where.userId?.in && !where.userId.in.includes(row.userId)) return false;
  if (where.linkedAt && !inRange(row.linkedAt, where.linkedAt)) return false;
  if (where.OR) {
    return where.OR.some((c) => c.source === row.source && inRange(row.linkedAt, c.linkedAt)
      && (c.firstVerifiedCheckinAt === undefined || row.firstVerifiedCheckinAt != null));
  }
  return true;
}

let countGymJoinedUsersByMonthService;

test('setup: mock prisma, import authService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.gymLink = { findMany: async ({ where }) => links.filter((l) => matches(where, l)).map((l) => ({ ...l })) };
        }
      },
      Prisma: {},
    },
  });
  ({ countGymJoinedUsersByMonthService } = await import('../services/authService.js'));
});

const qr = (userId, linkedAt, extra = {}) => ({ userId, gymId: 7, source: 'gym_qr', linkedAt: new Date(linkedAt), firstVerifiedCheckinAt: null, removedAt: null, ...extra });

test('one new member is one join', async () => {
  links = [qr(1, '2026-10-05T06:00:00Z')];
  assert.deepEqual(await countGymJoinedUsersByMonthService([7], '2026-10'), { 7: 1 });
});

test('leaving and rejoining in the same month bills once', async () => {
  links = [
    qr(1, '2026-10-05T06:00:00Z', { removedAt: new Date('2026-10-10T06:00:00Z') }),
    qr(1, '2026-10-20T06:00:00Z'),
  ];
  assert.deepEqual(await countGymJoinedUsersByMonthService([7], '2026-10'), { 7: 1 });
});

test('rejoining early next month after leaving is not a new join', async () => {
  links = [
    qr(1, '2026-10-20T06:00:00Z', { removedAt: new Date('2026-10-28T06:00:00Z') }),
    qr(1, '2026-11-03T06:00:00Z'),
  ];
  assert.deepEqual(await countGymJoinedUsersByMonthService([7], '2026-11'), {});
});

test('coming back months later is a new join', async () => {
  links = [
    qr(1, '2026-06-01T06:00:00Z', { removedAt: new Date('2026-07-01T06:00:00Z') }),
    qr(1, '2026-11-03T06:00:00Z'),
  ];
  assert.deepEqual(await countGymJoinedUsersByMonthService([7], '2026-11'), { 7: 1 });
});

test('two different people are two joins', async () => {
  links = [qr(1, '2026-10-05T06:00:00Z'), qr(2, '2026-10-06T06:00:00Z')];
  assert.deepEqual(await countGymJoinedUsersByMonthService([7], '2026-10'), { 7: 2 });
});
