import axios from 'axios';
import { googleIdTokenHeader } from './googleIdToken.js';

const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

/**
 * Generic internal service-to-service call with auth.
 * Services should pass their own base URL (e.g., AUTH_SERVICE_URL, BOOKING_SERVICE_URL).
 */
export async function fetchInternal(baseUrl, path, options = {}) {
  try {
    const res = await axios({
      method: options.method || 'GET',
      url: `${baseUrl}${path}`,
      headers: {
        'x-internal-key': INTERNAL_API_KEY,
        ...(await googleIdTokenHeader(baseUrl)),
        ...options.headers,
      },
      data: options.body,
      timeout: options.timeout || 4000,
    });
    return res;
  } catch (err) {
    console.error('[fetchInternal]', baseUrl, path, err.message);
    throw err;
  }
}