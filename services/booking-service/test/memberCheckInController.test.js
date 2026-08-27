// Controller-layer coverage for the two new HTTP handlers (memberCheckIn,
// getMemberAttendance) — thin wrappers around the service functions already
// covered in memberCheckIn.test.js, tested here with a fake req/res instead
// of a real Express app. Run with:
//   node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

let memberCheckInImpl = async () => { throw new Error('not configured'); };
let getMemberAttendanceImpl = async () => { throw new Error('not configured'); };

let memberCheckIn, getMemberAttendance;

test('setup: mock bookingService once, import the controller once', async (t) => {
  t.mock.module(new URL('../services/bookingService.js', import.meta.url).href, {
    exports: {
      memberCheckIn: (...args) => memberCheckInImpl(...args),
      getMemberAttendance: (...args) => getMemberAttendanceImpl(...args),
    },
  });
  ({ memberCheckIn, getMemberAttendance } = await import('../controllers/bookingController.js'));
  assert.equal(typeof memberCheckIn, 'function');
});

test('memberCheckIn controller: parses gymId, forwards lat/lng and userId, returns {data}', async () => {
  let receivedArgs = null;
  memberCheckInImpl = async (gymId, customerId, lat, lng) => {
    receivedArgs = { gymId, customerId, lat, lng };
    return { attendanceId: 1, alreadyCheckedIn: false };
  };
  const req = { params: { gymId: '9' }, body: { lat: 28.4, lng: 77.0 }, userId: 42 };
  const res = fakeRes();

  await memberCheckIn(req, res);

  assert.deepEqual(receivedArgs, { gymId: 9, customerId: 42, lat: 28.4, lng: 77.0 });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { data: { attendanceId: 1, alreadyCheckedIn: false } });
});

test('memberCheckIn controller: service error is mapped to status + error + code', async () => {
  memberCheckInImpl = async () => { throw { status: 403, error: 'This gym is not your linked gym', code: 'NOT_LINKED_GYM' }; };
  const req = { params: { gymId: '9' }, body: {}, userId: 42 };
  const res = fakeRes();

  await memberCheckIn(req, res);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'This gym is not your linked gym', code: 'NOT_LINKED_GYM' });
});

test('memberCheckIn controller: an error with no status defaults to 500', async () => {
  memberCheckInImpl = async () => { throw new Error('boom'); };
  const req = { params: { gymId: '9' }, body: {}, userId: 42 };
  const res = fakeRes();

  await memberCheckIn(req, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'boom');
});

test('getMemberAttendance controller: forwards userId, returns {data}', async () => {
  let receivedUserId = null;
  getMemberAttendanceImpl = async (customerId) => { receivedUserId = customerId; return [{ id: 1, gymId: 9 }]; };
  const req = { userId: 42 };
  const res = fakeRes();

  await getMemberAttendance(req, res);

  assert.equal(receivedUserId, 42);
  assert.deepEqual(res.body, { data: [{ id: 1, gymId: 9 }] });
});

test('getMemberAttendance controller: service error is mapped to status + error', async () => {
  getMemberAttendanceImpl = async () => { throw { status: 401, error: 'Unauthorized' }; };
  const req = { userId: 42 };
  const res = fakeRes();

  await getMemberAttendance(req, res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Unauthorized' });
});
