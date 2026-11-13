import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The provider is exercised through a stubbed `fetch` rather than a mocked
// module, because the two things most likely to be wrong here are the request
// body shape and the response parsing - and both live on either side of the
// network call. Mocking the transport away would leave both untested.

const REAL_FETCH = globalThis.fetch;

function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

beforeEach(() => {
  setEnv({
    FOOD_PHOTO_PROVIDER_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta',
    FOOD_PHOTO_PROVIDER_API_KEY: 'test-key',
    FOOD_PHOTO_PROVIDER_MODEL: 'gemini-2.0-flash',
  });
  globalThis.fetch = REAL_FETCH;
});

let loadCounter = 0;

async function loadProvider() {
  // A cache-busting query per load, because the provider reads its configuration
  // into module-scope constants at evaluation time and ESM caches modules for
  // the life of the process.
  //
  // A plain `await import(...)` in every test looks like it re-reads the
  // environment and does not: the second call returns the first module instance,
  // with the env as it was on the very first load. That made `isConfigured`
  // assertions depend on which test happened to run first, and the first one
  // asserted a state that every later one then inherited. The query string is
  // the only way to get a genuinely fresh evaluation.
  loadCounter += 1;
  return import(`../services/ledger/providers/geminiVisionProvider.js?load=${loadCounter}`);
}

function okResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function geminiText(text, extra = {}) {
  return okResponse({
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 40 },
    modelVersion: 'gemini-2.0-flash-001',
    ...extra,
  });
}

test('isConfigured needs all three, and reports a partial setup as not configured', async () => {
  assert.equal((await loadProvider()).isConfigured(), true);

  // Reloaded after every env change, because isConfigured reads constants
  // captured when the module was evaluated. Asserting against the previously
  // loaded instance would pass or fail on stale configuration and prove nothing.
  setEnv({ FOOD_PHOTO_PROVIDER_API_KEY: '' });
  assert.equal(
    (await loadProvider()).isConfigured(),
    false,
    'a flag on with no key is the state that must not 500',
  );

  setEnv({ FOOD_PHOTO_PROVIDER_API_KEY: '  ' });
  assert.equal(
    (await loadProvider()).isConfigured(),
    false,
    'a whitespace key is a pasted newline, not a key',
  );

  // An empty MODEL is not "unconfigured" and is not treated as one: it falls
  // back to the default model, which is the sensible reading of a blank value.
  // The API key is the part with no sensible default, and it is the one whose
  // absence must surface as 503 rather than a provider error.
  setEnv({ FOOD_PHOTO_PROVIDER_API_KEY: 'k', FOOD_PHOTO_PROVIDER_MODEL: '' });
  assert.equal((await loadProvider()).isConfigured(), true);
});

test('the request carries the image and no user data', async () => {
  const p = await loadProvider();
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return geminiText(JSON.stringify({ isFood: true, items: [] }));
  };

  await p.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' });

  assert.match(sent.url, /gemini-2\.0-flash:generateContent$/);
  // The whole point of the adapter: nothing identifying is in the request, so
  // there is nothing on the provider's side to correlate back to a person.
  const serialised = JSON.stringify(sent.body);
  assert.equal(/userId|localDate|slot|user_id/i.test(serialised), false);
  assert.equal(sent.body.contents[0].parts[0].inlineData.data, 'QUJD');
  assert.equal(sent.body.contents[0].parts[0].inlineData.mimeType, 'image/jpeg');
});

test('the response is schema-constrained, which is what keeps prose out of a Prisma write', async () => {
  const p = await loadProvider();
  let body = null;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return geminiText(JSON.stringify({ isFood: true, items: [] }));
  };

  await p.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' });

  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.temperature, 0, 'this is a lookup, not a conversation');
  assert.ok(body.generationConfig.responseSchema, 'a schema, not a request to be careful');
  // The escape hatch has to be in the schema, or a photo of a document comes
  // back with a confident food in it.
  assert.ok(body.generationConfig.responseSchema.properties.isFood);
});

test('a normal response comes back parsed, with token counts', async () => {
  const p = await loadProvider();
  globalThis.fetch = async () =>
    geminiText(
      JSON.stringify({
        isFood: true,
        items: [
          { name: 'dal', grams: 200, confidence: 0.82, nonVeg: false },
          { name: 'roti', grams: 60, confidence: 0.71, nonVeg: false },
        ],
        note: 'looks like a thali',
      }),
    );

  const out = await p.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' });

  assert.equal(out.isFood, true);
  assert.equal(out.items.length, 2);
  assert.deepEqual(out.items[0], {
    name: 'dal',
    grams: 200,
    confidence: 0.82,
    nonVeg: false,
    catalogue: '',
  });
  assert.equal(out.note, 'looks like a thali');
  assert.equal(out.tokensIn, 900, 'token counts are the cost ledger');
  assert.equal(out.tokensOut, 40);
  assert.equal(out.model, 'gemini-2.0-flash-001');
});

test('a fenced reply is still parsed, because a prompt edit must not become a 500', async () => {
  const p = await loadProvider();
  globalThis.fetch = async () =>
    geminiText('```json\n{"isFood":true,"items":[{"name":"dal","grams":100,"confidence":0.5}]}\n```');

  const out = await p.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' });
  assert.equal(out.items[0].name, 'dal');
});

test('a blocked candidate is a result, not an error', async () => {
  const p = await loadProvider();
  // No text at all, which is how a safety-blocked candidate arrives. A photo of
  // a person is not a plate, and that has to read as "nothing found" rather than
  // as a failure the app offers to retry.
  globalThis.fetch = async () =>
    okResponse({ candidates: [{ finishReason: 'SAFETY' }], modelVersion: 'gemini-2.0-flash-001' });

  const out = await p.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' });
  assert.equal(out.isFood, false);
  assert.deepEqual(out.items, []);
  assert.equal(out.blockedReason, 'SAFETY');
});

test('unusable items are dropped rather than reaching a catalogue search', async () => {
  const p = await loadProvider();
  globalThis.fetch = async () =>
    geminiText(
      JSON.stringify({
        isFood: true,
        items: [
          { name: '   ', grams: 100 },
          { name: 'dal', grams: -5, confidence: 47 },
          { name: 'roti', grams: 900000, confidence: 0.5 },
          { name: 'rice', grams: 'not a number', confidence: null },
        ],
      }),
    );

  const out = await p.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' });

  assert.equal(out.items.length, 3, 'the empty name is the only one dropped');
  // A negative or zero gram weight would be rejected downstream by logFood, and
  // a missing weight becomes a plain 100 g rather than a silent failure.
  assert.equal(out.items[0].grams, 100);
  // 5000 g is the same ceiling logFood enforces on a manual entry.
  assert.equal(out.items[1].grams, 5000);
  assert.equal(out.items[2].grams, 100);
  // Confidence is clamped into 0..1 rather than stored as 47.
  assert.equal(out.items[0].confidence, 1);
  assert.equal(out.items[2].confidence, null);
});

test('a 4xx is not retryable, a 5xx is', async () => {
  const p = await loadProvider();

  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => 'bad request' });
  await assert.rejects(
    () => p.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }),
    (err) => err.retryable === false && err.code === 'PROVIDER_REJECTED',
  );

  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => 'unavailable' });
  await assert.rejects(
    () => p.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }),
    (err) => err.retryable === true,
  );

  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => 'slow down' });
  await assert.rejects(
    () => p.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }),
    (err) => err.retryable === true,
  );
});

test("the provider's error body never reaches the message", async () => {
  const p = await loadProvider();
  // Gemini echoes the request in some error payloads, and the request is a
  // photograph. A message carrying that body ends up in a log line and, in a
  // 502, potentially in front of the user.
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ error: { details: 'inlineData contained <image bytes>' } }),
  });

  await assert.rejects(
    () => p.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }),
    (err) => {
      assert.equal(err.message.includes('image bytes'), false);
      assert.match(err.message, /returned 400/);
      return true;
    },
  );
});

test('a network failure is retryable and an unconfigured provider is not', async () => {
  const p = await loadProvider();

  globalThis.fetch = async () => {
    throw new Error('ECONNRESET');
  };
  await assert.rejects(
    () => p.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }),
    (err) => err.retryable === true && err.code === 'PROVIDER_UNREACHABLE',
  );

  setEnv({ FOOD_PHOTO_PROVIDER_API_KEY: '' });
  const bare = await loadProvider();
  await assert.rejects(
    () => bare.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }),
    (err) => err.retryable === false && err.code === 'PROVIDER_NOT_CONFIGURED',
  );
});

test('unparseable JSON is a provider shape error, not a crash', async () => {
  const p = await loadProvider();
  globalThis.fetch = async () => geminiText('I am sorry, I cannot help with that.');

  await assert.rejects(
    () => p.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }),
    (err) => err.code === 'PROVIDER_BAD_SHAPE',
  );
});
