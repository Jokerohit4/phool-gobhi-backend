---
description: Break-glass manual deploy of one Phool Gobhi backend service to Cloud Run (dev or prod), with guardrails.
argument-hint: <service> <dev|prod>
allowed-tools: Bash(gcloud:*), Bash(git:*), Bash(curl:*), Bash(grep:*), Bash(node:*), Read
---

**Automated deploys now run via `.github/workflows/deploy.yml` on every push to `dev`/`main`**,
driven by `deploy/services.json` (only services with changed files get redeployed). Use this
manual command only for break-glass: testing a feature branch before merge, investigating a
bad deploy, or if GitHub Actions/Workload Identity Federation is down. See `deploy/README.md`
for the manifest schema.

Deploy a single backend service to Google Cloud Run. Arguments: `$ARGUMENTS`
(expected: `<service> <dev|prod>`).

## Verified topology

- **Single project:** `phool-gobhi` · **Region:** `asia-south1`
- **Services are suffixed by env:** the real Cloud Run service name is `<service>-<env>` (e.g. `gateway-prod`, `auth-service-dev`). Deploying an *unsuffixed* name creates a NEW broken service — never do that.
- **Source dir:** `gateway` → repo root `.`; every other service → `services/<service>`.
- Valid services: `gateway`, `auth-service`, `gym-service`, `wallet-service`, `booking-service`, `buddy-service`.

## Steps

0. **Analytics event drift check (hard gate).** Run `node scripts/check-analytics-events.cjs` from the repo root. If it exits non-zero (drift found — an event name used in code isn't in `docs/analytics-events.json`), STOP and report the drift; do not deploy until the registry is updated or the code fixed. This exists because a shipped event was silently renamed on 2026-07-22 with nothing to catch it before it broke a live funnel — don't bypass this gate.

1. **Parse & validate args.** If service or env is missing/invalid, stop and show usage. Env must be `dev` or `prod`.

2. **Branch sanity check.** Run `git branch --show-current`. Convention: `dev` env should deploy from branch `dev`, `prod` from `main`. If they don't match, warn the user and ask before continuing (do not auto-proceed).

3. **gym-service footgun guard.** If service is `gym-service`, read `services/gym-service/app.js` (or `index.js`) and confirm the `/health` route is registered BEFORE `app.use('/', gymRoutes)`. If `/health` comes after the router, STOP — the router swallows it and Cloud Run healthchecks fail (this bit us before, fix `3b3def4`). Report the line numbers.

4. **prod confirmation.** If env is `prod`, print exactly what will run and ask the user to confirm before deploying. Never deploy prod without an explicit "yes" in this session.

5. **Deploy** (source-based build, no manual docker step needed). Env vars/secrets come from
   `deploy/services.json` — the same manifest the automated pipeline uses — via
   `deploy/scripts/build-deploy-flags.cjs`, so this manual path can never silently diverge
   from what CI would deploy:
   ```
   node deploy/scripts/build-deploy-flags.cjs <service> <env>
   # -> prints env-vars=... and secrets=... flag values

   gcloud run deploy <service>-<env> \
     --source <source-dir> \
     --project phool-gobhi \
     --region asia-south1 \
     --allow-unauthenticated \
     --quiet \
     --set-env-vars="<env-vars value from above>" \
     --set-secrets="<secrets value from above>"
   ```

6. **Verify.** Get the URL with
   `gcloud run services describe <service>-<env> --project phool-gobhi --region asia-south1 --format="value(status.url)"`
   then `curl -s -o /dev/null -w "%{http_code}" <url>/health` and report the status code. Non-200 → surface the last deploy logs.

7. **Report** the deployed revision, URL, and health result concisely.
