# Shared entrance QR — dev rollout

Status: implemented locally; **not deployed**. This session cannot connect to
external HTTPS services or read the host's Google Cloud credential database.
GitHub authentication also fails. No production deployment was attempted.

## Entry URLs

- Gym 2 poster: `https://dev.phoolgobhi.com/checkin/2`
- Android/iOS dev app handoff: `phoolgobhidev://checkin?gymId=2`
- Partner page: `https://dev.partner.phoolgobhi.com/gym?gymId=2`
- Owner approval queue: `https://dev.partner.phoolgobhi.com/members?gymId=2`

The partner's dev hostname forces the dev poster URL even if an inherited
website URL setting points to production. The website selects the dev app
scheme from its dev hostname. The app rejects entrance links for the opposite
environment and persists a scan across login without gym-join attribution.

## Server behavior

`POST /api/bookings/gym/:gymId/entrance-checkin` uses the authenticated customer
ID. It tries the existing booking check-in first, preserving its location,
early-confirmation and session rules. A booking check-in creates no link.
When there is no usable booking, an approved member can record attendance.
Duplicate scans use the existing booking/member attendance idempotency.

An unlinked visitor receives `MEMBERSHIP_REQUIRED`; a pending request receives
`MEMBERSHIP_PENDING`. Neither records member attendance. The customer must
explicitly request approval with `POST /api/auth/gym-links/entrance-request`.
The server verifies the gym, enforces request limits, and stores a pending
`self` GymLink. The pending pointer supports the existing app's approval banner;
it does not grant attendance, roster visibility or billable membership.

The gym's owner approves or rejects through the existing partner Members queue.
The server enforces partner ownership. Already-linked customers cannot have
their gym replaced by a scan. Public legacy join/profile/login paths now also
create pending requests rather than granting QR membership approval.

Existing `gym_qr` memberships remain approved. Self-declared links require
explicit `approvedAt`, including those with a previous booked visit. Owners
must review those requests. A booked visit alone never proves membership.
Rejected requests cannot be repeated by scanning the public entrance poster.

## Deployment order (dev only)

1. Deploy auth-service-dev with the reviewed auth changes and verify its
   internal profile includes the server-derived `gymLinkStatus`.
2. Deploy booking-service-dev with the new entrance route and approval guard.
3. Deploy the website's dev build to dev.phoolgobhi.com, with the dev gateway
   and dev cookie settings. Deploy partner web to dev.partner.phoolgobhi.com.
4. Build/install the updated customer **dev** app. An already-installed older
   binary does not acquire new QR routing/UI just from a backend deployment.
5. Test gym 2 using isolated dev users: booked visitor; approved member;
   unlinked visitor; pending request; rejected request; duplicate scan; and
   signed-out scan followed by login. Verify only the gym owner can approve.
   Confirm a booking-only user remains unlinked and does not enter the roster.

Use the existing backend deployment manifest/workflow, preserving private
service IAM. No schema migration or production promotion is required. Several
repositories contain unrelated local changes; stage/review this feature's
changes explicitly instead of publishing the entire dirty working directory.

## Local validation

- Auth suite: 1,041 passed, eight skipped, including request approval and billing tests.
- Booking suite: 306 passed, one skipped, including entrance dispatch and
  member approval guards.
- Website: 282 passed; lint has zero errors (existing warnings). TypeScript
  passed before the attempted production build. The generated Next route types
  subsequently expose existing optional Request parameters in bookings/mine
  and wallet/transactions; the final full TypeScript check reports those errors.
- Partner web: 71 passed; TypeScript passes.
- App: formatting and targeted static analysis pass with no issues; additional
  QR environment/login and member-response parsing tests are included. Flutter tests/build cannot run because the SDK cache lockfile
  is outside this session's writable paths.
- Website production build attempted; Google Fonts fetches fail with network
  `EACCES`. Live URL/deployment verification remains outstanding.
