import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocialService, validateRecord, mediaKind } from '../services/socialService.js';
import { createFakePrisma } from './support/fakePrisma.js';

function fixture() {
  const profiles = new Map([1,2,3].map(id => [id, { id, userId: id,
    publicCode: String(id).repeat(12), isShareable: true, isActive: true,
    moderationHoldAt: null, dateOfBirth: new Date('1995-01-01'), gender: 'female',
    lat: 28.12, lng: 77.4, bio: 'I lift', isDiscoverable: false }]));
  const tables = { buddyProfile: profiles, buddyPhoto: new Map(), buddyFilter: new Map(),
    buddyPersonalRecord: new Map(), buddyFollow: new Map(), blockedUser: new Map(), report: new Map() };
  const prisma = createFakePrisma(tables);
  // The shared fake uses id keys; this model's primary key is the pair.
  const follow = tables.buddyFollow;
  prisma.buddyFollow.findUnique = async ({ where }) => {
    const key = where.followerId_targetId;
    return [...follow.values()].find(r => r.followerId === key.followerId && r.targetId === key.targetId) || null;
  };
  prisma.buddyFollow.upsert = async ({ create }) => { follow.set(`${create.followerId}-${create.targetId}`, create); return create; };
  const destroyed = [];
  const cloudinary = { uploader: { destroy: async (...args) => destroyed.push(args) } };
  const service = createSocialService({ prisma, cloudinary, getUserInternal: async id => ({ name: `Buddy ${id}`, phone: 'private' }) });
  return { service, tables, profiles, destroyed, cloudinary };
}

test('public preview omits location, DOB, contact and internal identifiers', async () => {
  const { service } = fixture();
  const dto = await service.view(null, '222222222222');
  assert.equal(dto.name, 'Buddy 2');
  for (const key of ['lat','lng','dateOfBirth','phone','userId','filter','moderationHoldAt']) assert.equal(key in dto, false, key);
});

test('codes and hidden link profiles cannot be looked up', async () => {
  const { service, profiles } = fixture();
  profiles.get(2).isShareable = false;
  await assert.rejects(service.view(1, '222222222222'), e => e.status === 404);
  await assert.rejects(service.view(1, '2'), e => e.status === 404);
  assert.equal((await service.me(2)).isShareable, false);
});

test('sharing consent is separate from discovery and cannot edit moderation state', async () => {
  const { service, tables, profiles } = fixture();
  for (let id = 1; id <= 3; id++) tables.buddyPhoto.set(id, { id, buddyProfileId: 1, url: 'photo', order: id });
  await service.settings(1, { isShareable: true, isActive: false });
  assert.equal(profiles.get(1).isDiscoverable, false);
  assert.equal(profiles.get(1).isActive, true);
  await assert.rejects(service.settings(2, { isShareable: true }), e => e.status === 400);
  await assert.rejects(service.settings(1, { isShareable: 'true' }), e => e.status === 400);
});

test('a block or report in either direction prevents authenticated lookup and follows', async () => {
  for (const reverse of [false, true]) {
    const { service, tables } = fixture();
    tables.blockedUser.set('pair', { blockerId: reverse ? 2 : 1, blockedId: reverse ? 1 : 2 });
    await assert.rejects(service.view(1, '222222222222'), e => e.status === 404);
    await assert.rejects(service.follow(1, '222222222222', true), e => e.status === 404);
    tables.blockedUser.clear();
    tables.report.set(1, { reporterId: reverse ? 2 : 1, reportedUserId: reverse ? 1 : 2 });
    await assert.rejects(service.view(1, '222222222222'), e => e.status === 404);
  }
});

test('suspended, held and underage profiles cannot share or follow', async () => {
  for (const patch of [{ isActive: false }, { moderationHoldAt: new Date() }, { dateOfBirth: new Date('2015-01-01') }]) {
    const { service, profiles } = fixture();
    Object.assign(profiles.get(2), patch);
    await assert.rejects(service.view(null, '222222222222'), e => e.status === 403);
    await assert.rejects(service.follow(2, '111111111111', true), e => e.status === 403);
  }
});

test('women-only profiles require an eligible authenticated viewer', async () => {
  const { service, tables, profiles } = fixture();
  tables.buddyFilter.set(1, { id: 1, userId: 2, womenOnly: true });
  await assert.rejects(service.view(null, '222222222222'), e => e.status === 404);
  profiles.get(1).gender = 'male';
  await assert.rejects(service.view(1, '222222222222'), e => e.status === 404);
  profiles.get(1).gender = 'female';
  assert.equal((await service.view(1, '222222222222')).name, 'Buddy 2');
});

test('following is idempotent and cannot create a self follow', async () => {
  const { service, tables } = fixture();
  await service.follow(1, '222222222222', true);
  await service.follow(1, '222222222222', true);
  assert.equal(tables.buddyFollow.size, 1);
  assert.equal((await service.view(1, '222222222222')).isFollowing, true);
  await assert.rejects(service.follow(1, '111111111111', true), e => e.status === 400);
});

test('records are optional and validate finite weight, integer reps and units', async () => {
  const { service } = fixture();
  assert.deepEqual((await service.me(1)).records, []);
  const body = { exerciseId: '3', exerciseName: 'Squat', weight: '100.5', unit: 'kg', reps: '5' };
  assert.equal(validateRecord(body).weight, 100.5);
  for (const patch of [{ weight: 'NaN' }, { weight: 'Infinity' }, { weight: 0 }, { weight: -1 }, { reps: 1.5 }, { reps: 0 }, { unit: 'oz' }, { exerciseId: 0 }])
    assert.throws(() => validateRecord({ ...body, ...patch }), e => e.status === 400);
  const record = await service.addRecord(1, body);
  assert.equal(record.reps, 5);
  await assert.rejects(service.deleteRecord(2, record.id), e => e.status === 404);
  await service.deleteRecord(1, record.id);
  assert.equal((await service.me(1)).records.length, 0);
});

test('PR cap rejects the 31st record', async () => {
  const { service, tables } = fixture();
  for (let id = 1; id <= 30; id++) tables.buddyPersonalRecord.set(id, { id, buddyProfileId: 1 });
  await assert.rejects(service.addRecord(1, { exerciseId: 1, exerciseName: 'Squat', weight: 1, unit: 'kg', reps: 1 }), e => e.status === 400);
});

test('attachments are identified from file bytes rather than the client MIME type', () => {
  assert.equal(mediaKind(Buffer.from([255,216,255,0])), 'image');
  assert.equal(mediaKind(Buffer.from('0000ftypisom')), 'video');
  assert.throws(() => mediaKind(Buffer.from('<script>bad</script>')), e => e.status === 400);
});

test('video attachments persist their media type and overlong uploads are cleaned up', async () => {
  const { service, cloudinary, destroyed, tables } = fixture();
  let duration = 30;
  cloudinary.uploader.upload_stream = (options, callback) => ({
    end() { callback(null, { duration, public_id: 'video1', secure_url: 'https://media/video.mp4' }); },
  });
  const body = { exerciseId: 1, exerciseName: 'Squat', weight: 100, unit: 'kg', reps: 5 };
  const record = await service.addRecord(1, body, { buffer: Buffer.from('0000ftypisom') });
  assert.equal(record.mediaType, 'video');
  assert.equal(record.mediaUrl, 'https://media/video.mp4');
  duration = 61;
  await assert.rejects(service.addRecord(1, body, { buffer: Buffer.from('0000ftypisom') }), e => e.status === 400);
  assert.equal(tables.buddyPersonalRecord.size, 1);
  assert.deepEqual(destroyed, [['video1', { resource_type: 'video' }]]);
});

test('deleting a PR removes its attachment before its database row', async () => {
  const { service, tables, destroyed } = fixture();
  tables.buddyPersonalRecord.set(1, { id: 1, buddyProfileId: 1, mediaPublicId: 'photo1', mediaType: 'image' });
  await service.deleteRecord(1, 1);
  assert.deepEqual(destroyed, [['photo1', { resource_type: 'image' }]]);
  assert.equal(tables.buddyPersonalRecord.size, 0);
});
