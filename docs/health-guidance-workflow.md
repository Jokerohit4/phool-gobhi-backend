# Report-first health guidance

## Flow

All customer sign-ins enter the optional report step when the `reportSubscription` flag is enabled (the `healthVault` toggle was retired and is always on). Continuing with or without a report opens the two guided plans; skipping plans continues new/incomplete profiles to onboarding and complete profiles to Today. Signup keeps a Back route to the report screen. A PDF/JPEG/PNG report is stored in the private medical bucket and read through Document AI. Only explicitly labelled identity and marker fields are proposed. A patient must confirm ownership and edit/confirm values before those values become a guidance profile or enter biometric history.

The free explanation comes before the two subscription plans. Skipping subscriptions continues onboarding with confirmed name/gender prefilled. Report age is not converted into a birthday. The current adult-profile requirement remains: an exact birthday is confirmed before paid checkout when missing, and reused in onboarding. Training preferences are never inferred from a report. Today and the free logging flows are unchanged.

Health links to confirmed reports, review status, clinician notes, agreed actions and follow-up. You (and legacy Profile) links to Your Coach: calls, questions, session balances, gym fulfillment and included panels. The existing assistant consent and accepted-plan flow is reused for an Indian meal routine; clinical clearance is required before the RED guided meal/workout entry is offered. No model output is represented as clinician approval.

## Data and authority

- Health owns report proposals, explicit reading consent, confirmed identity/markers, risk routing, care requests and clinician review records.
- Wallet owns provider orders, memberships, expiring add-on grants, fulfillment and refund state. Coaching payments never top up a wallet or purchase a marketplace gym subscription.
- The pilot `CoachingSubscription` model remains read-only legacy data. The migration preserves its membership balances and orders. Previously unpaid pilot checkouts are cancelled; a late capture is refunded. Legacy add-on balances get a documented one-time 30-day migration grace because the pilot did not record expiry.
- Prices come from the protected server-side coaching catalog. Initial Gurugram defaults are INR 449,900 / 1,199,900 / 149,900 paise; admins can publish new prices. Captured amount, currency, order ownership and HMAC signature are checked. Client success cannot grant entitlement.
- Webhook and callback settlement share a transaction and a per-user PostgreSQL advisory lock. Cancelled or duplicate captured plan orders are refunded. Provider refund receipts are recovered after interruption, and a lease prevents concurrent refund issuance.
- Initial plan validity is 30/90 days, with a fixed 72-hour refundable window. Plan validity and trainer add-on quantity/validity are editable; purchased snapshots determine settlement and expiry. Add-on grants are consumed in expiry order. Trial transition and expiry are resolved on reads; eligibility is always checked on writes.
- When panels are included, the baseline is available after 72 hours. The second is available on Day 90. Booking retries and staff session completion use stable idempotency identifiers. Staff cancellation restores a reserved lab credit once.
- RED guided form sessions require a recorded `CLEARED` review. Core exercise/food/water/mood logs remain accessible. Recording clinical review requires a current confirmed report, clinician name/registration, note, review outcome, staff identity and explicit attestation. Re-confirming unchanged values preserves review; changed details/markers invalidate it.
- Report attempts carry a token so a stalled worker cannot overwrite a later retry. Failed/stalled reads can be retried. Empty extraction is not a fabricated normal report: absent markers produce `UNSET`.

## Endpoints

All paths below are relative to their gateway service prefix.

| Health (`/api/health`) | Purpose |
| --- | --- |
| `GET /guidance/me` | Current confirmed profile, recent reports, requests |
| `POST /guidance/reports` | Multipart upload with `readConsent=true`; awaits reading |
| `GET /guidance/reports/:id` | Owned report proposals/status |
| `GET /guidance/reports/:id/link` | Short-lived owned report link |
| `POST /guidance/reports/:id/retry` | Failed or stalled owned report retry |
| `POST /guidance/reports/:id/confirm` | Explicit ownership, edited details and markers |
| `PATCH /guidance/me` | Concern and existing clinician advice |
| `POST /guidance/requests` | Coaching/doctor/dietitian/form requests or a question |
| `GET /guidance/admin` | Staff profile and care-request queue |
| `GET /guidance/admin/:userId/report-link` | Staff opens the current confirmed source report privately |
| `POST /guidance/admin/:userId/review` | Staff records a completed clinical review |
| `PATCH /guidance/admin/requests/:id` | Staff updates request fulfillment |

| Wallet (`/api/wallet`) | Purpose |
| --- | --- |
| `GET /coaching/mine` | Membership, balances, fulfillment and payment reconciliation |
| `POST /coaching/orders` | Fixed-product provider order |
| `POST /coaching/verify` | Owned captured-payment verification |
| `POST /coaching/refund` | Full original-source guarantee refund |
| `POST /coaching/labs` | Reserve a panel with a collection address |
| `GET /coaching/admin/fulfillment` | Staff paid-member queue with account name/phone |
| `POST /coaching/admin/fulfillment/:userId/sessions` | Idempotent completed-session consumption |
| `PATCH /coaching/admin/fulfillment/:userId/gym` | Founder-managed gym pass status |
| `PATCH /coaching/admin/requests/:id` | Fulfillment status / lab cancellation |

Service-to-service endpoints require both the shared internal key and Cloud Run invoker authentication. The existing signed `/api/wallet/webhooks/razorpay` dispatches coaching events to the coaching settler; `/api/wallet/coaching/webhook` is an alternate signed URL. The existing scheduled Razorpay reconciliation workflow also calls `/coaching/internal/reconcile`, including pending refunds and notification retries.

## Founder operations

The admin portal `/fulfillment` (`/admin/fulfillment` redirects there) requires a gobhi session on page reads and every server action. It manages paid users, gym pass status, collection requests, completed sessions, care-request status and external clinician review records. Gym passes, trainer availability and B2B laboratory bookings are founder-fulfilled. A coaching purchase does not silently change current booking pricing or invent a gym assignment/clinician appointment.

Collection/onboarding records are durable even if notification delivery fails. Configure `COACHING_FULFILLMENT_WEBHOOK_URL` and `COACHING_FULFILLMENT_WEBHOOK_SECRET` in the wallet secret JSON for founder notifications. The POST body is `{eventId,userId,kind}`; `x-coaching-signature` is its SHA-256 HMAC. Receivers must deduplicate `eventId`. No report, collection address or marker values are sent in this notification. Without a configured webhook, staff can fulfill the same requests from the protected queue.

## Rollout

1. Deploy wallet and health migrations (`wallet-service/prisma/migrations/20261117010100_wallet_coaching_tables` and `health-service/prisma/migrations/20261117010000_health_guidance`; the names must differ because services share one migration history table in dev). They add tables/columns and preserve pilot data; they do not run automatically from the client. Run `npm run db:deploy` in each service during the normal deployment pipeline.
2. Deploy wallet/health before the client. `deploy/services.json` adds the health-service URL to wallet; health already has wallet/auth URLs. Allow the existing service account to invoke these services.
3. Keep the existing private `MEDICAL_BUCKET_NAME`, ADC storage access, `GOOGLE_PROJECT_ID` and `GOOGLE_DOCUMENT_AI_PROCESSOR_ID` configured for health. The processor needs PDF/image OCR. No synthetic extraction fallback is used when OCR is unavailable.
4. Keep wallet's existing `RAZORPAY_KEY_ID`, `RAZORPAY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` configured. Register captured and authorized payment events on the signed webhook. Web checkout loads the provider's official checkout script; native checkout uses the installed Flutter package.
5. Deploy the founder portal and account-erasure fan-out after the wallet erasure endpoint exists. Wallet financial rows remain; coaching contact/collection details are redacted and fulfillment deactivated on hard account erasure. Health guidance data and requests participate in health erasure and account export. Deleting the source report also removes its current guidance review.
6. Enable the `reportSubscription` flag for the intended environment to expose report-first signup. Existing reading/deletion of owned guidance records is not conditioned on a paid plan. Existing coach/assistant feature flags retain their normal meanings.

This change does not deploy a real clinician/lab network. Signed review notes and appointment confirmations are recorded by authorized operations staff after fulfillment. New guidance copy is initially English; it uses the current app theme and existing core flows.

## Regional offers

- The paywall requests current location first, resolves the city and loads the matching offers automatically. Only denial, disabled/unavailable location or an unresolved city shows the manual support-city selector. `Gurugram` and `Gurgaon` resolve to `GURUGRAM`; other selected cities resolve to `REST_INDIA`. Granted location uses the detected city; denied/unavailable location uses the explicitly selected service city. Free continuation does not depend on permission.
- `GET /api/wallet/coaching/catalog?city=Gurugram` returns exactly two server-priced plans and their benefits. Gurugram retains INR 4,499 monthly / INR 11,999 for 90 days, gym access, two form sessions and the quarterly lab panels.
- Outside Gurugram offers remote coaching and meal guidance; the 90-day offer also includes remote clinical dietitian review and RED doctor clearance. Gym access, trainer floor sessions/add-ons and doorstep labs are excluded. No remote prices have been approved. Without configured prices these cards say pricing is to be announced and checkout is unavailable; free continuation remains available.
- Before the first catalog publication, `COACHING_REMOTE_MONTHLY_PRICE_PAISE` and `COACHING_REMOTE_QUARTERLY_PRICE_PAISE` can seed remote prices. Once a catalog is published, `/coaching-plans` is authoritative and environment changes do not override saved settings. No client amount is trusted.
- Plan checkout requires the selected `city` and catalog `offerId`. Changed prices or a quote for a different region are rejected before provider order creation. Switching regions cancels a previous unpaid order. Late captures use the existing refund path. Trainer add-on eligibility comes from the purchased membership, not the current city selection.
- The immutable order `offerSnapshot` is copied to the membership at settlement, so changing the catalog or the app's location does not rewrite purchased benefits or payment amounts. Empty legacy snapshots retain the original Gurugram benefits. Historical `MONTHLY_4499` / `QUARTERLY_11999` identifiers remain compatibility keys; display name, region and actual price come from the offer.
- Wallet membership responses include `region`, `service_city`, `benefits` and `offer`. The app and founder portal hide physical fulfillment for remote plans; wallet/health APIs independently reject gym, floor-session and lab fulfillment.
- Apply wallet migration `20261118010000_regional_coaching` after the original health-guidance migration and regenerate Prisma before deploying regional checkout. Deploy the backend before the updated app. No live migration or deployment was run locally.

- Location lookup uses authenticated `POST /api/gyms/places/city` with numeric `lat` and `lng`, through the existing gym-service Maps proxy. It returns only a locality name and uses no-store responses; the new handler does not persist raw coordinates or street addresses. Missing locality falls back to manual selection, rather than classifying a whole district as Gurugram city.
- The existing gym-service `GOOGLE_MAPS_API_KEY` must permit the [Google Geocoding API](https://developers.google.com/maps/documentation/geocoding/guides-v3/requests-reverse-geocoding). Enable that API/key restriction if needed and deploy gym-service alongside wallet-service before the location-first app. Provider/configuration failure falls back to manual selection.

## Offer explanations, human contact and report library

- Plan details describe the included visits, two introductory form sessions, weekly check-ins, food-log-connected meal routine, clinical review, 90-day lab timings and onboarding. The Gurugram venue is described only as a partner gym in Sector 45; trainer copy says qualified trainer. No gym/trainer identity or direct contact is published in the offer.
- Both explicit free-continuation buttons on the plans screen first offer an optional founder conversation at +91 93548 59197. Call and WhatsApp open only after the user taps; no message is sent automatically. Continue free and Back to plans remain available.
- Admin `/reports` lists every saved `HealthReport` (lab snapshots) and `MedicalDocument` with `kind=lab_report` (saved lab documents), independent of subscription, patient confirmation, or OCR status. The two sources have separate tabs, customer/status filters and cursor pagination of 50 rows, so older files remain accessible. Deleted files are not retained by the library.
- Staff-only `GET /api/health/guidance/admin/reports` accepts `source=snapshot|document`, optional `userId`, snapshot `status`, and `cursor`. List responses contain account identifiers and report metadata/proposals, never storage paths or signed URLs. Account-service failure leaves reports accessible by customer ID.
- Staff-only `GET /api/health/guidance/admin/reports/:source/:id/link` signs a saved report on demand. The protected admin proxy `/api/guidance/saved-report` redirects to that private file with no-store/no-referrer headers. The existing current-confirmed-source link for clinical review remains separate. No new schema migration is needed for this report-library feature.

## Configurable guided plans and offerings

Admin `/coaching-plans` edits each region separately with structured fields, while retaining two stable plan keys. Editable fields are title, summary, CTA, badge, featured state, sale availability, price, validity, gym inclusion/area/visits, trainer inclusion/free sessions, weekly check-ins, meal guidance, dietitian/RED-doctor inclusion, blood-panel credits, explanatory copy and post-signup instructions. Trainer add-on title, description, price, session quantity, validity and availability are editable too.

- `GET /api/wallet/coaching/admin/config` and `PUT /api/wallet/coaching/admin/config` require a gobhi staff role. Saves require `expectedVersion` and atomically append staff-attributed history. Stale editors receive 409 instead of overwriting another admin.
- `CoachingCatalogConfig` stores the published singleton and `CoachingCatalogConfigHistory` stores revisions. Before the first publication the original defaults are served; routine edits need no environment changes or app release after this implementation is deployed.
- Catalog and checkout read saved configuration directly, without process-local caching. Offer IDs cover price and terms; changed quotes are rejected. Already-created orders, active memberships, session grants and refund amounts keep their immutable purchase snapshots. Configuration changes never silently shorten a paid term or remove bought benefits.
- Both prices and descriptions are rendered from the server catalog. Your Coach reads clinical/meal inclusions, session totals and current trainer upsell terms rather than inferring them from the old price-bearing tier keys. Those keys remain internal compatibility identifiers.
- Guardrails: logging and report uploads stay free; guarantee stays 72 hours; outside-Gurugram plans stay guidance-only; form sessions and add-on grants allow up to 20 sessions per purchase. Lab plans allow zero, one or two panels: the first opens Day 4; a second stays reserved for Day 90 and requires at least 90 days of validity.
- Apply wallet migration `20261119010000_configurable_coaching` after `20261118010000_regional_coaching`, regenerate Prisma, then deploy wallet/health services, admin and the customer app. No live database migration or deployment was performed. The initial app update is necessary to adopt configurable descriptions; subsequent published edits are picked up by the app without releases.
