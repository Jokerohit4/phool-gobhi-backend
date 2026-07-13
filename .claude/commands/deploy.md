---
description: Deploy one Phool Gobhi backend service to Cloud Run (dev or prod), with guardrails.
argument-hint: <service> <dev|prod>
allowed-tools: Bash(gcloud:*), Bash(git:*), Bash(curl:*), Bash(grep:*), Read
---

Deploy a single backend service to Google Cloud Run. Arguments: `$ARGUMENTS`
(expected: `<service> <dev|prod>`).

## Verified topology (do NOT trust the stale `scripts/deploy-cloud-run.sh` or the `cloudbuild.*.yaml` comments — both assume separate projects and unsuffixed names, which is wrong)

- **Single project:** `phool-gobhi` · **Region:** `asia-south1`
- **Services are suffixed by env:** the real Cloud Run service name is `<service>-<env>` (e.g. `gateway-prod`, `auth-service-dev`). Deploying an *unsuffixed* name creates a NEW broken service — never do that.
- **Source dir:** `gateway` → repo root `.`; every other service → `services/<service>`.
- Valid services: `gateway`, `auth-service`, `gym-service`, `wallet-service`, `booking-service`, `buddy-service`.

## Steps

1. **Parse & validate args.** If service or env is missing/invalid, stop and show usage. Env must be `dev` or `prod`.

2. **Branch sanity check.** Run `git branch --show-current`. Convention: `dev` env should deploy from branch `dev`, `prod` from `main`. If they don't match, warn the user and ask before continuing (do not auto-proceed).

3. **gym-service footgun guard.** If service is `gym-service`, read `services/gym-service/app.js` (or `index.js`) and confirm the `/health` route is registered BEFORE `app.use('/', gymRoutes)`. If `/health` comes after the router, STOP — the router swallows it and Cloud Run healthchecks fail (this bit us before, fix `3b3def4`). Report the line numbers.

4. **prod confirmation.** If env is `prod`, print exactly what will run and ask the user to confirm before deploying. Never deploy prod without an explicit "yes" in this session.

5. **Deploy** (source-based build, no manual docker step needed):
   ```
   gcloud run deploy <service>-<env> \
     --source <source-dir> \
     --project phool-gobhi \
     --region asia-south1 \
     --allow-unauthenticated \
     --quiet
   ```

6. **Verify.** Get the URL with
   `gcloud run services describe <service>-<env> --project phool-gobhi --region asia-south1 --format="value(status.url)"`
   then `curl -s -o /dev/null -w "%{http_code}" <url>/health` and report the status code. Non-200 → surface the last deploy logs.

7. **Report** the deployed revision, URL, and health result concisely.
