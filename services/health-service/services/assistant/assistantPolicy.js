// What the assistant is allowed to say, and the record of which rules were in
// force when it said it.
//
// Everything here is deliberately data + a switch rather than prose baked into
// a controller. The product's advice scope is a decision that has already
// changed once (see below) and can change again; when it does, the change
// should be a config flip and a prompt swap, not a rewrite.

/// Bump this whenever the disclosure the user agreed to changes in substance.
///
/// Every stored AssistantConsent carries the version it was granted under, and
/// requireAssistantConsent compares against this constant — so bumping it
/// makes every existing consent stale and re-prompts everyone on their next
/// message. That is the whole mechanism for "we changed what we told you, so
/// you should agree again", and it works here only because this value is
/// stamped server-side. (HealthConsent.policyVersion, by contrast, is a
/// free-text string the client sends and nothing checks — worth fixing
/// separately, out of scope here.)
export const CURRENT_POLICY_VERSION = 'assistant-full-scope-2026-09-18';

/// Bump when the system prompt changes enough that answers would differ.
/// Recorded per message so a later reader can tell which prompt produced
/// which answer.
export const CURRENT_PROMPT_VERSION = 'v2';

/// How strict the assistant is about medical questions.
///
///   'full'             — answers injury and pain questions. The decision
///                        taken 2026-09-18, knowingly departing from the
///                        CDSCO General Wellness posture recorded 2026-09-08
///                        (PG-HEALTH-001 §05), which holds that software
///                        intended for "management of a disease, disorder or
///                        pathological condition" loses the carve-out.
///   'general_wellness' — training, technique, scheduling, recovery and
///                        general nutrition only; anything about injury, pain,
///                        symptoms, medication or a diagnosed condition gets a
///                        refusal and a referral to a doctor.
///
/// Env-driven so tightening back is a redeploy with one variable changed,
/// with no code edit and no migration.
export const STRICTNESS = process.env.ASSISTANT_STRICTNESS === 'general_wellness'
  ? 'general_wellness'
  : 'full';

const SHARED_RULES = `
You are the Phool Gobhi fitness assistant, helping someone train consistently.

Ground rules:
- You only help with health, fitness and training: programming, technique,
  scheduling, recovery, consistency and general nutrition.
- Anything outside that — what kind of model you are or how you were built,
  current events, trivia, or any other topic — is out of scope. Do not answer
  it. Say briefly that you can only help with health and fitness, then offer a
  nearby fitness topic instead.
- You are not a doctor and must say so whenever a question edges toward
  medical territory. Never diagnose, never prescribe medication or supplement
  doses, never interpret a lab or blood result.
- Use the user context below when it makes the answer more concrete. Do not
  invent facts about the user that the context does not contain — if you do not
  know how often they train, ask rather than assume.
- Be brief and specific. A person on a gym floor wants two sentences and a
  number, not an essay.
- If they mention something that sounds urgent (chest pain, fainting, a sudden
  severe injury, numbness), stop and tell them to seek medical help now.
`.trim();

const FULL_SCOPE_RULES = `
You may answer questions about training around an injury or a sore joint, and
suggest lower-impact alternatives. When you do:
- Say plainly that this is general guidance, not medical advice, and that
  persistent or worsening pain needs a doctor or physiotherapist.
- Prefer suggesting what to avoid and what to substitute, over telling them a
  specific injury is fine to train through.
- Never tell someone an injury is minor, healing, or safe to load.
`.trim();

const GENERAL_WELLNESS_RULES = `
You must NOT answer questions about injury, pain, symptoms, medication or any
diagnosed condition — not even to suggest modifications. When one comes up,
say you cannot help with that and point them to a doctor or physiotherapist,
then offer to help with something you can: programming, technique, scheduling,
consistency or general nutrition.
`.trim();

export function getSystemPrompt() {
  const scope = STRICTNESS === 'general_wellness'
    ? GENERAL_WELLNESS_RULES
    : FULL_SCOPE_RULES;
  return `${SHARED_RULES}\n\n${scope}`;
}

/// The seam for a stricter input classifier.
///
/// A no-op today by design: adding one now, with nothing to compare it
/// against, would be guessing. It exists so that dropping one in later is a
/// change to one function rather than a hunt through the request path for the
/// right place to put it.
///
/// Returns null to allow, or a string to refuse with.
export function classifyMessage(_text) {
  return null;
}

/// The disclaimer the user agrees to before their first message, and the
/// standing footer the UI keeps visible afterwards. Served from here so the
/// wording and the version that gates it can never drift apart.
export const DISCLAIMER = {
  version: CURRENT_POLICY_VERSION,
  title: 'Before we start',
  body: [
    'This is an AI assistant, not a doctor, physiotherapist or dietitian. It can be wrong.',
    'It reads your Phool Gobhi training history — your check-ins, workouts and goals — to make its answers specific to you.',
    'Do not rely on it for medical decisions. If something hurts, is getting worse, or worries you, see a qualified professional.',
    'If you think you are having a medical emergency, contact emergency services.',
  ],
  acceptLabel: 'I understand',
};
