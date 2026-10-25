# Backend and cloud remediation, 25 October 2026

## Completed

- Two enabled HTTPS gateway uptime checks, five checker locations each, at five-minute intervals.
- Six enabled alert policies, routed to the requested `officialrohitashwa@gmail.com` email channel.
- [Backend operations dashboard](https://console.cloud.google.com/monitoring/dashboards/builder/575e58f7-226d-45ec-918a-0ba72f568464?project=phool-gobhi).
- Deployment manifest and live configuration agree across every service/environment. Production Firebase OTP is retained and dev OTP is disabled.
- The daily briefing scheduler now has OIDC authentication and an invoker account scoped to booking-service-dev. A temporary scheduler-to-health probe passed and was removed. No briefing was manually sent.
- Both application databases connected over TLS. Seven service schemas were present, with no unfinished migration, idle transaction or query older than 30 seconds during inspection.
- [Full backup/restore drill](https://github.com/Jokerohit4/phool-gobhi-backend/actions/runs/40197772078) passed for dev (146 tables / 15,991 rows) and production (98 tables / 951 rows). Every table's snapshot content hash matched; source connections were read-only and temporary data was deleted.
- The accessible analytics Neon project has a six-hour recovery window. A branch restored from five minutes earlier connected successfully and was deleted after the test.
- The [strict Explore rehearsal](https://github.com/Jokerohit4/phool-gobhi-backend/actions/runs/40198394482) passed all 14 checks. A separately versioned prerequisite migration repairs the missing auth foundation; original migration SQL and existing history rows are preserved. The independent [dev rerun](https://github.com/Jokerohit4/phool-gobhi-backend/actions/runs/40198557388) passed too.
- App configuration reads now run in parallel; plan construction reuses one layer/consent snapshot. Auth and health suites passed locally (903 and 1,653 tests respectively; 23 database tests skipped locally), and the [deployment CI](https://github.com/Jokerohit4/phool-gobhi-backend/actions/runs/40198557288) passed its unit and database integration checks.
- After deployment, dev's synthetic Today Plan returned HTTP 200 with an active plan: 6.51 seconds on the first probe, 1.54 seconds warm. This demonstrates remaining cold-path latency; it does not establish a load-test result or a new production percentile.
- Live auth/configuration, booking and subscription reads passed in both environments; missing authentication returned 401. Dev's Health Profile read passed too.

## Outstanding verification and release scope

- The application database project's recovery-window configuration is not yet visible to the authenticated Neon account. The current session identifies as `officialrohitashwa@gmail.com`; the application project owner was identified as `rohitashwaofficial@gmail.com`. The owner-account sign-in is pending. The successful full logical restore drills above do not prove that project's PITR retention.
- Production's newer `/api/health/health-profile` route returns 404. Its product rollout and relevant schema/code compatibility need validation before it can be counted as a working production journey. Core production auth, booking and subscription reads passed.
- Health-service Redis is intentionally unconfigured in both environments; the optional cache fallback is active. No managed Redis deployment was introduced.
- The actual briefing fan-out's next scheduled execution remains the delivery check. Its OIDC health probe and internal credential comparison passed without sending notifications.

The operational procedures are in [deploy/OPERATIONS.md](../deploy/OPERATIONS.md).
