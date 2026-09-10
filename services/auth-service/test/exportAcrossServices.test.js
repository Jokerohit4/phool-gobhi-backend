// The platform-wide DPDPA access right. Its failure policy is deliberately
// the OPPOSITE of erasure's, and that inversion is the thing most likely to
// be "fixed" by someone who read only one of the two files:
//
//   erasure   — refuse on any downstream failure. A half-erasure leaves
//               personal data alive with no account left to retry from.
//   export    — return what we have, and name what is missing. Nothing is
//               destroyed, so a partial answer genuinely serves the person
//               better than an error page telling them nothing at all.
//
// The other property under test is coverage: the export must reach services
// the erasure deliberately skips (booking, wallet, gym). Data we refuse to
// delete for statutory reasons is data a person is most entitled to see.
// Run with: node --experimental-test-module-mocks --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

let getCalls = [];
let behaviour = () => ({ ok: true, status: 200, json: async () => ({ data: { rows: [] } }) });

let exportUserAcrossServices;

// Module-scope stub, not a per-test t.after() restore — a per-test restore
// puts the real fetch back before the next test runs, which turns a later
// test into a real network call. See eraseAcrossServices.test.js's header.
globalThis.fetch = async (url, opts) => {
  getCalls.push({ url: String(url), method: opts?.method ?? 'GET' });
  return behaviour(String(url));
};

test('setup: import the unit once', async (t) => {
  t.mock.module(new URL('../utils/googleIdToken.js', import.meta.url).href, {
    exports: { googleIdTokenHeader: async () => ({}) },
  });

  ({ exportUserAcrossServices } = await import('../utils/exportAcrossServices.js'));
  assert.equal(typeof exportUserAcrossServices, 'function');
});

test('the export reaches every service holding personal data, including the ones erasure skips', async () => {
  getCalls = [];
  behaviour = () => ({ ok: true, status: 200, json: async () => ({ data: { ok: true } }) });

  const { sections, failures } = await exportUserAcrossServices(42);

  assert.equal(failures.length, 0);
  const called = getCalls.map((c) => c.url).join(' ');
  for (const service of ['buddy-service', 'challenge-service', 'health-service']) {
    assert.ok(called.includes(service), `${service} is erased, so it must also be exportable`);
  }
  for (const service of ['booking-service', 'wallet-service', 'gym-service']) {
    assert.ok(
      called.includes(service),
      `${service} is deliberately NOT erased (statutory retention / public content), which is exactly why it must be exported`,
    );
  }

  // Every section key present, so the document shape does not depend on which
  // services happened to answer.
  for (const key of ['gymBuddy', 'rewardsAndChallenges', 'healthAndTraining', 'bookings', 'walletAndPayments', 'reviewsYouWrote']) {
    assert.ok(key in sections, `missing section ${key}`);
  }
});

test('it reads, never writes', async () => {
  getCalls = [];
  await exportUserAcrossServices(42);
  for (const call of getCalls) {
    assert.equal(call.method, 'GET', 'an access request must not mutate anything');
  }
});

test('the user id is scoped into every request path', async () => {
  getCalls = [];
  await exportUserAcrossServices(7);
  for (const call of getCalls) {
    assert.match(call.url, /\/internal\/export\/7$/);
  }
});

test('one failing service does NOT sink the whole export', async () => {
  getCalls = [];
  behaviour = (url) => (url.includes('wallet-service')
    ? { ok: false, status: 503, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => ({ data: { ok: true } }) });

  const { sections, failures } = await exportUserAcrossServices(42);

  assert.equal(failures.length, 1);
  assert.equal(failures[0].service, 'wallet-service');

  // The five that answered are still returned in full...
  assert.deepEqual(sections.bookings, { ok: true });
  assert.deepEqual(sections.gymBuddy, { ok: true });

  // ...and the one that didn't is marked, not silently absent. A missing key
  // would read as "we hold nothing about you here", which is a different and
  // false statement.
  assert.equal(sections.walletAndPayments.unavailable, true);
  assert.match(sections.walletAndPayments.note, /could not be retrieved/);
  assert.match(sections.walletAndPayments.note, /Nothing has been deleted/);
});

test('a thrown network error is handled the same way as a bad status', async () => {
  getCalls = [];
  behaviour = (url) => {
    if (url.includes('health-service')) throw new Error('ECONNREFUSED');
    return { ok: true, status: 200, json: async () => ({ data: { ok: true } }) };
  };

  const { sections, failures } = await exportUserAcrossServices(42);

  assert.equal(failures.length, 1);
  assert.equal(failures[0].service, 'health-service');
  assert.equal(failures[0].error, 'ECONNREFUSED');
  assert.equal(sections.healthAndTraining.unavailable, true);
});

test('every service failing still returns a document rather than throwing', async () => {
  getCalls = [];
  behaviour = () => ({ ok: false, status: 500, json: async () => ({}) });

  // Erasure would refuse outright here. Export must not: the caller still has
  // an account, and an exception would leave them with nothing to look at and
  // no explanation.
  const { sections, failures } = await exportUserAcrossServices(42);

  assert.equal(failures.length, 6);
  assert.equal(Object.keys(sections).length, 6);
  for (const section of Object.values(sections)) assert.equal(section.unavailable, true);
});

test('a malformed body is treated as an empty section, not a crash', async () => {
  getCalls = [];
  behaviour = () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } });

  const { sections, failures } = await exportUserAcrossServices(42);

  assert.equal(failures.length, 0, 'a 200 with an unreadable body is not a transport failure');
  assert.deepEqual(sections.bookings, {});
});
