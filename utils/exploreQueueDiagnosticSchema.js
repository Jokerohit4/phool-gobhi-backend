// Client observations only; identity is client supplied, never server truth.
export const QUEUE_DIAGNOSTIC_EVENTS = new Set([
  'explore_pickup_queue_issue', 'explore_pickup_queue_resolved',
]);

const values = (words) => new Set(words.split(' '));
const kinds = values('grid gym reviewed');
const ages = values('under_10s 10s_to_1m 1m_to_5m 5m_to_15m 15m_to_1h 1h_to_6h 6h_to_24h 24h_plus unknown');
const bases = values('monotonic wall_estimate unknown not_queued');
const failures = values('none offline_or_network timeout auth_paused rate_limited server_retryable binding_unavailable receipt_mismatch local_write_failed local_read_failed local_metadata_failed retry_budget_paused invalid_request idempotency_conflict upload_expired upload_expired_unconfirmed location_invalid timing_invalid unknown_occurrence other_terminal unknown');
const attempts = values('0 1 2_to_3 4_to_7 8_plus unknown');
const resolutions = values('receipt_observed server_rejection_observed client_terminal');
const common = ['measurement_version', 'occurrence_kind', 'queue_age_bucket', 'queue_age_basis', 'failure_reason', 'upload_attempts_bucket'];

export function validQueueDiagnostic(event, p) {
  if (!QUEUE_DIAGNOSTIC_EVENTS.has(event) || !p || typeof p !== 'object' || Array.isArray(p)) return false;
  const resolved = event === 'explore_pickup_queue_resolved';
  const keys = [...common, resolved ? 'resolution' : 'phase'];
  if (Object.keys(p).length !== keys.length || keys.some((key) => !Object.hasOwn(p, key))) return false;
  if (p.measurement_version !== 1 || (p.occurrence_kind !== null && !kinds.has(p.occurrence_kind)) ||
      !ages.has(p.queue_age_bucket) || !bases.has(p.queue_age_basis) ||
      !failures.has(p.failure_reason) || !attempts.has(p.upload_attempts_bucket)) return false;
  if ((p.queue_age_bucket === 'unknown') !== ['unknown', 'not_queued'].includes(p.queue_age_basis)) return false;
  if (resolved) {
    return resolutions.has(p.resolution) && p.queue_age_basis !== 'not_queued' &&
      ((p.resolution === 'receipt_observed') === (p.failure_reason === 'none'));
  }
  return ['enqueue', 'pending'].includes(p.phase) && p.failure_reason !== 'none' &&
    ((p.phase === 'enqueue') === (p.queue_age_basis === 'not_queued'));
}
