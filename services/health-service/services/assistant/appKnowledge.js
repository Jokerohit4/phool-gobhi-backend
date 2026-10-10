// What the assistant knows about the app itself.
//
// Split out from assistantPolicy.js for the same reason the policy is data
// rather than prose baked into a controller: the app's navigation changes
// whenever product ships, and the coach's answers about "where do I log a
// workout" have to change with it. Keeping the manual in one file makes that a
// single edit rather than a hunt through the request path.
//
// THE MANUAL IS THE WHOLE TRUTH. The rules in assistantPolicy.js tell the
// model to answer app questions only from this text and to say so when it is
// not covered. That is what stops it inventing a plausible screen name for a
// feature that does not exist — the failure mode that makes an in-app coach
// worse than no in-app coach, because the user cannot tell the difference
// between a confident wrong answer and a real one.
//
// Deliberately absent from the manual below, even though the backend has
// endpoints for them: a cycle/period tracking SCREEN, and Apple Health auto-
// sync of anything the user has not connected. Cycle tracking is now real on
// the backend and described here as such, but it still has no screen or toggle
// in the released app, so the model must not invent a tap path for it. They
// are called out as unavailable so the model does not describe a roadmap item
// as though it were one tap away.
//
// The GPS run/walk/cycle tracker is the awkward one, and it is called out here
// because the reason has changed. The run screens DO exist in the customer app
// (see openRunEntry and the run/ pages), but they sit behind the `runTracker`
// feature flag, which is `enabled: false` in auth-service's app-config, on top
// of `healthMetrics`. So for anyone on a released build there is genuinely no
// screen to find, and the manual is right to withhold it — while the comment
// that used to sit here ("the customer app ships no screen") had become false
// and would have sent the next person grepping for run screens to the wrong
// repo.
//
// WHEN THE FLAG IS TURNED ON, delete the run bullet from the manual and
// describe the flow. Until then the honest thing is both: the feature is real,
// and it is not released.

const APP_MANUAL = `
## The Phool Gobhi app — what is on the screen

Phool Gobhi is pay-per-session gym access. There are no memberships: you book
individual session slots at partner gyms near you and pay for each one.

### The five bottom tabs
- **Home** — your landing tab. Upcoming session, quick actions, attendance
  streak, and cards that jump to everything else.
- **My Sessions** — every booking: upcoming, past and cancelled.
- **Map** — a full-screen map of partner gyms around you.
- **Buddy** — swipe through other people training near you, match, and chat.
- **Progress** — workouts, plans, streaks, challenges, and Health & Activity.

Two more screens have no tab of their own:
- **Profile** — the person icon, top-right of Home.
- **Search** — "See More" on Home, for browsing gyms by name, amenity or price.

### Booking a session
Home or Map -> tap a gym card -> the gym's page -> pick a date and a time
slot -> **Book Now**. You pay from your wallet balance, so the wallet has to
hold the session price. If it does not, the button reads **Top Up** instead and
a bar offers **Add money ->**. Gyms can also run bookable classes and monthly
subscriptions; those are booked from the same gym page.

### Getting into the gym (check-in)
**My Sessions** -> your upcoming session. Either scan the QR poster at the gym
desk, or use **Request check-in** and let the app confirm your location (it has
to be within about 50 m of the gym). Self check-in also works from the poster
QR if you are already inside. A session the gym marks attended shows up in your
attendance history; scanning early flags an attendance warning.

### Your wallet and payments
Profile -> **Wallet Balance** and **Add Money** for top-ups and your full
transaction history. Subscriptions are also bought from the wallet, never with
a card directly. **Refer & Earn** in Profile invites friends.

### Logging a workout — the answer to "where do I log my data?"
There are three ways in, all under the **Progress** tab:

1. **Quick log, no planning.** Progress -> **Workouts** -> **Start Empty
   Workout**. You get a live workout screen immediately: **+ Add Exercise** to
   pull in a movement, **+ Add Set** to log weight and reps (the columns are
   SET / PREVIOUS / KG / REPS), and **Finish** when you are done.
2. **From a routine.** Progress -> **Workouts** -> **New Routine** to save a
   template of exercises and sets you repeat. Tap **Start** on a routine to run
   it. **Browse starter templates** fills it in for you, and **View plan >**
   sets which days of the week it repeats on.
3. **From a multi-week plan.** Progress -> **Workouts** -> **View plan >** ->
   **Weekly plan**, which tells you what each day of the week is for and marks
   rest days.

Cardio, yoga and anything that is not a set-based workout is logged as a
quick record, or comes in automatically if you connect a wearable.

### Seeing your progress on a lift
Open an exercise from a workout -> **Your Records** for that movement's history.
Progress -> **Workouts** -> any routine's exercise history for session-by-session
detail. The wider picture lives at Progress -> **Training Progress** and
Progress -> **Progress**, and your last seven days at **Your Week**. There is
also a per-gym attendance leaderboard.

### Body weight, steps, sleep, heart rate
Home's **Steps** tile, or Progress -> **Health & Activity**. There:
- **Track Body** — weight and body fat, logged by hand.
- **Today's Numbers** — steps, sleep, resting heart rate, HRV and stress for
  the day, all on one screen.
- **Health Settings -> Connect Apple Health / Health Connect** — to pull those
  numbers in automatically instead of typing them.
- **Health Settings -> Training preferences** — goal, experience level and any
  areas you want to train around, which is what lets the coach give advice
  specific to you.
- **Health Settings -> Reminders** — nudge settings.
- **Health Settings -> What we keep, and for how long** — the retention policy,
  and **Download my data** as a Spreadsheet or JSON.
- **Health Settings -> Revoke & Delete** — withdraws health consent and deletes
  what was collected.

### Streaks, coins and challenges
The streak button (bottom-right) opens your coins; the gift box (bottom-left)
is a reward you can open. Progress -> **Challenges** for group and solo
challenges, and **Badges** for what you have earned.

### Policies and account
Profile has a policies card: **Privacy Policy**, **Terms of Service**,
**Cancellation Policy** (in-app) and **Download my data**. It also has
**Delete account?** and sign out. The attendance leaderboard toggle and
appearance settings (**Theme style**, **Sound effects**) are on Profile too.

### Not in the app yet
Do not offer these — there is no screen for the user to find:
- Cycle or period tracking: there is no screen or toggle for it in the app yet, so do not send anyone looking for one. But the behaviour behind it IS in place for those who have switched it on: logging a period only ever suggests a low-impact training mode for the duration of that period. It expires on its own once the period length is up, it never switches on the lower-body emphasis mode, and it never touches a mode she chose herself.
- Live crowd levels, wait times, or dynamic per-slot pricing.
- Chat with a gym owner directly.
- GPS run tracking, or importing runs from a watch. This one is built but not
  released yet, so there is nothing to tap. If someone says they can already
  see a run screen, they are on a pre-release build: you can tell them what it
  does (records a run, walk or cycle with GPS, then reviews route, splits and pace),
  but do not tell anyone else to go looking for it.

### Support
Anything the guide above does not cover: **hello@phoolgobhi.com**, or
**partners@phoolgobhi.com** if they are a gym owner. The website is
**www.phoolgobhi.com**.
`.trim();

/// Navigation as the model should repeat it back: the short version, used
/// when the answer only needs to point somewhere rather than walk a path.
const APP_NAVIGATION = `
Quick map: Home (landing) · My Sessions (bookings) · Map (gyms near you) ·
Buddy (people training near you) · Progress (workouts, plans, health).
Profile is the person icon top-right of Home. Booking: gym card -> gym page ->
slot -> Book Now, paid from wallet. Workout logging: Progress -> Workouts ->
Start Empty Workout (or New Routine). Body/steps/sleep: Progress -> Health &
Activity. Wallet: Profile -> Wallet Balance.
`.trim();

export { APP_MANUAL, APP_NAVIGATION };
