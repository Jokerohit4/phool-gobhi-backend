// Account-cohort scoping for admin analytics.
//
// Cohorts (FRIENDS_AND_FAMILY, GENERATED_ACCOUNTS, TESTING_ACCOUNTS,
// UNKNOWN_USERS) live on auth-service's User table; events live in the
// analytics warehouse, a different store. Rather than copy cohorts into the
// warehouse, the reader asks auth-service for the ids of every account NOT at
// the default cohort (a small set) and filters events by distinct_id:
//
//   * a selection that includes UNKNOWN_USERS  -> EXCLUDE the ids of the
//     non-default cohorts that were not selected;
//   * a selection that excludes UNKNOWN_USERS  -> INCLUDE only the ids of the
//     selected cohorts.
//
// Either way the id list is short. It is also retroactive: re-tagging a user
// re-segments all of their past events.
//
// Anonymous (pre-login) ids are never in a cohort, so they count as
// UNKNOWN_USERS. Where a report stitches anonymous ids to the user (Traffic),
// the filter is applied to the stitched identity.
import axios from 'axios';
import './axiosDefaults.js';
import { googleIdTokenHeader } from './googleIdToken.js';

export const ALL_COHORTS = ['FRIENDS_AND_FAMILY', 'GENERATED_ACCOUNTS', 'TESTING_ACCOUNTS', 'UNKNOWN_USERS'];
const DEFAULT_COHORT = 'UNKNOWN_USERS';
const MAX_IDS = 20000;
const CACHE_MS = 60_000;

let cache = null; // { at, data }

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

// 'all' / empty / every cohort -> null (no filtering). Otherwise a deduped,
// validated list. Anything unrecognised is a 400, never silently ignored: a
// typo must not turn into an unfiltered report that looks filtered.
export function parseCohortParam(raw) {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (text === '' || text.toLowerCase() === 'all') return null;
  const parts = [...new Set(text.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const bad = parts.filter((p) => !ALL_COHORTS.includes(p));
  if (bad.length || parts.length === 0) {
    throw fail(400, `cohort must be "all" or a comma list of: ${ALL_COHORTS.join(', ')}`);
  }
  return parts.length === ALL_COHORTS.length ? null : parts;
}

async function loadNonDefaultIds() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const base = process.env.AUTH_SERVICE_URL || 'http://auth-service:5001';
  try {
    const headers = {
      'x-internal-key': (process.env.INTERNAL_API_KEY || '').trim(),
      ...(await googleIdTokenHeader(base)),
    };
    const res = await axios.get(`${base}/internal/account-cohorts`, { headers, timeout: 8000 });
    const data = res.data?.data;
    if (!data || typeof data !== 'object') throw new Error('bad payload');
    cache = { at: Date.now(), data };
    return data;
  } catch {
    // Never fall back to unfiltered numbers: a "filtered" report that is
    // really the whole population is worse than an error.
    throw fail(503, 'Cohort filter is unavailable right now');
  }
}

export function clearCohortCache() {
  cache = null;
}

// -> { mode: 'all' } | { mode: 'include'|'exclude', ids: string[], cohorts: string[] }
export async function resolveCohortScope(raw) {
  const selected = parseCohortParam(raw);
  if (!selected) return { mode: 'all' };
  const byCohort = await loadNonDefaultIds();
  const wantsDefault = selected.includes(DEFAULT_COHORT);
  const idsFor = (cohorts) => cohorts.flatMap((c) => byCohort[c] || []);
  const nonDefault = ALL_COHORTS.filter((c) => c !== DEFAULT_COHORT);
  const ids = wantsDefault
    ? idsFor(nonDefault.filter((c) => !selected.includes(c)))
    : idsFor(selected);
  if (ids.length > MAX_IDS) throw fail(400, 'That cohort is too large to filter on; narrow the selection');
  return { mode: wantsDefault ? 'exclude' : 'include', ids, cohorts: selected };
}

// Appends the filter to a parameterised query. `params` is the query's value
// array and is extended in place; the returned fragment starts with " AND" so
// it can follow any WHERE clause. Written with `= ANY($n)` because the
// BigQuery adapter (utils/bigQueryAnalytics.js) already rewrites that form.
export function cohortClause(scope, params, column = 'distinct_id') {
  if (!scope || scope.mode === 'all') return '';
  const idx = params.push(scope.ids);
  return scope.mode === 'include'
    ? ` AND ${column} = ANY($${idx})`
    : ` AND (${column} IS NULL OR NOT (${column} = ANY($${idx})))`;
}

// Label for a response echo, e.g. 'FRIENDS_AND_FAMILY,TESTING_ACCOUNTS'.
export function cohortLabelOf(scope) {
  return !scope || scope.mode === 'all' ? 'all' : scope.cohorts.join(',');
}
