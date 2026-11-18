# Report-first health guidance

## Flow

New or incomplete customer sign-ins enter the optional report step when the existing `healthVault` flag is enabled. With no report they continue the existing onboarding. A PDF/JPEG/PNG report is stored in the private medical bucket and read through Document AI. Only explicitly labelled identity and marker fields are proposed. A patient must confirm ownership and edit/confirm values before those values become a guidance profile or enter biometric history.

The free explanation comes before the two subscription plans. Skipping subscriptions continues onboarding with confirmed name/gender prefilled. Report age is not converted into a birthday. The current adult-profile requirement remains: an exact birthday is confirmed before paid checkout when missing, and reused in onboarding. Training preferences are never inferred from a report. Today and the free logging flows are unchanged.

Health links to confirmed reports, review status, clinician notes, agreed actions and follow-up. You (and legacy Profile) links to Your Coach: calls, questions, session balances, gym fulfillment and included panels. The existing assistant consent and accepted-plan flow is reused for an Indian meal routine; clinical clearance is required before the RED guided meal/workout entry is offered. No model output is represented as clinician approval.

## Data and authority

- Health owns report proposals, explicit reading consent, confirmed identity/markers, risk routing, care requests and clinician review records.
- Wallet owns provider orders, memberships, expiring add-on grants, fulfillment and refund state. Coaching payments never top up a wallet or purchase a marketplace gym subscription.
- The pilot `CoachingSubscription` model remains read-only legacy data. The migration preserves its membership balances and orders. Previously unpaid pilot checkouts are cancelled; a late capture is refunded. Legacy add-on balances get a documented one-time 30-day migration grace because the pilot did not record expiry.
- Prices are fixed on the server: INR 449,900 / 1,199,900 / 149,900 paise. Captured amount, currency, order ownership and HMAC signature are checked. Client success cannot grant entitlement.
- Webhook and callback settlement share a transaction and a per-user PostgreSQL advisory lock. Cancelled or duplicate captured plan orders are refunded. Provider refund receipts are recovered after interruption, and a lease prevents concurrent refund issuance.
- Plan membership lasts 30/90 days, with a 72-hour refundable window. Add-on grants last 30 days and are consumed in expiry order. Trial transition and expiry are resolved on reads; eligibility is always checked on writes.
- The first quarterly panel is available after 72 hours. The second is available on Day 90. Booking retries and staff session completion use stable idempotency identifiers. Staff cancellation restores a reserved lab credit once.
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

1. Deploy wallet and health migrations from `prisma/migrations/20261117010000_health_guidance`. They add tables/columns and preserve pilot data; they do not run automatically from the client. Run `npm run db:deploy` in each service during the normal deployment pipeline.
2. Deploy wallet/health before the client. `deploy/services.json` adds the health-service URL to wallet; health already has wallet/auth URLs. Allow the existing service account to invoke these services.
3. Keep the existing private `MEDICAL_BUCKET_NAME`, ADC storage access, `GOOGLE_PROJECT_ID` and `GOOGLE_DOCUMENT_AI_PROCESSOR_ID` configured for health. The processor needs PDF/image OCR. No synthetic extraction fallback is used when OCR is unavailable.
4. Keep wallet's existing `RAZORPAY_KEY_ID`, `RAZORPAY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` configured. Register captured and authorized payment events on the signed webhook. Web checkout loads the provider's official checkout script; native checkout uses the installed Flutter package.
5. Deploy the founder portal and account-erasure fan-out after the wallet erasure endpoint exists. Wallet financial rows remain; coaching contact/collection details are redacted and fulfillment deactivated on hard account erasure. Health guidance data and requests participate in health erasure and account export. Deleting the source report also removes its current guidance review.
6. Enable the existing `healthVault` flag for the intended environment to expose report-first signup. Existing reading/deletion of owned guidance records is not conditioned on a paid plan. Existing coach/assistant feature flags retain their normal meanings.

This change does not deploy a real clinician/lab network. Signed review notes and appointment confirmations are recorded by authorized operations staff after fulfillment. New guidance copy is initially English; it uses the current app theme and existing core flows.
