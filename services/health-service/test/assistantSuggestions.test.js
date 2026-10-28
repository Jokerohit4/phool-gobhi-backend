import { test } from 'node:test';
import assert from 'node:assert/strict';

let service;
let payload;
let configured = true;
let content = '{"suggestions":["Can we talk about my mood?","Help me unwind"]}';
const calls = [];

test('setup suggestions with a read-only database and provider', async (t) => {
  t.mock.module('@prisma/client', { exports: {
    PrismaClient: class {
      assistantConversation = { findUnique: async ({where}) => ({ id: where.id, userId: 7, summary: 'Feeling overwhelmed' }) };
      assistantMessage = { findMany: async () => [
        { role: 'assistant', content: 'Want to talk about what happened?' },
        { role: 'user', content: 'I feel low today' },
      ] };
    },
  } });
  t.mock.module('../services/assistant/providers/index.js', { exports: {
    isProviderConfigured: () => configured,
    getProvider: () => ({ generate: async (value) => { payload = value; calls.push(value); return {content}; } }),
  } });
  service = await import('../services/assistant/suggestionService.js');
});

test('mood conversation, summary and draft reach generation in chronological order', async () => {
  const result = await service.getSuggestionsService(7, {conversationId: 2, draft: 'I wish'});
  assert.deepEqual(result.suggestions, ['Can we talk about my mood?', 'Help me unwind']);
  const data = JSON.parse(payload.messages[0].content);
  assert.equal(data.draft, 'I wish');
  assert.equal(data.summary, 'Feeling overwhelmed');
  assert.equal(data.history[0].role, 'user');
  assert.match(payload.systemPrompt, /Support only training, app help, health, fitness, mental health, and mood/);
  assert.match(payload.systemPrompt, /wholly unrelated draft or conversation/);
  assert.match(payload.systemPrompt, /return {"suggestions":\[\]}/);
});

test('another user cannot generate from a private conversation', async () => {
  const before = calls.length;
  await assert.rejects(service.getSuggestionsService(8, {conversationId: 2}), {status: 404});
  assert.equal(calls.length, before);
});

test('malformed requests fail before calling the provider', async () => {
  const before = calls.length;
  for (const input of [{draft: 42}, {draft: 'a'.repeat(2001)}, {conversationId: '2'}, {conversationId: -1}]) {
    await assert.rejects(service.getSuggestionsService(7, input), {status: 400});
  }
  assert.equal(calls.length, before);
});

test('unconfigured provider and invalid output have no static fallback', async () => {
  configured = false;
  await assert.rejects(service.getSuggestionsService(7), {status: 503});
  configured = true;
  content = 'not json';
  assert.deepEqual(await service.getSuggestionsService(7), {suggestions: []});
});

test('output validation removes duplicates, invalid entries and unsafe prompts', () => {
  assert.deepEqual(service.parseSuggestions(JSON.stringify({suggestions: [
    ' Help me unwind ', 'help me unwind', 5, '', 'x'.repeat(201), 'What medicine should I take?', 'Tell me more',
  ]})), ['Help me unwind', 'Tell me more']);
  assert.deepEqual(service.parseSuggestions('```json\n{"suggestions":["Listen to me"]}\n```'), ['Listen to me']);
});
