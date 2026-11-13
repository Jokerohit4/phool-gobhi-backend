import { getConsentStatusService } from '../services/assistant/assistantService.js';

/// Blocks the message routes until this user has agreed to the CURRENT
/// disclaimer.
///
/// The first real consent middleware in this codebase — consent is checked ad
/// hoc inside controllers everywhere else. It is worth being middleware here
/// because it guards several routes and because getting it wrong means an AI
/// answering medical-adjacent questions for someone who never agreed to that.
///
/// Distinguishes "never agreed" from "agreed to older wording" so the client
/// can show a returning user an explanation rather than a first-run screen.
export async function requireAssistantConsent(req, res, next) {
  try {
    const status = await getConsentStatusService(req.userId);
    if (status.granted) return next();
    return res.status(403).json({
      error: status.needsReconsent
        ? 'The assistant terms have changed — please review them again.'
        : 'Please review and accept the assistant terms first.',
      code: status.needsReconsent ? 'CONSENT_STALE' : 'CONSENT_REQUIRED',
    });
  } catch (err) {
    // Fails CLOSED. Everywhere else in this service a lookup failure degrades
    // to showing less; here it would degrade to answering questions about
    // someone's body without a recorded agreement, which is the one outcome
    // this file exists to prevent.
    return res.status(503).json({
      error: 'Could not verify your assistant consent. Please try again.',
      code: 'CONSENT_CHECK_FAILED',
    });
  }
}
