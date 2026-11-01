import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quitReasonBias } from '../utils/quitReasonBias.js';

test('time prefers short routines and avoids long ones', () => {
  assert.equal(quitReasonBias({ estMinutes: 20 }, 'time'), 4);
  assert.equal(quitReasonBias({ estMinutes: 45 }, 'time'), 0);
  assert.equal(quitReasonBias({ estMinutes: 75 }, 'time'), -3);
  assert.equal(quitReasonBias({}, 'time'), 0);
});

test('boredom penalises only recently done routines', () => {
  assert.equal(quitReasonBias({ estMinutes: 20 }, 'boredom', true), -4);
  assert.equal(quitReasonBias({ estMinutes: 20 }, 'boredom', false), 0);
});

test('other reasons, including injury, have no effect', () => {
  for (const r of ['injury', 'no_results', 'alone', null, undefined]) {
    assert.equal(quitReasonBias({ estMinutes: 20 }, r, true), 0, String(r));
  }
});
