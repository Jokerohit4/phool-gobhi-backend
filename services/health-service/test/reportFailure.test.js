import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, estimatePdfPages, isPageLimitError, isStalledReport, STALL_MS } from '../utils/reportFailure.js';

const http = (status, message = '') => Object.assign(new Error('Request failed'), { response: { status, data: { error: { message } } } });

test('a failure is told apart by what the person should do next', () => {
  assert.equal(classifyFailure(new Error('OCR_CONFIG_MISSING')), 'UNAVAILABLE');
  assert.equal(classifyFailure(http(400, 'Document pages exceed the limit: 15 got 22')), 'TOO_LONG');
  assert.equal(classifyFailure(http(400, 'The document is password protected')), 'PASSWORD');
  assert.equal(classifyFailure(http(400, 'Invalid document')), 'UNREADABLE');
  assert.equal(classifyFailure(http(429)), 'BUSY');
  assert.equal(classifyFailure(http(503)), 'BUSY');
  assert.equal(classifyFailure(Object.assign(new Error('timeout of 90000ms exceeded'), { code: 'ECONNABORTED' })), 'BUSY');
  assert.equal(classifyFailure(new Error('something else')), 'READ_FAILED');
  assert.equal(classifyFailure(undefined), 'READ_FAILED');
});

test('only a page-count refusal triggers the windowed read', () => {
  assert.equal(isPageLimitError(http(400, 'Maximum 15 pages allowed')), true);
  assert.equal(isPageLimitError(http(400, 'Invalid document')), false);
  assert.equal(isPageLimitError(http(500, 'page limit')), false);
});

test('page counts are a lower bound read from visible page objects, else unknown', () => {
  const pdf = n => Buffer.from(`%PDF-1.4\n<< /Type /Pages /Count ${n} >>\n${'<< /Type /Page >>\n'.repeat(n)}`);
  assert.equal(estimatePdfPages(pdf(3)), 3);
  assert.equal(estimatePdfPages(Buffer.from('%PDF-1.5 compressed object streams only')), null);
  assert.equal(estimatePdfPages(Buffer.alloc(0)), null);
});

test('a report is stalled only when it has been in flight longer than a read can take', () => {
  const now = Date.now();
  const old = new Date(now - STALL_MS - 1000);
  const fresh = new Date(now - 1000);
  assert.equal(isStalledReport({ status: 'PROCESSING', processingStartedAt: old }, now), true);
  assert.equal(isStalledReport({ status: 'PROCESSING', processingStartedAt: fresh }, now), false);
  assert.equal(isStalledReport({ status: 'PENDING', updatedAt: old }, now), true);
  assert.equal(isStalledReport({ status: 'COMPLETED', updatedAt: old }, now), false);
  assert.equal(isStalledReport({ status: 'FAILED', updatedAt: old }, now), false);
  assert.equal(isStalledReport(null, now), false);
});
