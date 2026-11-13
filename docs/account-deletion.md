# Account deletion: archive mode (retain everything)

Status: implemented locally; **not deployed**.

## Decision

Pending legal advice on what must eventually be deleted, "Delete account" **retains
all data**. The account is closed and neutralised in place; nothing is erased. This
is the reversible order: anything kept can be deleted or anonymised later, while
anything already erased can never be recovered.

The mode is a switch, so changing course needs no code change:

| `ACCOUNT_DELETION_MODE` | Behaviour |
|---|---|
| unset or `archive` (default) | Close and neutralise the account. Delete nothing. |
| `erase` | The original behaviour: erase across buddy/challenge/health, then delete the User row. Still fully tested. |

Any value other than `erase` means archive, so a typo can never silently turn hard
deletion on or off.

## What archiving does

On the same `User` row, in one transaction:

- the identifying fields (name, phone, email, photo, push token, referral code) are
  copied into `archivedData` and the live columns become neutral (`name` reads
  "Former member"; phone, email and referral code are null). **Everything else is
  left as it was**: gender, date of birth, goals, health, bookings, wallet, gym
  records and payments, addresses, bank details, buddy photos and chats;
- the account is deactivated (`isActive=false`), so login, refresh and Google sign-in
  all refuse it, and `archivedAt` is set;
- refresh tokens are deleted (credentials, not data), so the old session cannot resume;
- gym memberships end (`removedAt`; the link rows stay), so the person leaves every
  partner's roster and the partner profile returns 404 for them;
- `leaderboardOptIn=false` and `linkedGymId=null`.

buddy-service is asked first (`POST /internal/archive/:userId`) to hide the person
from everyone else: the profile leaves every deck and their active matches end. Nothing
is deleted there either; the messages and photos stay.

challenge-, health-, booking-, wallet- and gym-service need no step: they key
everything on the user id and keep no name or photo copy. Anywhere a name is shown
(leaderboards, a gym review) it is resolved from auth at read time and now reads
"Former member".

## Signing in again

The phone and email are free (null), so the same number creates a **brand-new user**
with a new id, a new wallet and no history. The archived row keeps the old id, so the
retained data still hangs together, but nothing in the apps can reach it.

The order mirrors erasure: hide the person from others first, neutralise the identity
last. If buddy-service is unreachable the account is left exactly as it was
(`ARCHIVE_INCOMPLETE`, 502) and the user can retry. Every step is idempotent, and a
second delete of an archived account returns success without touching anything.

## Known gaps

- **Short-lived access token:** the JWT for the closed account stays valid for up to 15
  minutes. It cannot refresh. It can still call APIs until it expires.
- **Counts and admin lists:** archived rows remain, so any "total users" count or admin
  list that does not filter on `archivedAt` will include "Former member" entries. Worth
  filtering in the admin analytics.
- **Fresh bonuses:** a new account earns the welcome and profile-completion bonuses
  again, as it did with hard deletion plus re-registration. Referral rewards and
  self-link limits still lean on install ids, which are retained.
- **Wallet balance:** any remaining balance is retained with the archived account, and
  the person cannot get it back. This needs a decision (refund or forfeit) and a line in
  the terms.
- **Partner and staff accounts** go through the same path. A partner's gyms stay owned by
  the archived account.
- **Data export** is unchanged; it still serves a live account only.

## What the lawyer needs to settle (and what in the product says otherwise today)

These statements are inconsistent with retaining data and need approved wording before
this mode reaches production:

1. **Privacy policy, section 7** (draft, pending legal review) says deletion "removes
   your profile, buddy profile, bookings, wallet balance and referrals".
2. **The public page `/policies/delete-account`** says deletion is permanent and lists
   "What gets deleted". Play requires an accurate deletion URL.
3. **Google Play Data Safety and App Store privacy answers** (outside this repo) describe
   deletion and retention.
4. **India's DPDP Act** gives a right to erasure; the question is what may be kept, for
   how long, in what form (anonymised or not), and on what lawful basis.
5. The in-app wording was already changed to be truthful (see below); the wording
   itself is the lawyer's to finalise.

Questions worth taking to them: what must be erased on request; whether retained data
may be kept identifiable and for how long; whether de-identified data can be kept for
model training and how "de-identified" must be shown; the wallet-balance position; and
the retention period for financial records.

## Interim wording already changed (customer app, all three languages)

- The confirmation dialog (`gap0d0ae11a7c83`) no longer says "permanently deletes your
  profile ... cannot be undone". It now says the account is closed and the person is
  signed out, they cannot get it back, signing in again starts a new empty account, and
  we keep the data from the old account.
- The health privacy line (`healthPrivacyDeletingAccount`) says the account is closed for
  good and the data is kept.
- Revoking health access (a separate feature) still genuinely deletes exercise data and
  its wording is unchanged.

The partner app has the delete call but no screen that uses it, so it has no wording.

## Deployment

1. Apply the auth migration `20261113000000_user_archive` (two nullable columns on
   `User`; hand-authored, so reconcile against dev first).
2. Deploy auth-service and buddy-service. Deploy buddy first: auth calls its new
   `/internal/archive` route.
3. Until the policy, delete-account page and store forms are settled, production can run
   with `ACCOUNT_DELETION_MODE=erase`, which keeps today's behaviour and today's wording true.

## Later: moving from retain to a narrower policy

The archived rows are identifiable by `archivedAt IS NOT NULL`, with the original
identity in `archivedData`. A later anonymisation or purge job needs only a query on
that column: drop or hash `archivedData`, and null the remaining identifying columns
and free text. Nothing about this design has to be undone first.

Run the backend suites with `node --experimental-test-module-mocks --test`.
