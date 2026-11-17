// Keep the endpoint and response shape for released customer apps, which hide
// suggestion chips when this list is empty. Suggestions are disabled globally:
// do not read conversation history or send drafts to the AI provider here.
export async function getSuggestionsService(userId, { conversationId, draft = '' } = {}) {
  if (typeof draft !== 'string' || draft.length > 2000) {
    throw { status: 400, error: 'Draft must be text of at most 2000 characters' };
  }
  if (conversationId != null && (!Number.isSafeInteger(conversationId) || conversationId <= 0)) {
    throw { status: 400, error: 'Invalid conversation id' };
  }
  return { suggestions: [] };
}
