import test from 'node:test';
import assert from 'node:assert/strict';
import { loggingDayMiddleware } from '../utils/loggingDayContext.js';
import { isoDayIST, istDateString } from '../utils/sessionDay.js';

test('default customer day starts at exactly 4 AM IST', () => {
  assert.equal(isoDayIST(new Date('2026-10-31T22:29:59Z')), '2026-10-31');
  assert.equal(isoDayIST(new Date('2026-10-31T22:30:00Z')), '2026-11-01');
  assert.equal(istDateString(new Date('2026-10-31T20:00:00Z')), '2026-11-01');
});
test('concurrent customer settings remain isolated', async () => {
  await Promise.all([0, 4, 6, 8].map(hour => new Promise((resolve, reject) => {
    loggingDayMiddleware({ get: () => String(hour) }, {}, async () => {
      try {
        await new Promise(r => setTimeout(r, 10));
        assert.equal(isoDayIST(new Date('2026-11-09T23:00:00Z')), hour <= 4 ? '2026-11-10' : '2026-11-09');
        resolve();
      } catch (error) { reject(error); }
    });
  })));
});
