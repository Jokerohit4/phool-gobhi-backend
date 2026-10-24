# E8 Queue Diagnostics Backend Handoff

Date: 2026-10-24
Worktree: C:\Users\rohit\Phool-Gobhi\wt\backend-queue-diagnostics
Branch: feature/explore-queue-diagnostic-registry
Base commit: 22259ad636e00670aa3ba7278003b9d6fd7833a0

## Accepted event names

Two client-ingested analytics events are now registered in `docs/analytics-events.json` and therefore permitted by the gateway `/api/events` allowlist:

- `explore_pickup_queue_issue`
- `explore_pickup_queue_resolved`

Both are `source: client`, `apps: ["phool_gobhi"]`, `since: 2026-10-24`.

No other queue-diagnostic names are accepted. Registration follows the existing client/app pattern used for `explore_*` events.

## Client ingestion route

Gateway ingestion path is unchanged.

- Route: `POST /api/events`
- File: `index.js` line 205
- Allowlist built at lines 26-30 from `analytics-events.json` entries where `source === 'client'` and key does not start with `$`.
- Handler: `utils/analytics.js` `ingest`
- Client events are validated against name allowlist only; property schema enforcement is not performed by the gateway.

## Standard metadata added by pipeline

The analytics pipeline adds common identity/device/request metadata to every ingested event. The exact fields are defined by `utils/analytics.js` and the first-party Postgres sink, not by this handoff.

- `app`, `platform`, `session_id`, `user_agent`, etc., are appended server-side.
- The client must not send proof, coordinates, IDs, free-text, entry_source, world_state, or raw elapsed values.

## Identity override / validation

- Events are accepted only from authenticated sessions via the gateway's Bearer token verification in `index.js`.
- The gateway strips `x-user-*` and `x-internal-key` headers before proxying.
- Identity override is not supported for client events; the user identity is derived from the validated JWT.
- Validation limitations:
  - Gateway enforces name allowlist only.
  - Property schema validation for the seven-field diagnostic contract is client-side via `ExploreQueueDiagnosticSanitizer`.
  - Backend does not enforce the seven-field contract or cross-field rules.
  - No server-side rejection of malformed payloads beyond name check.

## Reset / retention / erasure behavior

Unresolved limitations:

- Analytics events are stored in the dedicated first-party Postgres analytics DB via `ANALYTICS_PROVIDER=postgres`.
- `ANALYTICS_DATABASE_URL` is present in service secrets; retention policies are not defined in this handoff.
- Account reset/erasure flows clear operational data via auth-service/wallet-service etc., but analytics event rows are not explicitly purged by the existing cleaners.
- No documented GDPR erasure hook for analytics events in the current backend.
- Event timestamps are set by ingestion time; client-supplied timestamps are not used.

## Registration evidence

- `docs/analytics-events.json` updated with `explore_pickup_queue_issue` and `explore_pickup_queue_resolved` entries.
- Both events appear in `CLIENT_EVENT_ALLOWLIST` after rebuild from `analytics-events.json`.
- Commit prepared in worktree `feature/explore-queue-diagnostic-registry`.

### Validation

Drift check `scripts/check-analytics-events.cjs`:
```
Loaded 201 known event names from docs/analytics-events.json
✓ No drift — every event name found in code is in the registry.
```

Diff `22259ad636e00670aa3ba7278003b9d6fd7833a0..702d634`:
```diff
diff --git a/docs/analytics-events.json b/docs/analytics-events.json
index 7a2cf39..3526079 100644
@@ -364,6 +364,18 @@
     "since": "2026-10-23",
     "notes": "E9: durable account outbox insertion; occurrence_kind and connectivity. No candidate ID, proof or saved claim."
   },
+  "explore_pickup_queue_issue": {
+    "source": "client",
+    "apps": ["phool_gobhi"],
+    "since": "2026-10-24",
+    "notes": "E9 queue diagnostic: client-side queue issue observation. Seven fields: measurement_version, occurrence_kind, queue_age_bucket, queue_age_basis, failure_reason, upload_attempts_bucket, phase (enqueue/pending). No IDs, proof, coordinates, free-text. Diagnostic only."
+  },
+  "explore_pickup_queue_resolved": {
+    "source": "client",
+    "apps": ["phool_gobhi"],
+    "since": "2026-10-24",
+    "notes": "E9 queue diagnostic: client-side queue resolution observation. Seven fields: measurement_version, occurrence_kind, queue_age_bucket, queue_age_basis, failure_reason, upload_attempts_bucket, resolution (receipt_observed/server_rejection_observed/client_terminal). No IDs, proof, coordinates, free-text. Diagnostic only."
+  },
   "explore_collection_viewed": {
     "source": "client",
     "apps": ["phool_gobhi"],
```

## References

- E9 contract: `C:\Users\rohit\Phool-Gobhi\wt\explore-e9-integration-review\lib\core\analytics\explore\QUEUE_DIAGNOSTICS_HANDOFF.md` at commit `f22298d`
- E5 implementation report: `C:\Users\rohit\Phool-Gobhi\wt\explore-e5-queue-diagnostics` commit `1127d6de9998163c8052a44b5cd3a4e57ad90326`
- Gateway allowlist logic: `index.js` lines 26-30, 205

No backend schema changes, migrations, sink timestamp columns, or receipt-service changes are included.
