import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// The rotation, exercised through a stubbed `fetch` rather than mocked modules:
// what matters is which vendor a given attempt actually talks to, and that is
// only observable on the wire — the URL, the auth header, the model in the
// body. Config is read per call (both adapters and this module), so these tests
// set the environment per test instead of cache-busting the import.

const REAL_FETCH = globalThis.fetch;

const ENV_KEYS = [
  'FOOD_PHOTO_PROVIDER_BASE_URL',
  'FOOD_PHOTO_PROVIDER_API_KEY',
  'FOOD_PHOTO_PROVIDER_MODEL',
  'FOOD_PHOTO_PROVIDER_CANDIDATES',
  'ASSISTANT_PROVIDER_BASE_URL',
  'ASSISTANT_PROVIDER_API_KEY',
  'ASSISTANT_PROVIDER_MODEL',
];

let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.FOOD_PHOTO_PROVIDER_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
  process.env.FOOD_PHOTO_PROVIDER_API_KEY = 'gem-key';
  process.env.FOOD_PHOTO_PROVIDER_MODEL = 'gemini-3.5-flash';
  process.env.ASSISTANT_PROVIDER_BASE_URL = 'https://api.groq.com/openai/v1';
  process.env.ASSISTANT_PROVIDER_API_KEY = 'groq-key';
  delete process.env.FOOD_PHOTO_PROVIDER_CANDIDATES;
  globalThis.fetch = REAL_FETCH;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.fetch = REAL_FETCH;
});

const index = await import('../services/ledger/providers/index.js');

function geminiReply() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ isFood: false, items: [] }) }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      modelVersion: 'gemini-3.5-flash-001',
    }),
    text: async () => '',
  };
}

function openaiReply() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ isFood: false, items: [] }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2049, completion_tokens: 6 },
      model: 'qwen/qwen3.8-27b',
    }),
    text: async () => '',
  };
}

function stubFetch(hits) {
  globalThis.fetch = async (url, init) => {
    hits.push({ url, init, body: JSON.parse(init.body) });
    return String(url).includes('groq') ? openaiReply() : geminiReply();
  };
}

const PHOTO = { imageBase64: 'QUJD', mimeType: 'image/jpeg' };

test('the default chain is gemini first, then the assistant gateway on its vision model', () => {
  const chain = index.candidates();
  assert.equal(chain.length, 2, 'both keys are deployed in this environment');

  assert.equal(chain[0].provider, 'gemini', 'an app that knows nothing about the rotation starts here');
  assert.equal(chain[1].provider, 'openai');
  // The pairing that matters: the assistant's key, on the vision model of the
  // SAME gateway — not the assistant's text model, which cannot see an image.
  assert.equal(chain[1].config.apiKey, 'groq-key');
  assert.equal(chain[1].config.baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(chain[1].config.model, 'qwen/qwen3.8-27b');
});

test('attempts alternate vendors, and cycle when they run past the chain', async () => {
  const hits = [];
  stubFetch(hits);

  for (const attempt of [1, 2, 3, 4]) {
    await index.recognizeFood(PHOTO, { attempt });
  }

  assert.equal(hits.length, 4, 'exactly one provider call per attempt');
  assert.match(hits[0].url, /generativelanguage\.googleapis\.com/);
  assert.match(hits[1].url, /api\.groq\.com/);
  assert.match(hits[2].url, /generativelanguage\.googleapis\.com/);
  assert.match(hits[3].url, /api\.groq\.com/);

  assert.equal(hits[0].init.headers['x-goog-api-key'], 'gem-key');
  assert.equal(hits[1].init.headers.Authorization, 'Bearer groq-key');
  assert.equal(hits[1].body.model, 'qwen/qwen3.8-27b');
  // The image travels as a data URL — no second hop to a file host.
  assert.match(hits[1].body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
});

test('unusable attempt numbers fall back to the first candidate', async () => {
  const hits = [];
  stubFetch(hits);

  for (const attempt of [undefined, 'garbage', 0, -3, null]) {
    await index.recognizeFood(PHOTO, { attempt });
  }

  assert.equal(hits.length, 5);
  for (const hit of hits) {
    assert.match(hit.url, /generativelanguage\.googleapis\.com/);
  }
});

test('a chain shorter than the ladder keeps cycling rather than running out', async () => {
  delete process.env.ASSISTANT_PROVIDER_API_KEY;
  assert.equal(index.candidates().length, 1, 'no assistant key, no second candidate');

  const hits = [];
  stubFetch(hits);
  for (const attempt of [1, 2, 5]) {
    await index.recognizeFood(PHOTO, { attempt });
  }
  assert.equal(hits.length, 3);
  for (const hit of hits) assert.match(hit.url, /generativelanguage\.googleapis\.com/);
});

test('no configured vendor is a NOT_CONFIGURED failure the app can explain', async () => {
  delete process.env.FOOD_PHOTO_PROVIDER_API_KEY;
  delete process.env.ASSISTANT_PROVIDER_API_KEY;

  assert.equal(index.isRecognizerConfigured(), false);
  assert.equal(index.candidates().length, 0);
  await assert.rejects(
    () => index.recognizeFood(PHOTO, { attempt: 1 }),
    (err) => err.code === 'PROVIDER_NOT_CONFIGURED' && err.retryable === false,
  );
});

test('an explicit candidates list replaces the default chain', async () => {
  // The default keys are deliberately absent from the entries below: if any
  // field leaked back to FOOD_PHOTO_PROVIDER_* / ASSISTANT_PROVIDER_*, this
  // test would still pass while the admin believed they had rotated away.
  process.env.FOOD_PHOTO_PROVIDER_API_KEY = '';
  process.env.ASSISTANT_PROVIDER_API_KEY = '';
  process.env.FOOD_PHOTO_PROVIDER_CANDIDATES = JSON.stringify([
    {
      provider: 'openai',
      baseUrl: 'https://vendor-a.example/v1',
      apiKey: 'key-a',
      model: 'vendor-a-vision',
    },
    { provider: 'gemini', baseUrl: 'https://gem.example/v1beta', apiKey: 'key-b', model: 'gem-model' },
  ]);

  const chain = index.candidates();
  assert.equal(chain.length, 2);
  assert.equal(index.isRecognizerConfigured(), true);

  const hits = [];
  globalThis.fetch = async (url, init) => {
    hits.push(String(url));
    return String(url).includes('vendor-a') ? openaiReply() : geminiReply();
  };

  await index.recognizeFood(PHOTO, { attempt: 1 });
  await index.recognizeFood(PHOTO, { attempt: 2 });
  assert.match(hits[0], /^https:\/\/vendor-a\.example\/v1\/chat\/completions$/);
  assert.match(hits[1], /^https:\/\/gem\.example\/v1beta\/models\//);
});

test('a malformed override fails closed instead of falling back to the old keys', async () => {
  process.env.FOOD_PHOTO_PROVIDER_CANDIDATES = 'not json at all';

  // Falling back to the default chain here would keep calling the vendor the
  // admin just rotated away from — the one thing the override exists to stop.
  assert.equal(index.candidates().length, 0);
  assert.equal(index.isRecognizerConfigured(), false);
});

test('incomplete or unknown entries in an override are dropped', () => {
  process.env.FOOD_PHOTO_PROVIDER_CANDIDATES = JSON.stringify([
    { provider: 'openai', baseUrl: 'https://vendor-a.example/v1', apiKey: '', model: 'm' },
    { provider: 'whoknows', baseUrl: 'https://x.example', apiKey: 'k', model: 'm' },
    { provider: 'openai', baseUrl: 'https://vendor-b.example/v1', apiKey: 'key-c', model: 'm' },
  ]);

  const chain = index.candidates();
  assert.equal(chain.length, 1, 'the one complete, known entry survives');
  assert.equal(chain[0].config.apiKey, 'key-c');
});
