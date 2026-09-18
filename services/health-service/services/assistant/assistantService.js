import { PrismaClient } from '@prisma/client';
import { getProvider, isProviderConfigured, ProviderError } from './providers/index.js';
import { buildUserContextService } from './contextService.js';
import { canSendMessageService, recordMessageSentService } from './rateLimitService.js';
import {
  CURRENT_POLICY_VERSION,
  CURRENT_PROMPT_VERSION,
  getSystemPrompt,
  classifyMessage,
} from './assistantPolicy.js';

const prisma = new PrismaClient();

const MAX_OUTPUT_TOKENS = Number(process.env.ASSISTANT_MAX_OUTPUT_TOKENS || 600);
// How many raw turns go to the model. Everything older is represented by the
// conversation summary instead, which is what stops cost climbing with the
// length of a conversation.
const RAW_HISTORY_TURNS = 10;
const SUMMARISE_AFTER_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 2000;

// --- consent ---------------------------------------------------------------

export async function getConsentStatusService(userId) {
  // Reported alongside consent because the screen needs both before it can
  // decide what to show: the flag can be on, the user can have agreed, and
  // the assistant still have no model behind it.
  const available = isProviderConfigured();
  const row = await prisma.assistantConsent.findUnique({ where: { userId } });
  if (!row) {
    return { granted: false, needsReconsent: false, available, policyVersion: CURRENT_POLICY_VERSION };
  }
  const active = !row.revokedAt;
  return {
    available,
    granted: active && row.policyVersion === CURRENT_POLICY_VERSION,
    // Distinct from "never agreed": the UI should explain that the terms
    // changed rather than showing a first-run screen to a returning user.
    needsReconsent: active && row.policyVersion !== CURRENT_POLICY_VERSION,
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
    policyVersion: CURRENT_POLICY_VERSION,
  };
}

/// Takes no version from the caller — it stamps the server's own. That is what
/// makes re-consent enforceable when the wording changes.
export async function grantConsentService(userId) {
  const now = new Date();
  await prisma.assistantConsent.upsert({
    where: { userId },
    update: { grantedAt: now, revokedAt: null, policyVersion: CURRENT_POLICY_VERSION },
    create: { userId, grantedAt: now, policyVersion: CURRENT_POLICY_VERSION },
  });
  return getConsentStatusService(userId);
}

export async function revokeConsentService(userId) {
  const row = await prisma.assistantConsent.findUnique({ where: { userId } });
  if (!row) throw { status: 404, error: 'No consent on record' };
  // Soft revoke, matching HealthConsent: "was this ever granted, and when"
  // has to survive, or there is no record that the user ever agreed.
  await prisma.assistantConsent.update({
    where: { userId },
    data: { revokedAt: new Date() },
  });
  return getConsentStatusService(userId);
}

// --- conversations ---------------------------------------------------------

export async function listConversationsService(userId) {
  return prisma.assistantConversation.findMany({
    where: { userId, archivedAt: null },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    select: { id: true, title: true, createdAt: true, updatedAt: true },
  });
}

export async function getConversationService(userId, conversationId) {
  const convo = await prisma.assistantConversation.findUnique({
    where: { id: conversationId },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  // Same 404 whether it belongs to someone else or does not exist — a
  // different error for each would let anyone enumerate conversation ids.
  if (!convo || convo.userId !== userId) throw { status: 404, error: 'Conversation not found' };
  return convo;
}

export async function deleteConversationService(userId, conversationId) {
  await getConversationService(userId, conversationId);
  // Messages cascade — see the FK in the migration.
  await prisma.assistantConversation.delete({ where: { id: conversationId } });
  return { deleted: true };
}

// --- the actual chat -------------------------------------------------------

function titleFrom(text) {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.length <= 60 ? clean : clean.slice(0, 57) + '…';
}

/// Send a message and get the assistant's reply.
///
/// Ordering matters here and is deliberate:
///   1. validate -> 2. rate-limit -> 3. persist the user's message ->
///   4. call the provider -> 5. persist the reply
/// The user's message is stored before the provider is called, so a provider
/// failure loses the reply and never what the person typed.
export async function sendMessageService(userId, { conversationId, message }) {
  const text = (message || '').trim();
  if (!text) throw { status: 400, error: 'Message cannot be empty' };
  if (text.length > MAX_MESSAGE_CHARS) {
    throw { status: 400, error: 'Message is too long (max ' + MAX_MESSAGE_CHARS + ' characters)' };
  }

  // Checked before the rate limit so an unconfigured provider never burns a
  // user's hourly allowance on a request that could not have succeeded.
  if (!isProviderConfigured()) {
    throw {
      status: 503,
      error: 'The assistant is not switched on yet. Nothing you typed was lost.',
      code: 'ASSISTANT_NOT_CONFIGURED',
    };
  }

  const refusal = classifyMessage(text);
  if (refusal) throw { status: 422, error: refusal, code: 'OUT_OF_SCOPE' };

  const gate = await canSendMessageService(userId);
  if (!gate.allowed) {
    throw {
      status: 429,
      error:
        gate.reason === 'hourly_cap'
          ? 'You have hit the hourly limit — try again in a bit.'
          : 'You have hit today’s limit — try again tomorrow.',
      code: 'RATE_LIMITED',
      retryAfterSeconds: gate.retryAfterSeconds,
    };
  }

  const convo = conversationId
    ? await getConversationService(userId, conversationId)
    : await prisma.assistantConversation.create({
        data: { userId, title: titleFrom(text) },
      });

  // Counted the moment the message is accepted, not when it succeeds — a
  // provider call that errors has still been paid for.
  await recordMessageSentService(userId);

  await prisma.assistantMessage.create({
    data: {
      conversationId: convo.id,
      userId,
      role: 'user',
      content: text,
      policyVersion: CURRENT_POLICY_VERSION,
      promptVersion: CURRENT_PROMPT_VERSION,
    },
  });

  const [context, history] = await Promise.all([
    buildUserContextService(userId),
    prisma.assistantMessage.findMany({
      where: { conversationId: convo.id },
      orderBy: { createdAt: 'desc' },
      take: RAW_HISTORY_TURNS,
    }),
  ]);

  const systemPrompt = [
    getSystemPrompt(),
    '',
    'What you know about this user:',
    context.text,
    ...(convo.summary ? ['', 'Earlier in this conversation:', convo.summary] : []),
  ].join('\n');

  const started = Date.now();
  let reply;
  try {
    reply = await callProviderWithRetry({
      systemPrompt,
      messages: history.reverse().map((m) => ({ role: m.role, content: m.content })),
    });
  } catch (err) {
    // The user's message is already saved, so nothing they typed is lost and
    // a retry continues the same conversation rather than starting over.
    throw {
      status: 503,
      error: 'The assistant is not available right now. Your message was saved — try again shortly.',
      code: 'ASSISTANT_UNAVAILABLE',
      cause: err.message,
    };
  }

  const assistantMessage = await prisma.assistantMessage.create({
    data: {
      conversationId: convo.id,
      userId,
      role: 'assistant',
      content: reply.content,
      policyVersion: CURRENT_POLICY_VERSION,
      promptVersion: CURRENT_PROMPT_VERSION,
      providerModel: reply.model,
      tokensIn: reply.tokensIn,
      tokensOut: reply.tokensOut,
      latencyMs: Date.now() - started,
      usedContext: context.audit,
    },
  });

  await prisma.assistantConversation.update({
    where: { id: convo.id },
    data: { updatedAt: new Date() },
  });

  // Fire-and-forget: a failed compaction costs a slightly longer prompt next
  // turn, which is not worth failing a reply the user already has.
  maybeSummariseConversation(convo.id).catch(() => {});

  return { conversationId: convo.id, message: assistantMessage };
}

/// One retry, on transient failures only. A 4xx means the request is wrong and
/// retrying it just spends money to fail identically.
async function callProviderWithRetry(payload) {
  const provider = getProvider();
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await provider.generate({ ...payload, maxTokens: MAX_OUTPUT_TOKENS });
    } catch (err) {
      lastError = err;
      if (!(err instanceof ProviderError) || !err.retryable || attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 400));
    }
  }
  throw lastError;
}

/// Compresses everything older than the raw window into the conversation
/// summary, so a long conversation costs the same per turn as a short one.
async function maybeSummariseConversation(conversationId) {
  const total = await prisma.assistantMessage.count({ where: { conversationId } });
  if (total < SUMMARISE_AFTER_MESSAGES) return;

  const convo = await prisma.assistantConversation.findUnique({ where: { id: conversationId } });
  const older = await prisma.assistantMessage.findMany({
    where: {
      conversationId,
      ...(convo && convo.summarizedThroughMessageId
        ? { id: { gt: convo.summarizedThroughMessageId } }
        : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: total - RAW_HISTORY_TURNS,
  });
  if (older.length < RAW_HISTORY_TURNS) return;

  const provider = getProvider();
  const transcript = older.map((m) => m.role + ': ' + m.content).join('\n');
  const previous = convo && convo.summary ? 'Earlier summary: ' + convo.summary + '\n\n' : '';
  const result = await provider.generate({
    systemPrompt:
      'Summarise this conversation in under 150 words. Keep concrete facts about the ' +
      'person (goals, constraints, preferences, what they have been advised). Drop pleasantries.',
    messages: [{ role: 'user', content: previous + transcript }],
    maxTokens: 300,
  });

  await prisma.assistantConversation.update({
    where: { id: conversationId },
    data: {
      summary: result.content,
      summarizedThroughMessageId: older[older.length - 1].id,
    },
  });
}
