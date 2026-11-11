# Partner member profile

Status: implemented locally; **not deployed**, and not exercised against a live dev
environment.

A gym owner's view of one of their own members: who they are, what they have paid
and until when, the details the owner keeps (locker, number to call, ...), and when
the member actually trains.

## Three layers

1. **From the customer** (read-only, shared by being a member): name, photo, gender,
   age, fitness goals, training experience, member-since. **Never** their phone,
   email or exact date of birth. Only for an approved, active member of this gym —
   a pending request or a removed member has no profile (404), so this can never read
   people who are not the gym's members.
2. **From the owner** (`auth.GymMemberRecord`, one row per gym+member): phone to call,
   emergency contact, locker number, the gym's own join date, a follow-up date,
   balance due, notes. The phone is whatever the *owner* typed from their own records;
   it is not seeded from the customer, so the rule that partners never see a customer's
   phone is unchanged.
3. **Payments** (`auth.GymMemberPayment`, a ledger): amount, paid date, mode, plan,
   valid-until, note. Members renew, so each payment is its own row and nothing is
   overwritten. *Valid until* is the latest valid-until across the ledger, *current
   plan* is the plan on that entry, and *lifetime paid* is the sum. Status is
   `none` / `active` / `expiring_soon` (7 days or fewer) / `expired`.

Visit patterns are computed from real attendance by booking-service (below).

## Endpoints (all partner-only, ownership-checked, via the gateway)

auth-service:

- `GET    /api/auth/gym/:gymId/members/:userId/profile` →
  `{ customer, link, record, payments, summary, statedMembershipEndsOn }`
- `PATCH  /api/auth/gym/:gymId/members/:userId/record` — partial update of
  `phone, emergencyContactName, emergencyContactPhone, lockerNumber, joinedOn,
  followUpOn, amountDue, notes`; `null` or blank clears a field; unknown fields are
  rejected (`UNKNOWN_FIELD`). → `{ record }`
- `POST   /api/auth/gym/:gymId/members/:userId/payments` — `{ amount, paidOn,
  paymentMode?, planName?, validUntil?, note? }` → `201 { payment, summary }`
- `DELETE /api/auth/gym/:gymId/members/:userId/payments/:paymentId` → `{ summary }`
- `GET    /api/auth/gym/:gymId/members` (the existing roster) now also returns, for
  the partner view only and additively: `photoUrl, validUntil, membershipStatus,
  daysToExpiry, followUpOn, amountDue, lockerNumber`.

booking-service:

- `GET /api/bookings/gym/:gymId/members/:userId/visit-patterns?days=90` — usual
  hour (only with 3+ visits and a consistent habit), peak hour, 24-hour and weekday
  histograms, morning/afternoon/evening/night split, preferred days, an 8-week trend,
  last visit and days since, visits in the last 7/30 days, visits per week, average
  stay (from check-outs, when believable) and the 10 most recent visits. Only **this
  gym's** visits are read, never the customer's visits elsewhere; everything is in IST.

Validation: dates are real calendar dates; a paid date and join date cannot be in the
future; valid-until cannot precede the paid date or be more than 10 years out; money
is rupees with at most two decimals, stored in paise; phones are normalised
(`98765 43210` → `+919876543210`); text lengths are capped; at most 500 payments per
member.

## Privacy and data handling

- The customer is told before they ask to join that the gym will see their name,
  photo, gender, age, fitness goals and visit times, and never their phone or email.
- The profile shows the customer's **full name** to a gym that has approved them (the
  roster still shows first name only for self-linked members, as before). This is a
  deliberate choice: approval is the relationship. Reverse it in
  `getMemberProfile` if you disagree.
- Account deletion removes `GymMemberRecord` and `GymMemberPayment` for that user.
  **Not done:** including what gyms recorded about a customer in their data export, and
  letting a customer see it. Worth doing before a wide launch.
- Deliberately **not** collected: medical conditions or injuries (sensitive health data).

## Compatibility

New tables only and additive roster fields, so older partner builds keep working
unchanged; they simply do not show the profile.

## Deployment order (dev only)

1. Apply the auth migration `20261112000000_gym_member_record` (after
   `20261111000000_gym_join_window`). New tables only; hand-authored, so reconcile
   against dev before applying.
2. Deploy auth-service-dev and booking-service-dev (either order; the clients tolerate a
   missing endpoint by degrading).
3. Deploy partner web, then build the partner app.
4. Test with isolated dev users: an approved member, a pending request (404), a
   removed member (404), a member with no visits, and one with a clear routine; add,
   renew and delete a payment; clear a field; confirm no customer phone/email/DOB
   appears anywhere.

Run the backend suites with `node --experimental-test-module-mocks --test`.
