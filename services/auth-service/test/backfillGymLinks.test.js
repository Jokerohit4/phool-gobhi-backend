// Backfill (coach-journey B2). Pre-B2 accounts carry User.linkedGymId with no
// GymLink row; the backfill reconstructs the missing row so those members stay
// on their gym's roster and bill. The important properties are: it only touches
// gym-linked users, it never double-links, and --dry-run is a true no-op.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { backfillGymLinks } from '../scripts/backfillGymLinks.js';

function createFakePrisma({ users = [], gymLinks = [] } = {}) {
  const state = { gymLinks: gymLinks.map((l) => ({ ...l })) };
  let nextId = state.gymLinks.reduce((m, l) => Math.max(m, l.id || 0), 0) + 1;
  return {
    state,
    prisma: {
      user: {
        async findMany({ where }) {
          // The script only ever asks for linkedGymId: { not: null }.
          return users.filter((u) => (where?.linkedGymId?.not === null ? u.linkedGymId !== null : true))
            .map((u) => ({ id: u.id, linkedGymId: u.linkedGymId, createdAt: u.createdAt }));
        },
      },
      gymLink: {
        async findFirst({ where }) {
          const row = state.gymLinks.find((l) => l.userId === where.userId);
          return row ? { ...row } : null;
        },
        async create({ data }) {
          const row = { id: nextId++, removedAt: null, ...data };
          state.gymLinks.push(row);
          return { ...row };
        },
      },
    },
  };
}

const joined = (id, gymId, createdAt = new Date('2026-01-01T00:00:00Z')) => ({ id, linkedGymId: gymId, createdAt });

test('creates a gym_qr link dated at the account for every gym-linked user with none', async () => {
  const { prisma, state } = createFakePrisma({ users: [joined(1, 10), joined(2, 20)] });
  const result = await backfillGymLinks(prisma);
  assert.deepEqual(result, { scanned: 2, created: 2, skipped: 0 });
  assert.equal(state.gymLinks.length, 2);
  const link = state.gymLinks.find((l) => l.userId === 1);
  assert.equal(link.gymId, 10);
  assert.equal(link.source, 'gym_qr');
  assert.equal(link.linkedAt.toISOString(), '2026-01-01T00:00:00.000Z');
});

test('skips users that already have any GymLink row', async () => {
  const { prisma, state } = createFakePrisma({
    users: [joined(1, 10), joined(2, 20)],
    gymLinks: [{ id: 99, userId: 1, gymId: 10, source: 'gym_qr', linkedAt: new Date('2025-06-01T00:00:00Z') }],
  });
  const result = await backfillGymLinks(prisma);
  assert.deepEqual(result, { scanned: 2, created: 1, skipped: 1 });
  assert.equal(state.gymLinks.filter((l) => l.userId === 1).length, 1, 'the existing row is untouched');
  assert.equal(state.gymLinks.filter((l) => l.userId === 2).length, 1);
});

test('ignores accounts with no linkedGymId', async () => {
  const { prisma, state } = createFakePrisma({ users: [joined(1, 10), { id: 2, linkedGymId: null, createdAt: new Date() }] });
  const result = await backfillGymLinks(prisma);
  assert.deepEqual(result, { scanned: 1, created: 1, skipped: 0 });
  assert.equal(state.gymLinks[0].userId, 1);
});

test('--dry-run reports the work without writing', async () => {
  const { prisma, state } = createFakePrisma({ users: [joined(1, 10), joined(2, 20)] });
  const result = await backfillGymLinks(prisma, { dryRun: true });
  assert.deepEqual(result, { scanned: 2, created: 2, skipped: 0 });
  assert.equal(state.gymLinks.length, 0, 'nothing is written in a dry run');
});

test('a missing createdAt falls back to now', async () => {
  const before = Date.now();
  const { prisma, state } = createFakePrisma({ users: [{ id: 1, linkedGymId: 5, createdAt: null }] });
  await backfillGymLinks(prisma);
  const stamp = state.gymLinks[0].linkedAt.getTime();
  assert.ok(stamp >= before && stamp <= Date.now());
});

test('re-running is idempotent', async () => {
  const { prisma, state } = createFakePrisma({ users: [joined(1, 10), joined(2, 20)] });
  await backfillGymLinks(prisma);
  const second = await backfillGymLinks(prisma);
  assert.deepEqual(second, { scanned: 2, created: 0, skipped: 2 });
  assert.equal(state.gymLinks.length, 2, 'no duplicate rows appear');
});
