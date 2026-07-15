import { GoogleAuth } from 'google-auth-library';

// Cloud Run sets K_SERVICE automatically on every revision; it's unset in
// local dev / docker-compose, so this whole mechanism no-ops there and
// outbound proxy calls carry no Authorization override — identical to
// behavior before this file existed.
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

// Returns an express-http-proxy `proxyReqOptDecorator` that attaches a
// Google-signed ID token scoped to `audience` (the target service's own URL)
// as the outbound Authorization header. This is what lets Cloud Run's IAM
// invoker check verify the call genuinely comes from this gateway's service
// account, before the target service's own Express code ever runs.
//
// This overwrites whatever Authorization header the original client request
// carried (the app-level JWT) — safe, since no backend service reads that
// header; they only trust x-user-id/x-user-role/x-user-type, which
// authMiddleware already sets from the verified JWT before this decorator
// ever runs.
export function withGoogleIdToken(audience) {
  if (!onCloudRun) {
    return (proxyReqOpts) => proxyReqOpts;
  }
  return async (proxyReqOpts) => {
    const token = await getIdToken(audience);
    proxyReqOpts.headers['Authorization'] = `Bearer ${token}`;
    return proxyReqOpts;
  };
}
