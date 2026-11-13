import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validQueueDiagnostic } from '../utils/exploreQueueDiagnosticSchema.js';

const resolved = 'explore_pickup_queue_resolved';
const issue = 'explore_pickup_queue_issue';
const base = () => ({ measurement_version: 1, occurrence_kind: null,
  queue_age_bucket: 'unknown', queue_age_basis: 'unknown',
  failure_reason: 'none', upload_attempts_bucket: 'unknown', resolution: 'receipt_observed' });

test('resolved contract rejects additional, missing and wrongly typed fields', () => {
  assert.equal(validQueueDiagnostic(resolved, base()), true);
  for (const key of Object.keys(base())) {
    const p = base(); delete p[key];
    assert.equal(validQueueDiagnostic(resolved, p), false, key);
    assert.equal(validQueueDiagnostic(resolved, { ...base(), [key]: {} }), false, key);
  }
  for (const key of ['ip', 'user_agent', 'claim_id', 'proof', 'queue_age_ms', 'phase']) {
    assert.equal(validQueueDiagnostic(resolved, { ...base(), [key]: 'secret' }), false, key);
  }
  assert.equal(validQueueDiagnostic('unknown', base()), false);
});

test('age basis, resolution/failure and phase rules agree for the complete matrix', () => {
  for (const basis of ['monotonic', 'wall_estimate', 'unknown', 'not_queued']) {
    for (const age of ['under_10s', 'unknown']) {
      for (const failure of ['none', 'timeout']) {
        const ageValid = (age === 'unknown') === ['unknown', 'not_queued'].includes(basis);
        for (const resolution of ['receipt_observed', 'server_rejection_observed', 'client_terminal']) {
          assert.equal(validQueueDiagnostic(resolved, {
            ...base(), queue_age_basis: basis, queue_age_bucket: age, failure_reason: failure, resolution,
          }), ageValid && basis !== 'not_queued' && ((resolution === 'receipt_observed') === (failure === 'none')));
        }
        for (const phase of ['enqueue', 'pending']) {
          const p = { ...base(), queue_age_basis: basis, queue_age_bucket: age, failure_reason: failure, phase };
          delete p.resolution;
          assert.equal(validQueueDiagnostic(issue, p), ageValid && failure !== 'none' && ((phase === 'enqueue') === (basis === 'not_queued')));
        }
      }
    }
  }
});

test('all supported categories are accepted and arbitrary text/numbers are rejected', () => {
  for (const kind of [null, 'grid', 'gym', 'reviewed']) {
    for (const attempts of ['0', '1', '2_to_3', '4_to_7', '8_plus', 'unknown']) {
      assert.equal(validQueueDiagnostic(resolved, { ...base(), occurrence_kind: kind, upload_attempts_bucket: attempts }), true);
    }
  }
  for (const p of [null, [], 'text', { ...base(), occurrence_kind: 'address' },
    { ...base(), upload_attempts_bucket: 1 }, { ...base(), failure_reason: 'raw exception' }]) {
    assert.equal(validQueueDiagnostic(resolved, p), false);
  }
});
