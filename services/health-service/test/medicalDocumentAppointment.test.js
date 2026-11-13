// A medical document can be linked to the doctor appointment it was scanned or
// uploaded for (MedicalDocument.appointmentId, optional, ON DELETE SET NULL).
// Pinned: the link is optional; it is only ever to one of the CALLER's own
// appointments (another account's id is a 404, never an attach); a bad link is
// rejected BEFORE any bytes are stored so nothing is orphaned; and the list can
// be narrowed to one appointment without changing the unfiltered list.
// Run with: node --experimental-test-module-mocks --test
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

let controller;
let appointmentLookups;
let created;
let listQueries;
let saved;
let appointmentOwner; // userId that owns appointment id 7

const href = (p) => new URL(p, import.meta.url).href;

before(async () => {
  mock.module('@prisma/client', {
    exports: {
      PrismaClient: class {
        constructor() {
          this.doctorAppointment = {
            findFirst: async (q) => {
              appointmentLookups.push(q);
              return q.where.id === 7 && q.where.userId === appointmentOwner ? { id: 7 } : null;
            },
          };
          this.medicalDocument = {
            create: async ({ data }) => {
              created.push(data);
              return { id: 1, createdAt: new Date('2026-11-01'), ...data };
            },
            findMany: async (q) => {
              listQueries.push(q);
              return [{ id: 1, storagePath: 'medical/1/x.pdf', title: 'Rx', appointmentId: q.where.appointmentId ?? null }];
            },
          };
        }
      },
    },
  });
  mock.module(href('../utils/analytics.js'), { exports: { track: () => {} } });
  mock.module(href('../services/ledger/nutritionService.js'), {
    exports: { saveMeal: async () => ({}), logSavedMeal: async () => ({}), listSavedMeals: async () => [], getDayTotals: async () => ({ kcal: 0 }) },
  });
  mock.module(href('../services/ledger/ledgerIntakeService.js'), {
    exports: { saveIntake: async () => ({}), getSetupState: async () => ({ missing: [] }) },
  });
  mock.module(href('../services/ledger/foodRequestService.js'), {
    exports: { requestFood: async () => ({}), listRequests: async () => [], listQueue: async () => [], resolveRequest: async () => ({}) },
  });
  // Storage is stubbed: the point is whether bytes are written at all.
  mock.module(href('../services/ledger/medicalDocumentStorage.js'), {
    exports: {
      MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
      isAllowedMimeType: () => true,
      isAllowedReportMimeType: () => true,
      saveDocument: async () => { saved.push('bytes'); return 'medical/1/new.pdf'; },
      savePlanNote: async () => 'medical/1/note.json',
      signedDocumentUrl: async () => 'https://signed.example/x',
      deleteObjects: async () => {},
      deleteUserObjects: async () => {},
    },
  });
  controller = await import('../controllers/ledgerController.js');
});

beforeEach(() => {
  appointmentLookups = []; created = []; listQueries = []; saved = []; appointmentOwner = 1;
});

const res = () => {
  const out = { statusCode: 200, body: undefined };
  return { out, status(c) { out.statusCode = c; return this; }, json(b) { out.body = b; return out; } };
};
const file = { buffer: Buffer.from('%PDF'), mimetype: 'application/pdf', size: 4 };
const upload = (body = {}, userId = 1) => ({ userId, body: { kind: 'prescription', title: 'Rx', ...body }, file, params: {}, query: {} });

test('no appointment: stored unlinked, and no appointment lookup is made', async () => {
  const r = res();
  await controller.uploadMedicalDocument(upload(), r);
  assert.equal(r.out.statusCode, 200);
  assert.equal(created[0].appointmentId, null);
  assert.equal(appointmentLookups.length, 0);
  assert.equal(saved.length, 1);
});

test('an empty-string appointmentId (multipart form field left blank) means "none"', async () => {
  const r = res();
  await controller.uploadMedicalDocument(upload({ appointmentId: '' }), r);
  assert.equal(r.out.statusCode, 200);
  assert.equal(created[0].appointmentId, null);
  assert.equal(appointmentLookups.length, 0);
});

test('linking to the caller\'s own appointment stores the link and returns it, without the storage path', async () => {
  const r = res();
  await controller.uploadMedicalDocument(upload({ appointmentId: '7' }), r);
  assert.equal(r.out.statusCode, 200);
  assert.deepEqual(appointmentLookups[0].where, { id: 7, userId: 1 }, 'the lookup is scoped to the caller');
  assert.equal(created[0].appointmentId, 7);
  assert.equal(r.out.body.data.appointmentId, 7);
  assert.equal('storagePath' in r.out.body.data, false, 'a path is a capability and never leaves the service');
});

test('another account\'s appointment is a 404, and NO bytes are stored', async () => {
  appointmentOwner = 99; // appointment 7 belongs to someone else
  const r = res();
  await controller.uploadMedicalDocument(upload({ appointmentId: '7' }, 1), r);
  assert.equal(r.out.statusCode, 404);
  assert.deepEqual(saved, [], 'nothing written to storage');
  assert.deepEqual(created, [], 'no row created');
});

test('a malformed appointmentId is a 400 before anything is looked up or stored', async () => {
  for (const bad of ['abc', '0', '-3', '1.5', '7x', 'NaN']) {
    appointmentLookups = []; saved = []; created = [];
    const r = res();
    await controller.uploadMedicalDocument(upload({ appointmentId: bad }), r);
    assert.equal(r.out.statusCode, 400, `appointmentId=${bad}`);
    assert.equal(appointmentLookups.length, 0, `no lookup for ${bad}`);
    assert.equal(saved.length, 0, `no bytes for ${bad}`);
    assert.equal(created.length, 0, `no row for ${bad}`);
  }
});

test('the list is unchanged without a filter', async () => {
  const r = res();
  await controller.listMedicalDocuments({ userId: 1, query: {}, body: {}, params: {} }, r);
  assert.deepEqual(listQueries[0].where, { userId: 1 });
  assert.equal('storagePath' in r.out.body.data[0], false);
});

test('?appointmentId= narrows the list to that appointment, still scoped to the caller', async () => {
  const r = res();
  await controller.listMedicalDocuments({ userId: 1, query: { appointmentId: '7' }, body: {}, params: {} }, r);
  assert.deepEqual(listQueries[0].where, { userId: 1, appointmentId: 7 });
  assert.equal(r.out.body.data[0].appointmentId, 7);
});

test('a blank ?appointmentId= is ignored; a malformed one is a 400', async () => {
  let r = res();
  await controller.listMedicalDocuments({ userId: 1, query: { appointmentId: '' }, body: {}, params: {} }, r);
  assert.deepEqual(listQueries[0].where, { userId: 1 });
  for (const bad of ['abc', '0', '-1', '2.5']) {
    r = res();
    await controller.listMedicalDocuments({ userId: 1, query: { appointmentId: bad }, body: {}, params: {} }, r);
    assert.equal(r.out.statusCode, 400, `appointmentId=${bad}`);
  }
});
