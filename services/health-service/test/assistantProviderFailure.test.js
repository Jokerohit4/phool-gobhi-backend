// How a provider failure is reported to the client. Run with:
//   node --experimental-test-module-mocks --test
//
// The distinction under test is operational, not cosmetic: running out of
// upstream quota is a billing decision, while a provider fault is an incident,
// and they used to be indistinguishable from outside. Both still return 503
// and both still mean the user's message was saved — only the code and the
// copy differ.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let describeProviderFailure, ProviderError;

test('setup: stub Prisma, import the service once', async (t) => {
  // assistantService and contextService both construct a PrismaClient at
  // module load; nothing here touches the DB, so an empty stub is enough.
  t.mock.module('@prisma/client', {
    exports: { PrismaClient: class {}, Prisma: {} },
  });
  ({ describeProviderFailure } = await import('../services/assistant/assistantService.js'));
  ({ ProviderError } = await import('../services/assistant/providers/index.js'));
});

test('a provider 429 is reported as capacity, not as an outage', () => {
  const err = new ProviderError('Assistant provider returned 429: rate limit', {
    status: 429,
    retryable: true,
  });
  const out = describeProviderFailure(err);

  assert.equal(out.code, 'ASSISTANT_CAPACITY');
  // Deliberately NOT 429 — that status is spoken for by the per-user cap, and
  // the client branches on it to show a "you asked a lot" message that would
  // be wrong and slightly insulting here.
  assert.equal(out.status, 503);
  assert.match(out.error, /capacity/i);
  assert.match(out.error, /saved/i);
});

test('a provider 500 is still an outage', () => {
  const err = new ProviderError('Assistant provider returned 500: boom', {
    status: 500,
    retryable: true,
  });
  const out = describeProviderFailure(err);

  assert.equal(out.code, 'ASSISTANT_UNAVAILABLE');
  assert.equal(out.status, 503);
  assert.match(out.error, /saved/i);
});

test('a timeout carries no status and is an outage', () => {
  // The network/timeout path throws with retryable:true but no status at all —
  // an undefined status must not be mistaken for a quota refusal.
  const err = new ProviderError('The operation was aborted due to timeout', {
    retryable: true,
  });
  assert.equal(describeProviderFailure(err).code, 'ASSISTANT_UNAVAILABLE');
});

test('a non-ProviderError is an outage rather than throwing', () => {
  // Anything unexpected escaping the provider still has to produce a reply the
  // client can render; this path must not itself explode.
  const out = describeProviderFailure(new TypeError('undefined is not a function'));
  assert.equal(out.code, 'ASSISTANT_UNAVAILABLE');
  assert.equal(out.status, 503);
});

test('a plain object shaped like a 429 is NOT treated as capacity', () => {
  // instanceof is the check, not duck typing: only the provider adapter knows
  // what a real upstream 429 is, and a stray {status:429} from elsewhere in
  // the stack must not silently claim "we are out of quota".
  const out = describeProviderFailure(Object.assign(new Error('nope'), { status: 429 }));
  assert.equal(out.code, 'ASSISTANT_UNAVAILABLE');
});

test('the cause is carried through for logs but the user copy never leaks it', () => {
  const err = new ProviderError('Assistant provider returned 429: org quota exceeded, key gsk_x', {
    status: 429,
  });
  const out = describeProviderFailure(err);

  assert.equal(out.cause, err.message);
  // The user-facing string is fixed copy — upstream bodies can quote request
  // ids, org names or key prefixes, and none of that belongs on screen.
  assert.ok(!out.error.includes('gsk_'));
  assert.ok(!out.error.includes('quota exceeded'));
});
