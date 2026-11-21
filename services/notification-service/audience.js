import { GoogleAuth } from 'google-auth-library';

const base = (process.env.AUTH_SERVICE_URL || 'http://auth-service:5001').replace(/\/$/, '');
const google = process.env.K_SERVICE ? new GoogleAuth() : null;
let client;

export async function customers(filter) {
  const headers = { 'Content-Type': 'application/json', 'x-internal-key': (process.env.INTERNAL_API_KEY || '').trim() };
  if (google) {
    client ??= google.getIdTokenClient(base).catch(error => {
      client = null;
      throw error;
    });
    const authHeaders = await (await client).getRequestHeaders(base);
    headers.Authorization = authHeaders.get('authorization');
  }
  const response = await fetch(base + '/internal/notification-customers', {
    method: 'POST', headers, body: JSON.stringify(filter), signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('Auth audience lookup failed (' + response.status + ')');
  return (await response.json()).data;
}
