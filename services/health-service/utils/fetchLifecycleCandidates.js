import axios from 'axios';
import { googleIdTokenHeader } from './googleIdToken.js';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();

const PAGE = 250;
// 40 pages x 250 = 10,000 recent signups. A sweep that needs more than this
// should become a SQL job, not a longer loop.
const MAX_PAGES = 40;

/// Recent customers with onboarding / push-token flags, from auth-service's
/// `POST /internal/lifecycle-candidates` (no tokens, only `hasToken`).
///
/// Best-effort like every other cross-service read in the nudge path: an
/// unreachable auth-service yields an empty list (no lifecycle nudges this
/// run), never an exception that would take the existing nudges down with it.
export async function fetchLifecycleCandidates({ createdBefore, maxAgeDays = 90 } = {}) {
  const out = [];
  try {
    let after = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await axios.post(
        `${AUTH_SERVICE_URL}/internal/lifecycle-candidates`,
        { after, limit: PAGE, maxAgeDays, createdBefore: createdBefore?.toISOString() },
        {
          headers: {
            'x-internal-key': INTERNAL_API_KEY,
            ...(await googleIdTokenHeader(AUTH_SERVICE_URL)),
          },
          timeout: 8000,
        },
      );
      const rows = res.data?.data ?? [];
      out.push(...rows);
      if (rows.length < PAGE) break;
      after = rows[rows.length - 1].id;
    }
  } catch (err) {
    console.error('[auth-service] fetchLifecycleCandidates failed:', err.message);
    return [];
  }
  return out;
}
