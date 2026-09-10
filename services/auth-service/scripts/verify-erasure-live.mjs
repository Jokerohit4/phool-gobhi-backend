// MANUAL live verification of the DPDPA erasure cascade. Not a unit test and
// not run by CI - it needs real dev credentials and it writes to the real dev
// database. The unit tests prove the orchestration logic; only this proves the
// *deployed* endpoints actually delete.
//
// Run it after any migration touching buddy/challenge/health, and before any
// promotion that touches deletion:
//
//   cd services/auth-service
//   SEC=$(gcloud secrets versions access latest --secret=auth-service-secrets-dev --project=phool-gobhi)
//   export DEV_DATABASE_URL=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).DATABASE_URL)" "$SEC")
//   export DEV_JWT_SECRET=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).JWT_SECRET)" "$SEC")
//   export GATEWAY=https://gateway-dev-1077801427223.asia-south1.run.app
//   node scripts/verify-erasure-live.mjs
//
// What it does: seeds a throwaway user with a real row in every user-keyed
// table across buddy/challenge/health, calls the real DELETE
// /api/auth/delete through the real gateway with a real JWT, then queries
// every one of those tables directly to prove the rows are gone.
//
// It also refuses to pass unless every base table in those three schemas is
// explicitly classified as either verified or exempt (see assertCoverage) -
// so a migration that adds a table cannot silently escape the cascade. That
// guard is the point of this file as much as the deletion check is: it is how
// the erasure claim stays true after today.
//
// Safety: operates on two reserved high ids that no real account can occupy,
// and purges them first so a partial run is re-runnable. Never touches user 9
// (the founder's real account). DEV ONLY - do not point DEV_DATABASE_URL or
// GATEWAY at prod.
import pg from 'pg';
import jwt from 'jsonwebtoken';

const { DEV_DATABASE_URL, DEV_JWT_SECRET, GATEWAY } = process.env;
if (!DEV_DATABASE_URL || !DEV_JWT_SECRET || !GATEWAY) {
  console.error('need DEV_DATABASE_URL, DEV_JWT_SECRET, GATEWAY');
  process.exit(1);
}

const TEST_ID = 999901;
// A second party is required to make the social tables meaningful: a match, a
// swipe, a block and a paired streak all need someone on the other side, and
// erasure has to remove the deleted user's half without erasing a stranger.
const OTHER_ID = 999902;
const TEST_PHONE = '9999000001';
// Fixture ids for the world-state rows a user's data hangs off (a challenge
// definition, a challenge, a team, a checkpoint spot). These are NOT user
// data and must survive deletion - the run cleans them up itself at the end.
const FIX = 999901;

const client = new pg.Client({ connectionString: DEV_DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

// Every table holding something keyed to a data subject, with the query that
// proves it is empty for our test user. Child tables are counted through
// their parent, which additionally proves the ON DELETE CASCADE actually
// fires rather than trusting the schema comment.
const CHECKS = [
  ['auth.User', 'SELECT COUNT(*)::int AS n FROM auth."User" WHERE id = $1'],

  ['buddy.BuddyProfile', 'SELECT COUNT(*)::int AS n FROM buddy."BuddyProfile" WHERE "userId" = $1'],
  ['buddy.BuddyFilter', 'SELECT COUNT(*)::int AS n FROM buddy."BuddyFilter" WHERE "userId" = $1'],
  ['buddy.BuddyPhoto',
    `SELECT COUNT(*)::int AS n FROM buddy."BuddyPhoto" p
       JOIN buddy."BuddyProfile" pr ON pr.id = p."buddyProfileId" WHERE pr."userId" = $1`],
  ['buddy.Swipe', 'SELECT COUNT(*)::int AS n FROM buddy."Swipe" WHERE "swiperId" = $1 OR "swipeeId" = $1'],
  ['buddy.Match', 'SELECT COUNT(*)::int AS n FROM buddy."Match" WHERE "userLowId" = $1 OR "userHighId" = $1'],
  ['buddy.ChatMessage', 'SELECT COUNT(*)::int AS n FROM buddy."ChatMessage" WHERE "senderId" = $1'],
  ['buddy.BlockedUser', 'SELECT COUNT(*)::int AS n FROM buddy."BlockedUser" WHERE "blockerId" = $1 OR "blockedId" = $1'],

  ['challenge.CoinBalance', 'SELECT COUNT(*)::int AS n FROM challenge."CoinBalance" WHERE "userId" = $1'],
  ['challenge.CoinLedgerEntry', 'SELECT COUNT(*)::int AS n FROM challenge."CoinLedgerEntry" WHERE "userId" = $1'],
  ['challenge.AttendanceEventLog', 'SELECT COUNT(*)::int AS n FROM challenge."AttendanceEventLog" WHERE "userId" = $1'],
  ['challenge.UserStreak', 'SELECT COUNT(*)::int AS n FROM challenge."UserStreak" WHERE "userId" = $1'],
  ['challenge.UserStreakWeek', 'SELECT COUNT(*)::int AS n FROM challenge."UserStreakWeek" WHERE "userId" = $1'],
  ['challenge.ChallengeEnrollment', 'SELECT COUNT(*)::int AS n FROM challenge."ChallengeEnrollment" WHERE "userId" = $1'],
  ['challenge.ChallengeTeamMember', 'SELECT COUNT(*)::int AS n FROM challenge."ChallengeTeamMember" WHERE "userId" = $1'],
  ['challenge.ChallengeWinner', 'SELECT COUNT(*)::int AS n FROM challenge."ChallengeWinner" WHERE "userId" = $1'],
  ['challenge.ChallengeCheckpointVisit',
    `SELECT COUNT(*)::int AS n FROM challenge."ChallengeCheckpointVisit" v
       JOIN challenge."ChallengeEnrollment" e ON e.id = v."enrollmentId" WHERE e."userId" = $1`],
  ['challenge.RewardIssuance',
    `SELECT COUNT(*)::int AS n FROM challenge."RewardIssuance" r
       JOIN challenge."ChallengeEnrollment" e ON e.id = r."enrollmentId" WHERE e."userId" = $1`],
  ['challenge.PairedStreak', 'SELECT COUNT(*)::int AS n FROM challenge."PairedStreak" WHERE "userAId" = $1 OR "userBId" = $1'],
  // The spawn row itself survives (it is world state - a spent spawn must not
  // become catchable again); what must not survive is the link to who caught
  // it, since that is a lat/lng plus a timestamp for a named person.
  ['challenge.SproutSpawn', 'SELECT COUNT(*)::int AS n FROM challenge."SproutSpawn" WHERE "caughtByUserId" = $1'],

  ['health.HealthConsent', 'SELECT COUNT(*)::int AS n FROM health."HealthConsent" WHERE "userId" = $1'],
  ['health.Exercise', 'SELECT COUNT(*)::int AS n FROM health."Exercise" WHERE "createdByUserId" = $1'],
  ['health.WorkoutTemplate', 'SELECT COUNT(*)::int AS n FROM health."WorkoutTemplate" WHERE "userId" = $1'],
  ['health.TemplateExercise',
    `SELECT COUNT(*)::int AS n FROM health."TemplateExercise" te
       JOIN health."WorkoutTemplate" t ON t.id = te."templateId" WHERE t."userId" = $1`],
  ['health.WorkoutSession', 'SELECT COUNT(*)::int AS n FROM health."WorkoutSession" WHERE "userId" = $1'],
  ['health.SessionExercise',
    `SELECT COUNT(*)::int AS n FROM health."SessionExercise" se
       JOIN health."WorkoutSession" s ON s.id = se."sessionId" WHERE s."userId" = $1`],
  ['health.WorkoutSet',
    `SELECT COUNT(*)::int AS n FROM health."WorkoutSet" w
       JOIN health."SessionExercise" se ON se.id = w."sessionExerciseId"
       JOIN health."WorkoutSession" s ON s.id = se."sessionId" WHERE s."userId" = $1`],
  ['health.ExerciseRecord', 'SELECT COUNT(*)::int AS n FROM health."ExerciseRecord" WHERE "userId" = $1'],
  ['health.DailyActivityMetric', 'SELECT COUNT(*)::int AS n FROM health."DailyActivityMetric" WHERE "userId" = $1'],
  ['health.BiometricEntry', 'SELECT COUNT(*)::int AS n FROM health."BiometricEntry" WHERE "userId" = $1'],
  ['health.PersonalisationProfile', 'SELECT COUNT(*)::int AS n FROM health."PersonalisationProfile" WHERE "userId" = $1'],
  ['health.SuggestionFeedback', 'SELECT COUNT(*)::int AS n FROM health."SuggestionFeedback" WHERE "userId" = $1'],
  // Not seeded, and expected to be zero for a different reason: form videos
  // are curated against the seeded shared library, which has no creator. If
  // one is ever attached to a user's CUSTOM exercise this count goes non-zero
  // and the run fails - which is the warning we want, because
  // ExerciseFormVideo -> Exercise is RESTRICT and would block the erasure of
  // that exercise exactly the way RewardIssuance once blocked enrollments.
  ['health.ExerciseFormVideo',
    `SELECT COUNT(*)::int AS n FROM health."ExerciseFormVideo" fv
       JOIN health."Exercise" e ON e.id = fv."exerciseId" WHERE e."createdByUserId" = $1`],
];

// Tables that must NOT be emptied by an erasure, each with the reason. This
// list is the documentation for why data survives account deletion, so a
// reason is mandatory - "it seemed fine" is how a compliance gap gets in.
const EXEMPT = {
  'challenge.CoinRedemption': 'statutory retention - fulfilled against real money via wallet-service; carries no PII once the auth User row is gone',
  'challenge.CoinCatalogItem': 'catalogue, not user data',
  'challenge.CoinEconomyConfig': 'admin-tuned config; updatedBy is a staff id, not a data subject',
  'challenge.ChallengeDefinition': 'catalogue, not user data',
  'challenge.Challenge': 'world state shared by every participant',
  'challenge.ChallengeTeam': 'world state; membership is erased via ChallengeTeamMember',
  'challenge.ChallengeCheckpointSpot': 'world state - a physical location, no user in it',
  'challenge.Sponsor': 'business counterparty, not a data subject of ours',
  'challenge.SponsorMedalBudget': 'sponsor accounting, no user reference',
  'health.RetentionPolicy': 'admin-tuned config; updatedBy is a staff id, not a data subject',
};

async function countAll(label) {
  console.log('');
  console.log(`--- ${label} ---`);
  const counts = {};
  for (const [name, sql] of CHECKS) {
    const { rows } = await client.query(sql, [TEST_ID]);
    counts[name] = rows[0].n;
    if (rows[0].n > 0) console.log(`  ${String(rows[0].n).padStart(3)}  ${name}`);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`  TOTAL ROWS: ${total}`);
  return { counts, total };
}

// --- coverage guard --------------------------------------------------------
// CHECKS and EXEMPT are hand-maintained, and the erasure cascade is only as
// complete as they are. A migration that adds a user-keyed table would
// otherwise escape both the cascade and this verification without a sound. So
// ask the database what tables it actually has and require every one of them
// to be classified.
async function assertCoverage() {
  const { rows } = await client.query(`
    SELECT table_schema AS s, table_name AS t
      FROM information_schema.tables
     WHERE table_schema IN ('buddy', 'challenge', 'health')
       AND table_type = 'BASE TABLE'
       AND table_name NOT LIKE '\\_prisma%'
     ORDER BY 1, 2`);

  const verified = new Set(CHECKS.map(([name]) => name));
  const unclassified = rows
    .map((r) => `${r.s}.${r.t}`)
    .filter((k) => !verified.has(k) && !EXEMPT[k]);

  if (unclassified.length > 0) {
    console.error('');
    console.error('COVERAGE FAIL - tables neither verified nor exempt:');
    for (const k of unclassified) console.error(`  ${k}`);
    console.error('');
    console.error('Add each one to the erasure cascade + CHECKS, or to EXEMPT with the');
    console.error('reason it must survive account deletion. Do not just silence this.');
    await client.end();
    process.exit(1);
  }
  console.log(`coverage ok - ${rows.length} tables in buddy/challenge/health: ${verified.size - 1} verified, ${Object.keys(EXEMPT).length} exempt by design`);
}
await assertCoverage();

// --- purge -----------------------------------------------------------------
// The test ids are reserved and no real account can occupy them, so clearing
// them first is safe - and it makes a re-run after a partial seed work rather
// than refusing forever. Also used as the post-run cleanup, which is why it
// removes the world-state fixtures too.
const PURGE = [
  `DELETE FROM health."WorkoutSet" WHERE "sessionExerciseId" IN (
     SELECT se.id FROM health."SessionExercise" se
       JOIN health."WorkoutSession" s ON s.id = se."sessionId" WHERE s."userId" = $1)`,
  `DELETE FROM health."SessionExercise" WHERE "sessionId" IN (
     SELECT id FROM health."WorkoutSession" WHERE "userId" = $1)`,
  `DELETE FROM health."TemplateExercise" WHERE "templateId" IN (
     SELECT id FROM health."WorkoutTemplate" WHERE "userId" = $1)`,
  'DELETE FROM health."WorkoutSession" WHERE "userId" = $1',
  'DELETE FROM health."WorkoutTemplate" WHERE "userId" = $1',
  `DELETE FROM health."ExerciseFormVideo" WHERE "exerciseId" IN (
     SELECT id FROM health."Exercise" WHERE "createdByUserId" = $1)`,
  'DELETE FROM health."Exercise" WHERE "createdByUserId" = $1',
  'DELETE FROM health."ExerciseRecord" WHERE "userId" = $1',
  'DELETE FROM health."DailyActivityMetric" WHERE "userId" = $1',
  'DELETE FROM health."BiometricEntry" WHERE "userId" = $1',
  'DELETE FROM health."SuggestionFeedback" WHERE "userId" = $1',
  'DELETE FROM health."PersonalisationProfile" WHERE "userId" = $1',
  'DELETE FROM health."HealthConsent" WHERE "userId" = $1',

  `DELETE FROM challenge."RewardIssuance" WHERE "enrollmentId" IN (
     SELECT id FROM challenge."ChallengeEnrollment" WHERE "userId" = $1)`,
  `DELETE FROM challenge."ChallengeCheckpointVisit" WHERE "enrollmentId" IN (
     SELECT id FROM challenge."ChallengeEnrollment" WHERE "userId" = $1)`,
  'DELETE FROM challenge."ChallengeEnrollment" WHERE "userId" = $1',
  'DELETE FROM challenge."ChallengeTeamMember" WHERE "userId" = $1',
  'DELETE FROM challenge."ChallengeWinner" WHERE "userId" = $1',
  'DELETE FROM challenge."AttendanceEventLog" WHERE "userId" = $1',
  'DELETE FROM challenge."UserStreakWeek" WHERE "userId" = $1',
  'DELETE FROM challenge."UserStreak" WHERE "userId" = $1',
  'DELETE FROM challenge."CoinLedgerEntry" WHERE "userId" = $1',
  'DELETE FROM challenge."CoinBalance" WHERE "userId" = $1',
  'DELETE FROM challenge."PairedStreak" WHERE "userAId" = $1 OR "userBId" = $1',

  `DELETE FROM buddy."BuddyPhoto" WHERE "buddyProfileId" IN (
     SELECT id FROM buddy."BuddyProfile" WHERE "userId" = $1)`,
  'DELETE FROM buddy."BuddyFilter" WHERE "userId" = $1',
  'DELETE FROM buddy."BuddyProfile" WHERE "userId" = $1',
  `DELETE FROM buddy."ChatMessage" WHERE "senderId" = $1 OR "matchId" IN (
     SELECT id FROM buddy."Match" WHERE "userLowId" = $1 OR "userHighId" = $1)`,
  'DELETE FROM buddy."Match" WHERE "userLowId" = $1 OR "userHighId" = $1',
  'DELETE FROM buddy."Swipe" WHERE "swiperId" = $1 OR "swipeeId" = $1',
  'DELETE FROM buddy."BlockedUser" WHERE "blockerId" = $1 OR "blockedId" = $1',
];

// World-state fixtures, removed only after the per-user purge above so no
// child row is left pointing at a missing parent.
const PURGE_FIXTURES = [
  'DELETE FROM challenge."SproutSpawn" WHERE "challengeId" = $1',
  'DELETE FROM challenge."ChallengeCheckpointSpot" WHERE "challengeId" = $1',
  'DELETE FROM challenge."ChallengeTeam" WHERE "challengeId" = $1',
  'DELETE FROM challenge."Challenge" WHERE id = $1',
  'DELETE FROM challenge."ChallengeDefinition" WHERE id = $1',
];

async function purge() {
  for (const id of [TEST_ID, OTHER_ID]) {
    for (const sql of PURGE) await client.query(sql, [id]);
  }
  for (const sql of PURGE_FIXTURES) await client.query(sql, [FIX]);
  await client.query('DELETE FROM auth."User" WHERE phone = $1 OR id = $2', [TEST_PHONE, TEST_ID]);
}
await purge();

// --- seed ------------------------------------------------------------------
console.log(`seeding throwaway user ${TEST_ID} (+ counterparty ${OTHER_ID})...`);

await client.query(
  `INSERT INTO auth."User" (id, name, phone, role, type, "profileImageUrl", "fcmToken", "updatedAt")
   VALUES ($1, 'Erasure Test', $2, 'customer', 'general', '', '', NOW())`, [TEST_ID, TEST_PHONE]);

// ---- buddy: bio, face photo and a private conversation ----
const { rows: prof } = await client.query(
  `INSERT INTO buddy."BuddyProfile" ("userId", bio, lat, lng, gender, "fitnessGoals", "updatedAt")
   VALUES ($1, 'test bio that must not survive', 28.45, 77.02, 'male', '{}', NOW()) RETURNING id`, [TEST_ID]);
await client.query(
  `INSERT INTO buddy."BuddyPhoto" ("buddyProfileId", url, "publicId", "order")
   VALUES ($1, 'https://example.invalid/x.jpg', NULL, 0)`, [prof[0].id]);
await client.query('INSERT INTO buddy."BuddyFilter" ("userId", "updatedAt") VALUES ($1, NOW())', [TEST_ID]);
await client.query(
  `INSERT INTO buddy."Swipe" ("swiperId", "swipeeId", action) VALUES ($1, $2, 'like')`, [TEST_ID, OTHER_ID]);
// A swipe made ON the test user by someone else is still a record of the test
// user having appeared in a stranger's feed.
await client.query(
  `INSERT INTO buddy."Swipe" ("swiperId", "swipeeId", action) VALUES ($2, $1, 'like')`, [TEST_ID, OTHER_ID]);
const { rows: match } = await client.query(
  'INSERT INTO buddy."Match" ("userLowId", "userHighId") VALUES ($1, $2) RETURNING id', [TEST_ID, OTHER_ID]);
await client.query(
  `INSERT INTO buddy."ChatMessage" ("matchId", "senderId", body)
   VALUES ($1, $2, 'private text that must not survive')`, [match[0].id, TEST_ID]);
await client.query(
  'INSERT INTO buddy."BlockedUser" ("blockerId", "blockedId") VALUES ($1, $2)', [TEST_ID, OTHER_ID]);

// ---- challenge fixtures (world state, must survive the deletion) ----
await client.query(
  `INSERT INTO challenge."ChallengeDefinition" (id, key, type, category, title, "defaultVerificationMethod", "updatedAt")
   VALUES ($1, 'erasure-verification-fixture', 'city_gym_circuit', 'gym_native', 'Erasure fixture', 'qr_scan', NOW())`, [FIX]);
await client.query(
  `INSERT INTO challenge."Challenge" (id, "challengeDefinitionId", city, "targetCount", "rewardCoins", "updatedAt")
   VALUES ($1, $1, 'Gurugram', 3, 100, NOW())`, [FIX]);
await client.query(
  `INSERT INTO challenge."ChallengeTeam" (id, "challengeId", name) VALUES ($1, $1, 'Erasure fixture team')`, [FIX]);
await client.query(
  `INSERT INTO challenge."ChallengeCheckpointSpot" (id, "challengeId", sequence, label, lat, lng, code)
   VALUES ($1, $1, 1, 'Fixture spot', 28.45, 77.02, 'ERASURE-FIXTURE-1')`, [FIX]);

// ---- challenge: the user's own behavioural data ----
await client.query(
  'INSERT INTO challenge."CoinBalance" ("userId", balance, "updatedAt") VALUES ($1, 50, NOW())', [TEST_ID]);
await client.query(
  `INSERT INTO challenge."CoinLedgerEntry" ("userId", type, amount, description, "idempotencyKey")
   VALUES ($1, 'credit', 50, 'erasure verification', $2)`, [TEST_ID, `erasure-coin-${TEST_ID}`]);
await client.query(
  `INSERT INTO challenge."AttendanceEventLog" ("userId", "gymId", "attendedAt", source, "idempotencyKey")
   VALUES ($1, 1, NOW(), 'self_checkin', $2)`, [TEST_ID, `erasure-att-${TEST_ID}`]);
await client.query(
  `INSERT INTO challenge."UserStreak" ("userId", "currentStreak", "longestStreak", "createdAt", "updatedAt")
   VALUES ($1, 2, 2, NOW(), NOW())`, [TEST_ID]);
await client.query(
  `INSERT INTO challenge."UserStreakWeek" ("userId", "weekStart", "checkinCount", "createdAt", "updatedAt")
   VALUES ($1, DATE_TRUNC('week', NOW()), 2, NOW(), NOW())`, [TEST_ID]);
const { rows: enrol } = await client.query(
  'INSERT INTO challenge."ChallengeEnrollment" ("userId", "challengeId") VALUES ($1, $2) RETURNING id', [TEST_ID, FIX]);
await client.query(
  `INSERT INTO challenge."ChallengeCheckpointVisit" ("enrollmentId", "checkpointSpotId", lat, lng)
   VALUES ($1, $2, 28.45, 77.02)`, [enrol[0].id, FIX]);
// The row that used to make erasure fail outright: RewardIssuance ->
// ChallengeEnrollment is RESTRICT, so without an explicit delete the
// enrollment delete throws and the whole account deletion is refused.
await client.query(
  `INSERT INTO challenge."RewardIssuance" ("enrollmentId", "rewardType", "coinAmount")
   VALUES ($1, 'coins', 100)`, [enrol[0].id]);
await client.query(
  `INSERT INTO challenge."ChallengeTeamMember" ("teamId", "userId", role) VALUES ($1, $2, 'member')`, [FIX, TEST_ID]);
await client.query(
  'INSERT INTO challenge."ChallengeWinner" ("challengeId", "userId", rank) VALUES ($1, $2, 1)', [FIX, TEST_ID]);
await client.query(
  `INSERT INTO challenge."PairedStreak" ("matchId", "userAId", "userBId", "updatedAt")
   VALUES ($1, $2, $3, NOW())`, [FIX, TEST_ID, OTHER_ID]);
await client.query(
  `INSERT INTO challenge."SproutSpawn"
     ("challengeId", "speciesKey", rarity, "coinValue", lat, lng, "expiresAt", "caughtByUserId", "caughtAt")
   VALUES ($1, 'fixture-sprout', 'common', 5, 28.45, 77.02, NOW() + INTERVAL '1 day', $2, NOW())`, [FIX, TEST_ID]);

// ---- health: consent, custom exercise, routine, session, biometrics ----
await client.query(
  `INSERT INTO health."HealthConsent" ("userId", "grantedAt", "policyVersion", platform)
   VALUES ($1, NOW(), 'v1', 'android')`, [TEST_ID]);
const { rows: ex } = await client.query(
  `INSERT INTO health."Exercise"
     (name, "muscleGroup", equipment, "loggingType", "primaryMuscles", "secondaryMuscles", "createdByUserId", "updatedAt")
   VALUES ('Erasure custom lift', 'chest', 'barbell', 'sets_reps_weight', '{}', '{}', $1, NOW()) RETURNING id`, [TEST_ID]);
const { rows: tpl } = await client.query(
  `INSERT INTO health."WorkoutTemplate" ("userId", name, "updatedAt")
   VALUES ($1, 'Erasure routine', NOW()) RETURNING id`, [TEST_ID]);
await client.query(
  `INSERT INTO health."TemplateExercise" ("templateId", "exerciseId", "order", "targetSets", "targetReps")
   VALUES ($1, $2, 0, 3, 8)`, [tpl[0].id, ex[0].id]);
const { rows: sess } = await client.query(
  `INSERT INTO health."WorkoutSession" ("userId", "templateId", "startedAt")
   VALUES ($1, $2, NOW()) RETURNING id`, [TEST_ID, tpl[0].id]);
const { rows: sx } = await client.query(
  `INSERT INTO health."SessionExercise" ("sessionId", "exerciseId", "order")
   VALUES ($1, $2, 0) RETURNING id`, [sess[0].id, ex[0].id]);
await client.query(
  `INSERT INTO health."WorkoutSet" ("sessionExerciseId", "setNumber", "weightKg", reps, completed, "updatedAt")
   VALUES ($1, 1, 60.0, 8, true, NOW())`, [sx[0].id]);
await client.query(
  `INSERT INTO health."ExerciseRecord" ("userId", source, type, "startedAt", "endedAt", "durationSeconds")
   VALUES ($1, 'manual', 'cardio', NOW() - INTERVAL '30 minutes', NOW(), 1800)`, [TEST_ID]);
await client.query(
  `INSERT INTO health."DailyActivityMetric" ("userId", date, steps, source)
   VALUES ($1, '2026-09-09', 8000, 'health_connect')`, [TEST_ID]);
await client.query(
  `INSERT INTO health."BiometricEntry" ("userId", metric, value, unit, "localDate", "updatedAt")
   VALUES ($1, 'weight', 74.2, 'kg', '2026-09-09', NOW())`, [TEST_ID]);
await client.query(
  `INSERT INTO health."PersonalisationProfile" ("userId", "heightCm", "injuryZones", "programmingMode", "updatedAt")
   VALUES ($1, 178, '{knee}', 'neutral', NOW())`, [TEST_ID]);
await client.query(
  'INSERT INTO health."SuggestionFeedback" ("userId", "suggestionKey") VALUES ($1, $2)', [TEST_ID, 'template:1']);

const before = await countAll('BEFORE deletion');
// Every verified table except ExerciseFormVideo (deliberately unseeded - see
// its CHECKS comment) must have produced a row, or the run would "pass" by
// simply never having created the data it claims to check.
const unseeded = Object.entries(before.counts)
  .filter(([name, n]) => n === 0 && name !== 'health.ExerciseFormVideo')
  .map(([name]) => name);
if (unseeded.length > 0) {
  console.error('');
  console.error('SEED FAIL - these tables were never populated, so verifying them proves nothing:');
  for (const name of unseeded) console.error(`  ${name}`);
  await client.end();
  process.exit(1);
}

// --- delete through the real API ------------------------------------------
const token = jwt.sign({ id: TEST_ID, role: 'customer', type: 'general' }, DEV_JWT_SECRET, { expiresIn: '15m' });
console.log('');
console.log('calling DELETE /api/auth/delete on the live dev gateway...');
const res = await fetch(`${GATEWAY}/api/auth/delete`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${token}` },
});
const body = await res.text();
console.log(`  HTTP ${res.status}: ${body.slice(0, 600)}`);

// --- verify ---------------------------------------------------------------
const after = await countAll('AFTER deletion');

// The spawn is world state and must still be there, just with nobody attached.
const { rows: spawn } = await client.query(
  `SELECT COUNT(*)::int AS n FROM challenge."SproutSpawn"
    WHERE "challengeId" = $1 AND "caughtByUserId" IS NULL`, [FIX]);

console.log('');
console.log('================ RESULT ================');
let ok = true;

if (after.total === 0) {
  console.log(`PASS - all ${CHECKS.length} user-keyed tables are empty across auth/buddy/challenge/health.`);
} else {
  ok = false;
  console.log('FAIL - rows survived deletion:');
  for (const [name, n] of Object.entries(after.counts)) if (n > 0) console.log(`  ${String(n).padStart(3)}  ${name}`);
}

if (spawn[0].n === 1) {
  console.log('PASS - world state (the caught sprout) survived, anonymised.');
} else {
  ok = false;
  console.log('FAIL - the caught sprout should survive with caughtByUserId nulled, not be deleted');
}

console.log('');
console.log('cleaning up fixtures and any leftovers...');
await purge();

await client.end();
process.exit(ok ? 0 : 1);
