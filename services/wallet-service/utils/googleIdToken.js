import { GoogleAuth } from 'google-auth-library';

// Cloud Run sets K_SERVICE automatically on every revision; it's unset in
// local dev / docker-compose, so this whole mechanism no-ops there — outbound
// calls carry no Authorization override, identical to behavior before this
// file existed.
const onCloudRun = !!process.env.K_SERVICE;

const auth = onCloudRun ? new GoogleAuth() : null;
const clientPromisesByAudience = new Map();
const tokenCacheByAudience = new Map(); // audience -> { token, expiresAtMs }

function getClient(audience) {
  if (!clientPromisesByAudience.has(audience)) {
    clientPromisesByAudience.set(audience, auth.getIdTokenClient(audience));
  }
  return clientPromisesByAudience.get(audience);
}

// Decodes (without verifying — we trust our own freshly-minted token) the
// `exp` claim so we know exactly when to refresh, rather than guessing a
// fixed TTL.
function expiryMs(idToken) {
  const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
  return payload.exp * 1000;
}

async function getIdToken(audience) {
  const cached = tokenCacheByAudience.get(audience);
  if (cached && cached.expiresAtMs > Date.now() + 60_000) {
    return cached.token;
  }
  const client = await getClient(audience);
  const token = await client.idTokenProvider.fetchIdToken(audience);
  tokenCacheByAudience.set(audience, { token, expiresAtMs: expiryMs(token) });
  return token;
}

// Returns { Authorization: 'Bearer <token>' } scoped to `audience` (the
// target service's own base URL) — this is what lets the target's Cloud Run
// IAM invoker check confirm the call genuinely comes from this service's
// account, now that the target no longer allows anonymous (allUsers) access.
// Returns {} when not running on Cloud Run.
export async function googleIdTokenHeader(audience) {
  if (!onCloudRun) return {};
  const token = await getIdToken(audience);
  return { Authorization: `Bearer ${token}` };
}
