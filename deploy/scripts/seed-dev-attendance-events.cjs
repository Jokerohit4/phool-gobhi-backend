// Dev-only backfill: create challenge."AttendanceEventLog" rows from existing
// booking."MemberAttendance" check-ins so the score-based leaderboards (and
// the home hero's lifetime rank/score) have real data to rank in dev.
//
// Uses the SAME idempotencyKey convention the live member check-in path uses
// ("member-checkin:<attendanceId>"), so future real writes for those rows are
// idempotent no-ops rather than duplicates. Idempotent re-runnable via
// ON CONFLICT. Only seeds the last 90 days (the "all" window the boards use).
//
// ALSO plants a few recent demo attendance days for the dev requester
// (test user 7, "Test User1") so the hero/board can be verified on the
// account the app is logged into. Delete those with:
//   DELETE FROM booking."MemberAttendance" WHERE customerId=7 AND date IN (...);
//   DELETE FROM challenge."AttendanceEventLog"
//     WHERE idempotencyKey LIKE 'seed-demo-user7:%';
//
// Usage: DATABASE_URL=<...> node deploy/scripts/seed-dev-attendance-events.cjs
const { createRequire } = require('module');
const path = require('path');
const req = createRequire(path.join(__dirname, '../../services/booking-service/package.json'));
const { Client } = req('pg');

const IST_OFFSET_MS = (5 * 60 + 30) * 60000;
const DAY_MS = 86400000;
const ALL_WINDOW_DAYS = 90;
const DEMO_USER_ID = 7; // "Test User1" -- the dev account the app signs in as
const DEMO_DAYS_AGO = [1, 3, 6];

function istDateKey(offsetMs) {
  return new Date(Date.now() + IST_OFFSET_MS + offsetMs).toISOString().slice(0, 10);
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const windowStart = istDateKey(-ALL_WINDOW_DAYS * DAY_MS);
  const updated = `UPDATE "booking"."MemberAttendance"
     SET "checkedInAt" = COALESCE("checkedInAt", ($1::date + interval '7 hours'))
     WHERE "checkedInAt" IS NULL`;
  await client.query(updated, [istDateKey(0)]);

  const rows = await client.query(
    `SELECT id, "customerId" AS "customerId", "gymId" AS "gymId",
            "date" AS "date", "checkedInAt" AS "checkedInAt"
     FROM "booking"."MemberAttendance"
     WHERE "date" >= $1
     ORDER BY id`,
    [windowStart]
  );

  let inserted = 0;
  const source = 'member_checkin';
  for (const r of rows.rows) {
    const attendedAt = r.checkedInAt instanceof Date
      ? r.checkedInAt.toISOString()
      : `${r.date}T01:30:00.000Z`;
    const res = await client.query(
      `INSERT INTO "challenge"."AttendanceEventLog"
         ("userId", "memberAttendanceId", "gymId", "attendedAt", "source", "idempotencyKey", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT ("idempotencyKey") DO NOTHING`,
      [r.customerId, r.id, r.gymId, attendedAt, source, `member-checkin:${r.id}`]
    );
    inserted += res.rowCount;
  }

  const counts = await client.query(
    `SELECT (SELECT count(*)::int FROM "booking"."MemberAttendance" WHERE "date" >= $1) AS attendance,
            (SELECT count(*)::int FROM "challenge"."AttendanceEventLog") AS events`,
    [windowStart]
  );

  const demoResults = [];
  const demoGym = await client.query(
    `SELECT "gymId" FROM "booking"."MemberAttendance" GROUP BY "gymId" ORDER BY count(*) DESC LIMIT 1`
  ).then((r) => r.rows[0]?.gymId);
  const existingDays = await client.query(
    `SELECT "date" FROM "booking"."MemberAttendance" WHERE "customerId" = $1`,
    [DEMO_USER_ID]
  );
  const have = new Set(existingDays.rows.map((r) => r.date));
  for (const daysAgo of DEMO_DAYS_AGO) {
    const d = istDateKey(-daysAgo * DAY_MS);
    if (have.has(d) || !demoGym) continue;
    const ins = await client.query(
      `INSERT INTO "booking"."MemberAttendance"
         ("customerId", "gymId", "date", "checkedInAt")
       VALUES ($1, $2, $3::text, to_date($3, 'YYYY-MM-DD') + time '07:00')
       RETURNING id`,
      [DEMO_USER_ID, demoGym, d]
    );
    const attendanceId = ins.rows[0].id;
    await client.query(
      `INSERT INTO "challenge"."AttendanceEventLog"
         ("userId", "memberAttendanceId", "gymId", "attendedAt", "source", "idempotencyKey", "createdAt")
       VALUES ($1, $2, $3, (to_date($4, 'YYYY-MM-DD') + time '07:00')::timestamp, 'member_checkin', $5, now())
       ON CONFLICT ("idempotencyKey") DO NOTHING`,
      [DEMO_USER_ID, attendanceId, demoGym, d, `seed-demo-user7:${attendanceId}`]
    );
    demoResults.push(d);
  }

  console.log(`Seeded ${inserted} attendance events from ${rows.rows.length} member check-ins (90d window).`);
  console.log(`booking member attendance (90d): ${counts.rows[0].attendance}; total attendance events: ${counts.rows[0].events}`);
  console.log(`Demo days planted for user ${DEMO_USER_ID}: ${demoResults.join(', ') || '(none needed)'}`);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});