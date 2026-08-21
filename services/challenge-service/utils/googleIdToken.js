import { GoogleAuth } from 'google-auth-library';

// Cloud Run sets K_SERVICE automatically on every revision; it's unset in
// local dev / docker-compose, so this whole mechanism no-ops there — outbound
// calls carry no Authorization override, identical to behavior before this
// file existed. Copied verbatim from buddy-service's copy — deliberately
// duplicated per-service rather than shared, same convention as the rest of
// this backend's per-service utils.
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

export async function googleIdTokenHeader(audience) {
  if (!onCloudRun) return {};
  const token = await getIdToken(audience);
  return { Authorization: `Bearer ${token}` };
}
