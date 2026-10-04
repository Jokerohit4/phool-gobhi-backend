import { test } from 'node:test';
import assert from 'node:assert/strict';

// `config.features` is a blind write target: whatever object arrives is stored
// verbatim, and every consumer then resolves a missing or misspelled key to the
// registry default. That makes an unvalidated write the quietest possible
// failure - the portal shows a toggle, the write returns 200, the flag is stored,
// and no gate anywhere reads it. validateFeaturePayload is the only thing
// between that and production, so it is worth pinning directly.
//
// These tests import config/featureFlagRegistry.js rather than the controller,
// deliberately: importing the controller pulls in Prisma and every service
// module, which needs a DATABASE_URL this check has no business requiring.
// authControllerExports.test.js states the same rule for the same reason.

import {
  FEATURE_FLAGS,
  FEATURES_SINGLETON_KEYS,
  defaultFeatures,
  flagNames,
  diffChangedFlags,
  validateFeaturePayload,
} from '../config/featureFlagRegistry.js';

test('accepts every registry flag at its default value', () => {
  const result = validateFeaturePayload(defaultFeatures());
  assert.deepEqual(result, { unknown: [], malformed: [] });
});

test('rejects a flag name that is not in the registry', () => {
  // The `runTracker` case from the registry header: it shipped server-side,
  // appeared in no list, and so resolved false forever with no way to switch it
  // on. A misspelling fails the same way - stored, unread, silently inert.
  const result = validateFeaturePayload({ workOutTracking: { enabled: true } });
  assert.deepEqual(result.unknown, ['workOutTracking']);
  assert.deepEqual(result.malformed, []);
});

test('reports every unknown key, not just the first', () => {
  const result = validateFeaturePayload({
    nope: { enabled: true },
  });
  assert.deepEqual(result.unknown, ['nope']);
});

test('rejects malformed flag values', () => {
  // `!!` coercion makes a JSON string "false" read as TRUE, i.e. a flag that
  // looks off in the portal and is on at the gate. Every one of these would
  // coerce to something, just not to what the operator meant.
  for (const bad of [null, 'true', 1, [], [{ enabled: true }]]) {
    const result = validateFeaturePayload({ badges: bad });
    assert.deepEqual(
      result.malformed,
      ['badges'],
      `${JSON.stringify(bad)} should be malformed`
    );
  }
});

test('rejects a non-boolean enabled', () => {
  for (const bad of ['false', 'true', 0, 1, null, {}, []]) {
    const result = validateFeaturePayload({ badges: { enabled: bad } });
    assert.deepEqual(result.malformed, ['badges'], `enabled: ${JSON.stringify(bad)}`);
  }
});

test('accepts a flag object with no enabled key at all', () => {
  // Shape-only tolerance: `{}` coerces to false everywhere it is read, so it is
  // equivalent to an explicit off rather than a contradiction.
  const result = validateFeaturePayload({ badges: {} });
  assert.deepEqual(result, { unknown: [], malformed: [] });
});

test('allows the two singleton settings, which are not flags', () => {
  // otp and profileCompletionBonus are served from their own rows and injected
  // into the public response, so the portal round-trips them inside `features`.
  // They are {provider} / {amount} objects, never {enabled} gates.
  for (const key of FEATURES_SINGLETON_KEYS) {
    const value = key === 'otp' ? { provider: 'fast2sms' } : { amount: 20 };
    const result = validateFeaturePayload({ [key]: value });
    assert.deepEqual(result, { unknown: [], malformed: [] }, key);
  }
});

test('an empty payload is valid', () => {
  assert.deepEqual(validateFeaturePayload({}), { unknown: [], malformed: [] });
});

test('unknown and malformed are reported independently', () => {
  // A caller rejecting on `unknown` alone would still persist a malformed value.
  const result = validateFeaturePayload({
    notAFlag: { enabled: true },
    badges: { enabled: 'yes' },
  });
  assert.deepEqual(result.unknown, ['notAFlag']);
  assert.deepEqual(result.malformed, ['badges']);
});

test('diffChangedFlags reports only flags whose enabled value moved', () => {
  // The portal PUTs the whole blob on every save, including saves that only
  // touched version numbers or maintenance windows, so this is what decides
  // whether a save is worth an audit row at all.
  assert.deepEqual(
    diffChangedFlags({ badges: { enabled: false }, buddy: { enabled: true } }, {
      badges: { enabled: true },
      buddy: { enabled: true },
    }),
    ['badges']
  );
});

test('diffChangedFlags ignores shape-only changes and key order', () => {
  // `{}` -> `{enabled: false}` is not a change worth recording, and neither is
  // the same set of flags in a different order.
  assert.deepEqual(diffChangedFlags({ badges: {} }, { badges: { enabled: false } }), []);
  assert.deepEqual(
    diffChangedFlags(
      { badges: { enabled: true }, buddy: { enabled: false } },
      { buddy: { enabled: false }, badges: { enabled: true } }
    ),
    []
  );
});

test('diffChangedFlags sees a flag appearing or disappearing', () => {
  assert.deepEqual(diffChangedFlags({}, { badges: { enabled: true } }), ['badges']);
  assert.deepEqual(diffChangedFlags({ badges: { enabled: true } }, {}), ['badges']);
  assert.deepEqual(diffChangedFlags(undefined, undefined), []);
});

test('the validator accepts every flag the registry declares', () => {
  // If this ever fails, the registry and its own validator have drifted - which
  // would mean the admin portal could not save the full flag set at all.
  assert.equal(flagNames().length, FEATURE_FLAGS.length);
  const allOn = Object.fromEntries(flagNames().map((n) => [n, { enabled: true }]));
  assert.deepEqual(validateFeaturePayload(allOn), { unknown: [], malformed: [] });
});
