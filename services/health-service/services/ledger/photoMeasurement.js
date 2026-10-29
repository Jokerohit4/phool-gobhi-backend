// Null means unavailable, including on requests whose billing outcome is unknown.
export function geminiUsage(body, model) {
 const u = body?.usageMetadata;
 return { model: body?.modelVersion || model, tokensIn: u?.promptTokenCount ?? null,
 tokensOut: u?.candidatesTokenCount ?? null, thinkingTokens: u?.thoughtsTokenCount ?? null,
 totalTokens: u?.totalTokenCount ?? null, cachedTokens: u?.cachedContentTokenCount ?? null };
}
export function priceUsage(usage, pricing) {
 if (!pricing || ['input','output','cachedInput'].some(k=>typeof pricing[k] !== 'number' || !Number.isFinite(pricing[k]) || pricing[k]<0) || usage.tokensIn == null || usage.tokensOut == null || usage.thinkingTokens == null || usage.cachedTokens == null) return null;
 return ((usage.tokensIn - usage.cachedTokens) * pricing.input + usage.cachedTokens * pricing.cachedInput +
 (usage.tokensOut + usage.thinkingTokens) * pricing.output) / 1e6;
}
export async function measuredCall(prisma, userId, stage, call) {
 const start = Date.now(); let result; let error;
 try { result = await call(); return result; } catch (e) { error = e; throw e; }
 finally {
 const u = result || error?.usage || {};
 await prisma.foodPhotoUsage.create({ data: { userId, stage, outcome: error ? 'error' : result?.isFood === false ? 'no_food' : 'ok',
 latencyMs: Date.now()-start, model: u.model ?? null, tokensIn: u.tokensIn ?? null,
 tokensOut: u.tokensOut ?? null, thinkingTokens: u.thinkingTokens ?? null,
 totalTokens: u.totalTokens ?? null, cachedTokens: u.cachedTokens ?? null } });
 }
}
