# Shared entrance QR — dev rollout

Status: implemented locally; **not deployed**, and not exercised against a live
dev environment.

## Entry URLs — unchanged, printed posters keep working

- Gym 2 poster: `https://dev.phoolgobhi.com/checkin/2`
- Android/iOS dev app handoff: `phoolgobhidev://checkin?gymId=2`
- Partner page: `https://dev.partner.phoolgobhi.com/gym?gymId=2`
- Owner approval queue: `https://dev.partner.phoolgobhi.com/members?gymId=2`

The QR encodes only `<website>/checkin/<gymId>`. Nothing about that URL, the poster
generator, or the app deep links changed, so every poster already downloaded and
put up keeps working with no reprint. All behaviour below lives behind that URL.

The partner's dev hostname forces the dev poster URL even if an inherited
website URL setting points to production. The website selects the dev app
scheme from its dev hostname. The app rejects entrance links for the opposite
environment and persists a scan across login.

## Why joining needs the owner

A linked member is billable to the gym (₹1 per member per month, from
`countGymJoinedUsersByMonthService`), gets attendance without paying per session,
and feeds the streak/coin signals. So a join must not be free for anyone who can
spoof a location near a public poster. **By default the gym approves each join.**
The owner can open a time-boxed window for moments like launch day.

## Server behavior

One poster, three behaviours, all decided by the server in
`POST /api/bookings/gym/:gymId/entrance-checkin` (authenticated customer):

1. **Customer has a usable booking** → booking check-in, with the existing
   location, early-confirmation and session rules. Creates no link.
2. **Customer is an approved member** → member attendance (idempotent per day).
3. **Neither** → `403 MEMBERSHIP_REQUIRED`. The client asks the customer to confirm
   ("Request to join") and re-sends with `join: true`. The server then proves
   presence (inside the 50 m geofence) and asks auth-service to link them:
   - **owner's window open** → approved on the spot, attendance recorded in the
     same request (`joined: true`);
   - **otherwise** → a pending request is created, the owner gets a push, and the
     answer is `403 MEMBERSHIP_PENDING`. No attendance, no billable membership.

A scan without `join` never links anyone, so a pay-per-session guest who scans the
poster does not silently become a member. Someone with a booking (even one that is
not usable right now) is treated as a guest, not offered membership. A customer
who already has a pending request gets `MEMBERSHIP_PENDING` on later scans (a
"waiting" state, not another join prompt).

`join` is handled by auth-service `POST /internal/gym-links/qr-join`
(`joinGymViaQr`), which owns every link rule. The link is always an ordinary
`self` link — a window only approves it on the spot — so billing treats it the same
as an owner-approved one (billable after approval and first verified check-in).

- linked to a different gym → `409 ALREADY_LINKED` (first link wins);
- removed or declined by this gym → `403 MEMBERSHIP_BLOCKED` — a scan can never
  undo the owner's decision, window or not (someone who left voluntarily can ask
  to rejoin);
- existing self-link limits still apply (`SELF_LINK_LIMIT`: one per 30 days, three
  per device);
- gym missing or not approved → `404 GYM_UNAVAILABLE`.

### Guests with a booking

Someone who holds a live booking at the gym (awaiting confirmation, confirmed, or in
progress, for today or a later day) is a **guest**, and a poster scan never raises a
membership request for them, whether or not the booking is usable right now. This is
enforced on the server in the entrance check-in, so it holds even if a client asks to
join. A guest whose booking is for another time gets `409 UPCOMING_BOOKING` with the
soonest booking attached (`date`, `startTime`, `endTime`, `status`, `daysFromToday`) and
a plain sentence in `error`, e.g. "Your session is tomorrow at 7:00 PM." Cancelled and
completed bookings do not count, and neither does a booking at another gym.

Someone who has already asked to join is left to run their request. A brand-new account
cannot hold a booking, so the app links only brand-new accounts at login (to skip the
onboarding questions the link answers); everyone else's scan is settled here.

### The owner's window

Table `auth.GymJoinWindow` (migration `20261111000000_gym_join_window`), one row
per gym, `autoApproveUntil`. Partner-only, ownership-checked:

- `GET /api/auth/gym/:gymId/join-window` → `{ data: { active, autoApproveUntil } }`
- `PUT /api/auth/gym/:gymId/join-window { hours: 0|1|8|24 }` →
  `{ data: { active, autoApproveUntil, approvedCount } }`. `0` closes it. Opening
  **also approves every request already in the queue**, and those customers get a
  push. Closing never un-approves anyone who joined during the window.

Owner pushes: a *new* pending request sends "New member request"
(`gym_link_request`, unchanged). Joins approved by an open window send nothing —
one push per member on onboarding day would be noise, and the owner chose it.
Customer push: `gym_link_approved` ("You're in at <gym>") when the gym approves a
request or opens a window over it.

### Waiting for approval

The web check-in page and the app keep a "waiting for the gym" screen up for about
five minutes, polling `/me` (`gymLinkStatus` + `linkedGymId`) every five seconds,
and finish the check-in by themselves the moment the gym approves. After that the
push notification brings the member back.

### Paths with no proof of presence — unchanged

The legacy join-by-URL / profile / login paths and
`POST /api/auth/gym-links/entrance-request` (kept for already-installed builds and
cached pages) still create **pending** requests the owner approves in the Members
queue. Existing `gym_qr` memberships remain approved.

### Known limits

Coordinates are client-reported (the same trust the booking check-in already places
in them) and the poster URL is static and guessable (`/checkin/<gymId>`). While a
window is open, a photo of the poster plus a spoofed location could join someone
remotely — the owner opted in, can remove the member, and nothing is billed until
the member's first verified check-in. A per-gym signed/rotatable token in the QR is
the next hardening step if that becomes a problem (it would need a reprint, so it
is deliberately not done). Indoor GPS can miss the 50 m geofence ("move closer").

## Compatibility

- **Old QR posters:** unchanged URL, see above.
- **Older website page / app builds with the new backend:** they never send `join`;
  they use the unchanged `entrance-request` endpoint and handle
  `MEMBERSHIP_REQUIRED` / `MEMBERSHIP_PENDING`, so they keep working.
- **Older partner app / partner web with the new backend:** they only use the
  unchanged queue endpoints; they simply lack the window control.
- **New clients with the old backend:** deploy the backend first. An old backend
  ignores `join` and would answer `MEMBERSHIP_REQUIRED` again.

## Deployment order (dev only)

1. Apply the auth-service migration `20261111000000_gym_join_window` (new table
   only, additive). It is hand-authored: reconcile against dev before applying.
2. Deploy auth-service-dev **first**: it adds `/internal/gym-links/qr-join` and the
   `join-window` endpoints. Verify its internal profile includes the server-derived
   `gymLinkStatus`.
3. Deploy booking-service-dev with the new entrance route (`join`) and approval guard.
4. Deploy the website's dev build to dev.phoolgobhi.com, with the dev gateway
   and dev cookie settings. Deploy partner web to dev.partner.phoolgobhi.com.
5. Build/install the updated customer **dev** app and partner **dev** app. An
   already-installed older binary does not acquire the new UI from a backend
   deployment alone.
6. Test gym 2 with isolated dev users: booked visitor; approved member; stranger
   who requests to join with the window **closed** (pending, owner push, no
   attendance, no bill) and then is approved (waiting screen finishes the check-in,
   customer push arrives); stranger with the window **open** (instant); window
   opened over an existing queue (all approved, pushes sent); stranger who declines
   the prompt (must stay unlinked); visitor outside 50 m (must link nobody);
   member of another gym (`ALREADY_LINKED`); a member the owner removed
   (`MEMBERSHIP_BLOCKED`, even with the window open); duplicate scan; and signed-out
   scan followed by login. Confirm only the gym owner can change the window.

Use the existing backend deployment manifest/workflow, preserving private service
IAM. No production promotion is required. Several repositories contain unrelated
local changes; stage and review this feature's changes explicitly instead of
publishing the entire dirty working directory.

## Local validation

Run the backend suites with `node --experimental-test-module-mocks --test`
(several files mock modules and fail without the flag).

See the final report for current numbers. Not run: the website production build,
and nothing has been exercised against a live dev deployment. No screen has been
looked at on a device or in a browser.
