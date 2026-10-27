// The Gobhi coach (B16): persona, journey guide, grounding, and the guardrails
// wired into the real send path. Run with:
//   node --experimental-test-module-mocks --test
//
// Pinned:
//   - flag off: the v5 prompt, unchanged — no persona, no journey guide, no
//     grounding — and the v5 prompt version is recorded;
//   - flag on: persona + journey guide + grounding, recorded as v6-gobhi;
//   - an input refusal never reaches the provider and is not stored;
//   - an unsafe reply is replaced before it is stored;
//   - supplement NAMES never reach the prompt, only a count;
//   - grounding serves approved content only;
//   - the journey guide's thresholds match journeyConfig.js.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JOURNEY } from '../services/journey/journeyConfig.js';

// ---- shared fakes -----------------------------------------------------------

const state = {
  flagOn: false,
  providerReply: 'Do 3 sets of 10 squats.',
  providerCalls: [],
  messages: [],
  tracked: [],
  supplements: [{ userId: 1, name: 'SecretBrandCreatine', active: true }, { userId: 1, name: 'FishOilX', active: true }],
};

function resetState() {
  state.providerCalls = [];
  state.messages = [];
  state.tracked = [];
}

class FakePrisma {
  constructor() {
    this.assistantConversation = {
      create: async ({ data }) => ({ id: 77, summary: null, ...data }),
      findUnique: async () => null,
      update: async () => ({}),
    };
    this.assistantMessage = {
      create: async ({ data }) => { const row = { id: state.messages.length + 1, ...data }; state.messages.push(row); return row; },
      findMany: async () => state.messages.filter((m) => m.role === 'user').slice(-1),
      count: async () => 0,
    };
    this.prescription = {
      findUnique: async () => ({ userId: 1, stepsPerDay: 7000, sleepMinutes: 450, kcal: null,
        workoutSlots: [{ weekday: 1, title: 'Full Body A' }, { weekday: 4, title: 'Full Body B' }] }),
    };
    this.supplementSchedule = {
      count: async ({ where }) => state.supplements.filter((s) => s.userId === where.userId && s.active).length,
      findMany: async () => state.supplements,
    };
    this.exerciseContent = {
      findMany: async () => [{ exerciseId: 7 }],
      findFirst: async ({ where }) => (where.exerciseId === 7 && where.reviewStatus === 'approved' && where.lang === 'en'
        ? { exerciseId: 7, lang: 'en', steps: ['Feet shoulder-width apart.'], feelCues: ['You should feel your thighs.'], mistakes: ['Knees caving in.'] }
        : null),
    };
    this.exercise = {
      findMany: async () => [{ id: 7, name: 'Goblet Squat' }],
      findUnique: async () => ({ difficulty: 'beginner' }),
    };
    this.coachArticle = {
      findMany: async ({ where }) => (where.reviewStatus === 'approved'
        ? [{ slug: 'day-one', title: 'Your first day', body: 'Walk in, say hi, start easy.' }]
        : []),
      findFirst: async ({ where }) => (where.reviewStatus === 'approved' && where.lang === 'en'
        ? { slug: 'day-one', title: 'Your first day', body: 'Walk in, say hi, start easy.', lang: 'en' }
        : null),
    };
  }
}

let svc;
let grounding;
let policy;

test('setup: stub Prisma, provider, flags, analytics and the user context', async () => {
  // File-level mock.module, not t.mock: the journey modules are imported lazily
  // by a LATER test, after a per-test mock would already have been restored.
  mock.module('@prisma/client', { exports: { PrismaClient: FakePrisma, Prisma: {} } });
  mock.module('../services/assistant/providers/index.js', {
    exports: {
      ProviderError: class ProviderError extends Error {},
      isProviderConfigured: () => true,
      getProvider: () => ({
        generate: async (args) => { state.providerCalls.push(args); return { content: state.providerReply, model: 'fake', tokensIn: 1, tokensOut: 1 }; },
      }),
    },
  });
  mock.module('../middleware/requireFeatureFlag.js', {
    exports: { isFeatureEnabled: async (name) => name === 'coachAssistant' && state.flagOn },
  });
  mock.module('../utils/analytics.js', {
    exports: { track: (event, id, props) => state.tracked.push({ event, id, props }), default: {} },
  });
  mock.module('../services/assistant/contextService.js', {
    exports: { buildUserContextService: async () => ({ text: 'Trained on 3 days in the last 30.', audit: { contextChars: 33 } }) },
  });
  mock.module('../services/assistant/rateLimitService.js', {
    exports: { canSendMessageService: async () => ({ allowed: true }), recordMessageSentService: async () => {} },
  });
  mock.module('../services/assistant/memoryService.js', {
    exports: { extractMemoriesService: async () => [] },
  });
  // The journey reads are lazily imported only when the flag is on.
  mock.module('../services/journey/journeyService.js', {
    exports: { getUnlockedLayerKeys: async () => ['workout', 'water', 'food'] },
  });
  mock.module('../services/journey/showedUpDays.js', {
    exports: { getShowedUpDays: async () => ['2026-10-06', '2026-10-08'] },
  });
  mock.module('../services/journey/steadyWeeks.js', {
    exports: { countSteadyWeeks: () => 1 },
  });
  svc = await import('../services/assistant/assistantService.js');
  grounding = await import('../services/assistant/coachGrounding.js');
  policy = await import('../services/assistant/assistantPolicy.js');
});

test('flag off: the v5 assistant, unchanged', async () => {
  resetState();
  state.flagOn = false;
  await svc.sendMessageService(1, { message: 'how many squats should I do as a beginner' });
  const prompt = state.providerCalls[0].systemPrompt;
  assert.doesNotMatch(prompt, /Persona: you are Gobhi/);
  assert.doesNotMatch(prompt, /The coach journey/);
  assert.doesNotMatch(prompt, /Their plan from Gobhi/);
  assert.ok(state.messages.every((m) => m.promptVersion === policy.CURRENT_PROMPT_VERSION));
});

test('flag on: persona, journey guide and grounding, recorded as v6-gobhi', async () => {
  resetState();
  state.flagOn = true;
  await svc.sendMessageService(1, { message: 'how do I do a goblet squat' });
  const prompt = state.providerCalls[0].systemPrompt;
  assert.match(prompt, /Persona: you are Gobhi/);
  assert.match(prompt, /The coach journey/);
  assert.match(prompt, /Their plan from Gobhi:/);
  assert.match(prompt, /Workout days: Mon Full Body A, Thu Full Body B\./);
  assert.match(prompt, /Open in their plan: workout days, water, food\./);
  assert.match(prompt, /Approved coaching notes/);
  assert.match(prompt, /Goblet Squat — how to: Feet shoulder-width apart\./);
  // The grounding sits after the user context, so the stable prefix caches.
  assert.ok(prompt.indexOf('Their plan from Gobhi') > prompt.indexOf('What you know about this user'));
  assert.ok(state.messages.every((m) => m.promptVersion === policy.COACH_PROMPT_VERSION));
  const reply = state.messages.find((m) => m.role === 'assistant');
  assert.equal(reply.usedContext.coach.notes, 1);
});

test('supplement names never reach the prompt — only the count', async () => {
  resetState();
  state.flagOn = true;
  await svc.sendMessageService(1, { message: 'what should I do today' });
  const prompt = state.providerCalls[0].systemPrompt;
  assert.match(prompt, /They log 2 supplements they already take \(names withheld\)/);
  assert.doesNotMatch(prompt, /SecretBrandCreatine|FishOilX/);
});

test('an input refusal never reaches the provider and is not stored', async () => {
  resetState();
  state.flagOn = true;
  await assert.rejects(
    svc.sendMessageService(1, { message: 'kitna creatine lu' }),
    (err) => err.status === 422 && err.code === 'OUT_OF_SCOPE' && /doctor/i.test(err.error),
  );
  assert.equal(state.providerCalls.length, 0);
  assert.equal(state.messages.length, 0);
  assert.deepEqual(state.tracked.map((e) => [e.event, e.props.stage, e.props.lang]),
    [['assistant_guardrail_triggered', 'input', 'hinglish']]);
});

test('an unsafe reply is replaced by the doctor answer before it is stored', async () => {
  resetState();
  state.flagOn = false; // the output filter runs whatever the flag says
  state.providerReply = 'Take 5 g of creatine every day for faster gains.';
  try {
    const out = await svc.sendMessageService(1, { message: 'how do I build muscle faster' });
    assert.doesNotMatch(out.message.content, /creatine/i);
    assert.match(out.message.content, /doctor/i);
    assert.equal(out.message.usedContext.guardrail, 'dose');
    assert.ok(!state.messages.some((m) => /5 g of creatine/.test(m.content)), 'unsafe text must not be stored');
    assert.equal(state.tracked[0].props.stage, 'output');
  } finally {
    state.providerReply = 'Do 3 sets of 10 squats.';
  }
});

test('grounding: approved notes only, and nothing when the question matches nothing', async () => {
  const prisma = new FakePrisma();
  prisma.coachArticle.findMany = async ({ where }) => (where.reviewStatus === 'approved' ? [] : [{ slug: 'x', title: 'Squat', body: 'pending' }]);
  const deps = { getUnlockedLayerKeys: async () => ['workout', 'water'], getSteadyWeeks: async () => 0 };
  const g = await grounding.buildCoachGrounding(prisma, { userId: 1, message: 'zzzz qqqq', lang: 'en' }, deps);
  assert.doesNotMatch(g.text, /Approved coaching notes/);
  assert.equal(g.audit.notes, 0);
});

test('grounding survives every read failing', async () => {
  const broken = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => { throw new Error('db down'); } }) });
  const deps = { getUnlockedLayerKeys: async () => { throw new Error('x'); }, getSteadyWeeks: async () => { throw new Error('y'); } };
  const g = await grounding.buildCoachGrounding(broken, { userId: 1, message: 'squat', lang: 'en' }, deps);
  assert.equal(g.text, '');
});

test('the journey guide matches journeyConfig.js thresholds', async () => {
  const { JOURNEY_GUIDE } = await import('../services/assistant/appKnowledge.js');
  const need = (key) => JOURNEY.layers.find((l) => l.key === key).unlock.need;
  assert.match(JOURNEY_GUIDE, new RegExp(`after ${need('food')} showed-up days`));
  assert.match(JOURNEY_GUIDE, new RegExp(`Steps \\+ sleep — after ${need('body')} days`));
  assert.match(JOURNEY_GUIDE, new RegExp(`Supplements — after ${need('supplements')} days`));
  assert.match(JOURNEY_GUIDE, new RegExp(`Health reports — after ${need('health')} days`));
  assert.match(JOURNEY_GUIDE, new RegExp(`${JOURNEY.steadyWeekMinDays} or more showed-up days`));
  assert.match(JOURNEY_GUIDE, new RegExp(`first ${JOURNEY.easyStartDays} days`, 'i'));
});

test('flag-off prompt is exactly the v5 prompt', () => {
  assert.equal(policy.getSystemPrompt(), policy.getSystemPrompt({ coach: false }));
  assert.ok(policy.getSystemPrompt({ coach: true }).startsWith(policy.getSystemPrompt().split('\n')[0]));
});
