import test from 'node:test';
import assert from 'node:assert/strict';
import { riskNoticeFor } from '../utils/reportRiskNotice.js';

test('first AMBER or RED confirm notifies', () => {
  assert.equal(riskNoticeFor(undefined, 'AMBER').data.type, 'report_risk');
  assert.equal(riskNoticeFor(null, 'RED').data.type, 'report_risk');
});

test('moving up a bucket notifies', () => {
  assert.ok(riskNoticeFor('GREEN', 'AMBER'));
  assert.ok(riskNoticeFor('AMBER', 'RED'));
});

test('GREEN, the same bucket, or a lower one stays quiet', () => {
  assert.equal(riskNoticeFor(undefined, 'GREEN'), null);
  assert.equal(riskNoticeFor('AMBER', 'AMBER'), null);
  assert.equal(riskNoticeFor('RED', 'AMBER'), null);
  assert.equal(riskNoticeFor('RED', 'RED'), null);
  assert.equal(riskNoticeFor('AMBER', 'GREEN'), null);
  assert.equal(riskNoticeFor('AMBER', 'MYSTERY'), null);
});

test('the copy carries no test name, value or condition', () => {
  for (const bucket of ['AMBER', 'RED']) {
    const { title, body, data } = riskNoticeFor(null, bucket);
    const text = `${title} ${body} ${JSON.stringify(data)}`;
    assert.doesNotMatch(text, /hba1c|sgot|sgpt|liver|diabet|sugar|cholesterol|\d/i);
  }
});
