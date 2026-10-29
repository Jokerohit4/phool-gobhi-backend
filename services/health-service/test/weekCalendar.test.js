import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoDayIST, weekStartOf, weekDays, startOfIsoWeek } from '../utils/sessionDay.js';
import { startOfIsoWeek as challengeWeek } from '../../challenge-service/utils/isoWeek.js';
for (const instant of ['2026-10-25T18:29:59Z','2026-10-25T18:30:00Z','2026-12-31T20:00:00Z','2024-02-29T00:00:00Z']) {
  test(`week parity at ${instant}`, () => {
    const monday = weekStartOf(isoDayIST(instant));
    assert.equal(monday, challengeWeek(instant).toISOString().slice(0,10));
    assert.equal(monday, startOfIsoWeek(instant).toISOString().slice(0,10));
    const days = weekDays(monday);
    assert.equal(days.length, 7);
    assert.equal(days[0], monday);
    assert.ok(days.includes(isoDayIST(instant)));
    assert.equal(new Set(days).size, 7);
  });
}
