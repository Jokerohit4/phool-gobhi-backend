import test from 'node:test';
import assert from 'node:assert/strict';
import { saveDoctorPlanNote } from '../services/ledger/doctorPlanNoteService.js';

function fixtures({ failWrite = false, failStorage = false } = {}) {
  const stored = [], rows = [], deleted = [];
  return { stored, rows, deleted,
    storage: {
      savePlanNote: async (arg) => {
        if (failStorage) throw new Error('storage unavailable');
        stored.push(arg); return 'medical/7/random.txt';
      },
      deleteObjects: async (paths) => { deleted.push(...paths); },
    },
    prisma: { medicalDocument: { create: async ({ data }) => {
      if (failWrite) throw new Error(`database unavailable: ${data.notes}`);
      rows.push(data); return { id: 18, ...data };
    } } },
  };
}

test('stores user instructions verbatim as an owned private record, not a target or task', async () => {
  const f = fixtures();
  const description = 'Follow the meal timings on my prescription.\nलौंग';
  const result = await saveDoctorPlanNote({ ...f, userId: 7, description });
  assert.equal(f.stored[0].buffer.toString('utf8'), description);
  assert.equal(f.stored[0].userId, 7);
  assert.equal(result.userId, 7);
  assert.equal(result.notes, description);
  assert.equal(result.mimeType, 'text/plain');
  assert.equal(result.sizeBytes, Buffer.byteLength(description));
  assert.equal(result.storagePath, undefined);
  assert.equal(f.rows.length, 1);
});

test('rejects absent, blank, non-string and oversized notes before storage', async () => {
  for (const description of [null, undefined, '', '  ', {}, 42, 'a'.repeat(4001)]) {
    const f = fixtures();
    await assert.rejects(saveDoctorPlanNote({ ...f, userId: 7, description }), { status: 400 });
    assert.equal(f.stored.length + f.rows.length, 0);
  }
});

test('accepts the 4000-character boundary and trims only surrounding whitespace', async () => {
  const f = fixtures();
  const result = await saveDoctorPlanNote({ ...f, userId: 7, description: 'a'.repeat(4000) });
  assert.equal(result.notes.length, 4000);
  const trimmed = await saveDoctorPlanNote({ ...f, userId: 7, description: '  Keep\nmy instructions  ' });
  assert.equal(trimmed.notes, 'Keep\nmy instructions');
});

test('cleans up the blob if the database write fails', async () => {
  const f = fixtures({ failWrite: true });
  await assert.rejects(saveDoctorPlanNote({ ...f, userId: 7, description: 'My instructions' }), error => {
    assert.equal(error.message.includes('My instructions'), false);
    assert.match(error.message, /Could not save your plan description/);
    return true;
  });
  assert.deepEqual(f.deleted, ['medical/7/random.txt']);
});

test('a storage failure never writes a document row', async () => {
  const f = fixtures({ failStorage: true });
  await assert.rejects(saveDoctorPlanNote({ ...f, userId: 7, description: 'My instructions' }), /storage unavailable/);
  assert.equal(f.rows.length, 0);
});


test('structured plans require confirmation and retire previous plans transactionally',async()=>{
  const f=fixtures();const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});const events=[];
  f.prisma.$executeRaw=async()=>events.push('lock');
  f.prisma.medicalDocument.updateMany=async({where})=>{assert.equal(where.userId,7);assert.equal(where.supersededAt,null);events.push('retire');};
  const create=f.prisma.medicalDocument.create;
  f.prisma.medicalDocument.create=async arg=>{events.push('create');return create(arg);};
  f.prisma.$transaction=async work=>{events.push('begin');const result=await work(f.prisma);events.push('commit');return result;};
  await assert.rejects(saveDoctorPlanNote({...f,userId:7,plan:{confirmed:false,startsOn:today,targets:{kcal:1900}}}),{status:400});
  assert.equal(f.stored.length,0);
  const result=await saveDoctorPlanNote({...f,userId:7,plan:{confirmed:true,startsOn:today,targets:{kcal:1900}}});
  assert.deepEqual(events,['begin','lock','retire','create','commit']);assert.deepEqual(result.structuredPlan.targets,{kcal:1900});
  assert.equal(result.structuredPlan.doctorName,'');assert.equal(result.notes,'');
});
