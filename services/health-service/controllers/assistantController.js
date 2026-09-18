import * as assistantService from '../services/assistant/assistantService.js';
import { DISCLAIMER } from '../services/assistant/assistantPolicy.js';

function fail(res, err) {
  res.status(err.status || 500).json({
    error: err.error || err.message || 'Server error',
    code: err.code,
    retryAfterSeconds: err.retryAfterSeconds,
  });
}

/// The disclaimer text plus this user's consent state, in one call — the chat
/// screen needs both before it can decide whether to show the gate, and two
/// round trips to open a screen is one too many.
export const getConsent = async (req, res) => {
  try {
    const status = await assistantService.getConsentStatusService(req.userId);
    res.json({ data: { ...status, disclaimer: DISCLAIMER } });
  } catch (err) {
    fail(res, err);
  }
};

export const grantConsent = async (req, res) => {
  try {
    // Deliberately ignores any policyVersion in the body — see
    // assistantService.grantConsentService.
    const status = await assistantService.grantConsentService(req.userId);
    res.json({ data: status });
  } catch (err) {
    fail(res, err);
  }
};

export const revokeConsent = async (req, res) => {
  try {
    const status = await assistantService.revokeConsentService(req.userId);
    res.json({ data: status });
  } catch (err) {
    fail(res, err);
  }
};

export const listConversations = async (req, res) => {
  try {
    const data = await assistantService.listConversationsService(req.userId);
    res.json({ data });
  } catch (err) {
    fail(res, err);
  }
};

export const getConversation = async (req, res) => {
  try {
    const data = await assistantService.getConversationService(
      req.userId,
      parseInt(req.params.id)
    );
    res.json({ data });
  } catch (err) {
    fail(res, err);
  }
};

export const deleteConversation = async (req, res) => {
  try {
    const data = await assistantService.deleteConversationService(
      req.userId,
      parseInt(req.params.id)
    );
    res.json({ data });
  } catch (err) {
    fail(res, err);
  }
};

export const sendMessage = async (req, res) => {
  try {
    const { message, conversationId } = req.body || {};
    const data = await assistantService.sendMessageService(req.userId, {
      message,
      conversationId: conversationId ? parseInt(conversationId) : undefined,
    });
    res.json({ data });
  } catch (err) {
    fail(res, err);
  }
};
