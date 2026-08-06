# `deploy/services.json`

Declarative source of truth for what each Cloud Run service deploys with. Replaces the
previous behavior of `gcloud run deploy --source` silently carrying forward whatever
env vars/secrets happened to be set manually on the last revision.

Both `.github/workflows/deploy.yml` (automated) and `.claude/commands/deploy.md` (manual
break-glass) read this same file via `deploy/scripts/build-deploy-flags.js`, so the two
paths can't silently diverge.

## Schema

```
services.<name>.cloudRunServiceBaseName   Cloud Run service name minus the -dev/-prod suffix
services.<name>.sourceDir                 passed to `gcloud run deploy --source`
services.<name>.hasPrisma                 gates the `prisma migrate deploy` CI step
services.<name>.healthCheckGuard          gates the gym-service /health-before-router CI guard
services.<name>.pathTriggers              glob(s) that mark this service "changed" for CI path-filtering
services.<name>.env.<dev|prod>.plain      literal --set-env-vars entries
services.<name>.env.<dev|prod>.secrets    ENV_VAR_NAME -> Secret Manager *base* name
                                           (workflow appends -dev/-prod and :latest)
```

Content was transcribed from live `gcloud run services describe --format="yaml(spec.template.spec.containers[0].env)"`
output for all 12 services on 2026-07-23, not guessed. Known, deliberately-preserved
asymmetries between dev/prod (not bugs to "fix" here, just documented so they aren't
mistaken for transcription errors):

- **Prod analytics rollout (2026-07-23):** all six services now carry `ANALYTICS_PROVIDER=postgres`
  in prod, same as dev — but pointed at a **separate, dedicated** Neon DB (secret base name
  `analytics-database-url`, not `db-url`), not the shared dev/booking DB dev still uses. Deliberate:
  prod analytics traffic never touches the real transactional booking DB.
- **wallet-service**: prod was missing `GYM_SERVICE_URL` until 2026-08-06 — harmless while
  wallet-service had no code path calling gym-service, but `purchaseSubscriptionWithWallet`
  (shipped 2026-08-03) needs it to look up gym plan pricing, and its `fetchGymForSubscription`
  catch-block masks the resulting connection failure as a false "Gym not found" 404. Added
  here and applied live to match. If wallet-service ever grows another gym-service call, this
  is where the URL already is.

## URL format standardization

Live inter-service URLs (`AUTH_SERVICE_URL`, `GYM_SERVICE_URL`, etc.) were a mix of two
formats for the same Cloud Run service: the legacy project-number-based domain
(`https://<service>-1077801427223.asia-south1.run.app`) and the current default
hash-based domain (`https://<service>-pwixdiy6va-el.a.run.app`, what `gcloud run
services describe --format="value(status.url)"` reports as the service's canonical
`status.url`). Both were confirmed live and returning 200 on `/health` before writing
this manifest — they're interchangeable aliases for the same service, not a functional
difference — so every inter-service URL here is standardized on the canonical hash-based
form. The first CI deploy of most services will therefore update a handful of plain env
vars to match; this is a cosmetic normalization, not a behavior change.

## One resolved discrepancy

`buddy-service`'s `FIREBASE_SERVICE_ACCOUNT_JSON` previously pointed at different secret
families per env (dev → `firebase-booking-dev`, prod → `firebase-auth-prod`). Investigated
by comparing `project_id`/`client_email` across all four `firebase-*` secrets — they all
resolve to the same Firebase service account (`firebase-adminsdk-fbsvc@phool-gobhi.iam.gserviceaccount.com`),
so this was a naming inconsistency, not a functional bug. Standardized on `firebase-booking`
for both envs here. The first CI deploy of `buddy-service-prod` after this manifest lands
will therefore repoint that one secret reference (zero behavior change, since the underlying
credential is identical).
