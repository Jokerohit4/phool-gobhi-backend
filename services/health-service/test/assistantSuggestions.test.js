import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

let service;
let controller;
let dependencyCalls = 0;
const unexpectedCall = () => {
  dependencyCalls++;
  throw new Error('Disabled suggestions must not access the database or provider');
};

test('setup disabled suggestions with unavailable database and provider', async (t) => {
  t.mock.module('../db/prisma.js', { defaultExport: new Proxy({}, { get: unexpectedCall }) });
  t.mock.module('../services/assistant/providers/index.js', { exports: {
    isProviderConfigured: unexpectedCall,
    getProvider: unexpectedCall,
  } });
  // Isolate the other controller actions; suggestions use the real service.
  t.mock.module('../services/assistant/assistantService.js', { exports: {} });
  t.mock.module('../services/assistant/memoryService.js', { exports: {} });
  service = await import('../services/assistant/suggestionService.js');
  controller = await import('../controllers/assistantController.js');
});

test('starters, conversation follow-ups and draft completions are all empty', async () => {
  for (const input of [undefined, {}, { draft: 'Help me' }, { conversationId: 2 },
    { conversationId: 2, draft: 'I feel' }, { draft: 'a'.repeat(2000) }]) {
    assert.deepEqual(await service.getSuggestionsService(7, input), { suggestions: [] });
  }
  // No conversation content is read, even for another user's conversation id.
  assert.deepEqual(await service.getSuggestionsService(8, { conversationId: 2 }), { suggestions: [] });
  assert.equal(dependencyCalls, 0);
});

test('malformed requests still fail validation without using external dependencies', async () => {
  for (const input of [{ draft: 42 }, { draft: 'a'.repeat(2001) },
    { conversationId: '2' }, { conversationId: -1 }]) {
    await assert.rejects(service.getSuggestionsService(7, input), { status: 400 });
  }
  assert.equal(dependencyCalls, 0);
});

test('released app receives HTTP 200, its existing empty-list envelope and no-store', async (t) => {
  const app = express();
  app.use(express.json());
  // Production keeps its existing authentication, feature and consent gates.
  app.post('/api/health/assistant/suggestions', (req, res) => {
    req.userId = 7;
    return controller.getSuggestions(req, res);
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const url = `http://127.0.0.1:${server.address().port}/api/health/assistant/suggestions`;
  for (const body of [{}, { conversationId: 2, draft: 'Help me with my workout' }]) {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { data: { suggestions: [] } });
  }
  assert.equal(dependencyCalls, 0);
});
