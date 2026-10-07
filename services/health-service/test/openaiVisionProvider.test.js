import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Same reasoning as geminiVisionProvider.test.js: the two things most likely
// to be wrong here are the request body shape and the response parsing, and
// both live on either side of the network call — so fetch is stubbed, not
// mocked away. The config arrives as an argument (there is no environment
// fallback on this adapter, by design), which means no env, no cache-busting.

const REAL_FETCH = globalThis.fetch;

const CONFIG = {
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: 'test-key',
  model: 'qwen/qwen3.8-27b',
};

beforeEach(() => {
  globalThis.fetch = REAL_FETCH;
});

const provider = await import('../services/ledger/providers/openaiVisionProvider.js');

function okResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function openaiText(content, extra = {}) {
  return okResponse({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2049, completion_tokens: 60 },
    model: 'qwen/qwen3.8-27b-served',
    ...extra,
  });
}

test('isConfigured needs all three fields and no whitespace stand-ins', () => {
  assert.equal(provider.isConfigured(CONFIG), true);
  assert.equal(provider.isConfigured({ ...CONFIG, apiKey: '' }), false);
  assert.equal(provider.isConfigured({ ...CONFIG, apiKey: '  ' }), false, 'a pasted newline is not a key');
  assert.equal(provider.isConfigured({ ...CONFIG, baseUrl: '' }), false);
  assert.equal(provider.isConfigured({ ...CONFIG, model: '' }), false);
  assert.equal(provider.isConfigured({}), false, 'no environment fallback: unconfigured means unconfigured');
});

test('the request carries the image, the JSON instruction, and no user data', async () => {
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return openaiText(JSON.stringify({ isFood: true, items: [] }));
  };

  await provider.recognizeFood(
    { imageBase64: 'QUJD', mimeType: 'image/jpeg' },
    CONFIG,
  );

  assert.equal(sent.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(sent.init.headers.Authorization, 'Bearer test-key');
  // The whole point of the adapter: nothing identifying is in the request, so
  // there is nothing on the provider's side to correlate back to a person.
  const serialised = JSON.stringify(sent.body);
  assert.equal(/userId|localDate|slot|user_id/i.test(serialised), false);

  const content = sent.body.messages[0].content;
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /ONLY a single JSON object/, 'json_object mode is refused without the word JSON in the prompt');
  assert.equal(content[1].type, 'image_url');
  assert.equal(content[1].image_url.url, 'data:image/jpeg;base64,QUJD');
  assert.match(serialised, /Identify the individual foods/, 'the shared prompt, not a new dialect');
});

test('the reply is JSON mode at temperature 0, because this is a lookup', async () => {
  let body = null;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return openaiText(JSON.stringify({ isFood: true, items: [] }));
  };

  await provider.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }, CONFIG);

  assert.equal(body.temperature, 0);
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.model, CONFIG.model);
});

test('a normal response comes back parsed, with token counts', async () => {
  globalThis.fetch = async () =>
    openaiText(
      JSON.stringify({
        isFood: true,
        items: [
          { name: 'dal', grams: 200, confidence: 0.82, nonVeg: false },
          { name: 'roti', grams: 60, confidence: 0.71, nonVeg: false },
        ],
        note: 'looks like a thali',
      }),
    );

  const out = await provider.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }, CONFIG);

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
  assert.equal(out.tokensIn, 2049, 'token counts are the cost ledger');
  assert.equal(out.tokensOut, 60);
  assert.equal(out.model, 'qwen/qwen3.8-27b-served');
});

test('a fenced reply is still parsed, because a prompt edit must not become a 500', async () => {
  globalThis.fetch = async () =>
    openaiText('```json\n{"isFood":true,"items":[{"name":"dal","grams":100,"confidence":0.5}]}\n```');

  const out = await provider.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }, CONFIG);
  assert.equal(out.items[0].name, 'dal');
});

test('unusable items are dropped rather than reaching a catalogue search', async () => {
  globalThis.fetch = async () =>
    openaiText(
      JSON.stringify({
        isFood: true,
        items: [
          { name: '   ', grams: 100 },
          { name: 'dal', grams: -5, confidence: 47 },
          { name: 'roti', grams: 900000, confidence: 0.5 },
        ],
      }),
    );

  const out = await provider.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }, CONFIG);

  assert.equal(out.items.length, 2, 'the empty name is the only one dropped');
  assert.equal(out.items[0].grams, 100, 'a missing weight becomes a plain 100 g');
  assert.equal(out.items[1].grams, 5000, 'the same ceiling logFood enforces');
  assert.equal(out.items[0].confidence, 1, 'clamped, not stored as 47');
});

test('a content filter is a result, but an empty reply is a shape error', async () => {
  // A photo of a person is not a plate: the filter tripping has to read as
  // "nothing found" rather than as a failure the app offers to retry.
  globalThis.fetch = async () =>
    openaiText('', { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] });

  const out = await provider.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }, CONFIG);
  assert.equal(out.isFood, false);
  assert.deepEqual(out.items, []);
  assert.equal(out.blockedReason, 'content_filter');

  // No content and no filter: reporting THAT as "no food" would silently drop
  // a meal the user paid to have read, so it fails into the rotation instead.
  globalThis.fetch = async () =>
    openaiText('', { choices: [{ message: { content: '' }, finish_reason: 'length' }] });
  await assert.rejects(
    () => provider.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }, CONFIG),
    (err) => err.code === 'PROVIDER_BAD_SHAPE' && err.retryable === true,
  );
});

test('a 4xx is not retryable, a 5xx is', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => 'bad request' });
  await assert.rejects(
    () => provider.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }, CONFIG),
    (err) => err.retryable === false && err.code === 'PROVIDER_REJECTED',
  );

  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => 'unavailable' });
  await assert.rejects(
    () => provider.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }, CONFIG),
    (err) => err.retryable === true,
  );

  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => 'slow down' });
  await assert.rejects(
    () => provider.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }, CONFIG),
    (err) => err.retryable === true,
  );
});

test("the provider's error body never reaches the message", async () => {
  // Error payloads echo the request, and the request is a photograph.
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ error: { message: 'image_url contained <image bytes>' } }),
  });

  await assert.rejects(
    () => provider.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }, CONFIG),
    (err) => {
      assert.equal(err.message.includes('image bytes'), false);
      assert.match(err.message, /returned 400/);
      return true;
    },
  );
});

test('a network failure is retryable, a missing config is not, no image is refused', async () => {
  globalThis.fetch = async () => {
    throw new Error('ECONNRESET');
  };
  await assert.rejects(
    () => provider.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }, CONFIG),
    (err) => err.retryable === true && err.code === 'PROVIDER_UNREACHABLE',
  );

  await assert.rejects(
    () => provider.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }, { ...CONFIG, apiKey: '' }),
    (err) => err.retryable === false && err.code === 'PROVIDER_NOT_CONFIGURED',
  );

  await assert.rejects(
    () => provider.recognizeFood({ imageBase64: '', mimeType: 'image/jpeg' }, CONFIG),
    (err) => err.code === 'NO_IMAGE',
  );
});

test('unparseable JSON is a provider shape error, not a crash', async () => {
  globalThis.fetch = async () => openaiText('I am sorry, I cannot help with that.');

  await assert.rejects(
    () => provider.recognizeFood({ imageBase64: 'QUJD', mimeType: 'image/jpeg' }, CONFIG),
    (err) => err.code === 'PROVIDER_BAD_SHAPE',
  );
});
