# Notification service

The admin panel's **Push campaigns** page creates drafts, previews the saved app destination and push, sends a test to one customer, activates or pauses delivery, and shows recent run counts. Campaigns can target all eligible customers, account cohorts, or selected customer IDs. The service uses each active customer's existing FCM token. Title, subtitle, HTTPS image URL, and app deep link are supplied by the campaign. Supported paths and required IDs are listed in [the destination catalog](destinations.json).

- One-time and recurring campaigns use India Standard Time in the editor. A blank start queues the first run on activation. Recurring campaigns accept a repeat interval, maximum sends and optional end time. After a worker delay, the oldest due run advances to the next future slot without sending every missed repetition.
- Event campaigns start on activation or at their configured date. This release receives app open, gym viewed and booking started events from authenticated customer app sessions. Each campaign has a delay, cooldown, maximum sends per customer and optional end time. The cooldown starts when an event qualifies and a send is queued.
- Pause holds pending sends. If a paused campaign is edited before resuming, already queued campaign sends are discarded and future runs use the edited settings. A one-time run already in progress can be paused, resumed or cancelled. A delivery already submitted to FCM can still arrive after a pause or cancellation.
- The worker records FCM acceptance, known failures, missing tokens and uncertain outcomes. It leaves ambiguous delivery outcomes for review to avoid duplicate notifications. Image URLs should serve a public JPG, PNG or GIF directly, up to 1 MB, for Android and iOS compatibility.

## Local

Set `INTERNAL_API_KEY` and `FIREBASE_SERVICE_ACCOUNT_JSON` in the Compose environment and run `docker compose --profile notifications up --build`. Fresh Postgres volumes get `notificationdb` from `init-db.sql`. On an existing volume, create that database once or configure a dedicated existing database for this service. The service initializes its own schema and runs its worker every 30 seconds in Compose.

## Cloud Run

1. Provision a database for each environment and grant the service's database user schema and table creation rights. Create the consolidated `notification-service-secrets-dev` and `notification-service-secrets-prod` secrets with `DATABASE_URL`, the environment's existing `INTERNAL_API_KEY`, and `FIREBASE_SERVICE_ACCOUNT_JSON`. The Firebase credential must target the same Firebase project as that environment's customer app.
2. Deploy Auth, Notification and Gateway using [the deployment manifest](../../deploy/services.json). Grant the gateway and deployment service accounts Cloud Run Invoker on Notification. Grant the Notification runtime service account Cloud Run Invoker on Auth.
3. Give a dedicated scheduler service account Cloud Run Invoker on Notification, then create an HTTP Cloud Scheduler job per environment using the service's actual Cloud Run URL. The scheduler calls the private worker endpoint every minute.

   ```sh
   gcloud scheduler jobs create http "notification-delivery-$DEPLOY_ENV" \
     --project="$GCP_PROJECT_ID" --location=asia-south1 \
     --schedule='* * * * *' --time-zone=Etc/UTC \
     --uri="$NOTIFICATION_URL/internal/tick" --http-method=POST \
     --oidc-service-account-email="$NOTIFICATION_SCHEDULER_ACCOUNT" \
     --oidc-token-audience="$NOTIFICATION_URL" --attempt-deadline=120s
   ```

4. Deploy the admin panel and release an updated customer app. Include the iOS Notification Images extension in signing for both bundle IDs. Validate a targeted test push on Android and iOS in foreground, background and cold-start states before activating a campaign. Delivery depends on the worker's minute cadence and the customer's push permissions.

`npm test` runs campaign validation, scheduling and FCM payload checks.
