// H-21 (docs/../sprint2/PG-HUNT-001). System templates (the 12 seeded
// no-equipment routines) are visible to every user, but two things about
// that must hold or the feature leaks data across users:
//
//   1. A user sees their OWN templates plus every system template — never
//      another user's private ones.
//   2. "Last done" on a shared system template must be scoped to the
//      CALLING user. Before templates could be shared, the missing userId
//      filter on this query was latent (every session against a template
//      already belonged to that template's own owner) — this is the fix
//      that keeps it correct now that a template can have many users.
//
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let templates = [];
let sessions = [];

function reset() {
  templates = [];
  sessions = [];
}

function seedUserTemplate(userId, name) {
  templates.push({ id: templates.length + 1, userId, isSystem: false, name, updatedAt: new Date(), exercises: [] });
}
function seedSystemTemplate(name) {
  templates.push({ id: templates.length + 1, userId: null, isSystem: true, name, updatedAt: new Date(), exercises: [] });
}
function seedSession(templateId, userId, startedAt) {
  sessions.push({ templateId, userId, startedAt });
}

let listTemplatesService;

test('setup: mock prisma once, import templateService once', async (t) => {
  t.mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.workoutTemplate = {
            findMany: async ({ where, orderBy }) => {
              let rows;
              if (where.userId !== undefined) rows = templates.filter((t) => t.userId === where.userId);
              else if (where.isSystem !== undefined) rows = templates.filter((t) => t.isSystem === where.isSystem);
              else rows = templates;
              if (orderBy?.name) rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
              if (orderBy?.updatedAt) rows = [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
              return rows;
            },
          };
          this.workoutSession = {
            findFirst: async ({ where }) => {
              const matches = sessions
                .filter((s) => s.templateId === where.templateId && s.userId === where.userId)
                .sort((a, b) => b.startedAt - a.startedAt);
              return matches[0] ? { startedAt: matches[0].startedAt } : null;
            },
          };
        }
      },
    },
  });

  ({ listTemplatesService } = await import('../services/templateService.js'));
});

test('a user sees their own templates plus every system template', async () => {
  reset();
  seedUserTemplate(1, 'My Push Day');
  seedUserTemplate(2, "Someone Else's Routine"); // must never appear for user 1
  seedSystemTemplate('Full body — no equipment');
  seedSystemTemplate('Core — 10 minute');

  const list = await listTemplatesService(1);
  const names = list.map((t) => t.name).sort();

  assert.deepEqual(names, ['Core — 10 minute', 'Full body — no equipment', 'My Push Day']);
});

test("lastDoneAt on a SHARED system template is scoped to the calling user, not global", async () => {
  reset();
  seedSystemTemplate('Full body — no equipment'); // id 1
  const older = new Date('2026-08-01T00:00:00Z');
  const newer = new Date('2026-09-01T00:00:00Z');
  // User 2 did this system template MORE RECENTLY than user 1 did.
  seedSession(1, 2, newer);
  seedSession(1, 1, older);

  const listForUser1 = await listTemplatesService(1);
  const listForUser2 = await listTemplatesService(2);

  assert.equal(listForUser1[0].lastDoneAt.getTime(), older.getTime());
  assert.equal(listForUser2[0].lastDoneAt.getTime(), newer.getTime());
});

test('a system template no user has ever logged has lastDoneAt: null', async () => {
  reset();
  seedSystemTemplate('Mobility & stretch');
  const list = await listTemplatesService(1);
  assert.equal(list[0].lastDoneAt, null);
});
