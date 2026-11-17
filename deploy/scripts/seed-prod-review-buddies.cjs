// App Review demo BUDDIES for PRODUCTION account 9999999999 (user 22): a few people the
// reviewer is already matched with, each with a short chat. Companion to
// seed-prod-review-account.cjs; derived from seed-dev-buddy-profiles.cjs.
//
//   node deploy/scripts/seed-prod-review-buddies.cjs                          (plan, writes nothing)
//   node deploy/scripts/seed-prod-review-buddies.cjs --apply --confirm-prod   (create / refresh)
//   node deploy/scripts/seed-prod-review-buddies.cjs --remove --apply --confirm-prod
//
// Why this is safe on production:
//   * Every demo buddy has isDiscoverable=false, so none of them can ever appear in a real
//     user's swipe deck. They only exist as MATCHES of account 22 (the matches list does not
//     depend on discoverability).
//   * They have no phone number and a reserved-TLD email (@review.phoolgobhi.invalid), so
//     nobody can sign in as one of them.
//   * No fans/followers and no health-score snapshots are created, so they cannot leak into
//     real users' follower counts or leaderboards.
//   * Only rows tied to the marker email are ever created, refreshed or removed.
//   * Matches expire after 30 days without activity (MATCH_EXPIRY_DAYS): re-run this before a
//     review window so lastActivityAt is fresh. Chat messages already in a match are never
//     overwritten or deleted by a re-run, so anything a reviewer typed stays.
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const path = require('node:path');
const { Client } = createRequire(path.join(__dirname, '../../package.json'))('pg');

const VIEWER_ID = 22, VIEWER_PHONE = '9999999999';
const EMAIL_DOMAIN = 'review.phoolgobhi.invalid', EMAIL_PREFIX = 'review-buddy-';
const emailOf = (slug) => `${EMAIL_PREFIX}${slug}@${EMAIL_DOMAIN}`;
const L = (name, weight, unit, reps) => ({ name, weight, unit, reps });

const CAST = [
  { slug: 'maya', name: 'Maya Kapoor', gender: 'female', age: 27, km: 3, bearing: 15, photos: 5, share: true,
    goals: ['general_fitness', 'muscle_gain'], social: '@maya.kapoor',
    bio: 'Marathon in spring, deadlifts in winter. Always up for an early session.',
    prs: [L('Deadlift', 130, 'kg', 3), L('Back squat', 100, 'kg', 5), L('Bench press', 62.5, 'kg', 5)],
    messages: ['Hey! Saw you also train at 6am', 'Yes! Chest day tomorrow if you are around?', 'I am in. Spotting each other?', 'Deal. See you at the gym!'] },
  { slug: 'sameer', name: 'Sameer Joshi', gender: 'male', age: 30, km: 4, bearing: 215, photos: 3, share: false,
    goals: ['weight_loss'], social: '@sameerj', prs: [],
    bio: 'Down 12 kg and counting. Cardio first, weights after.',
    messages: ['Hi! Nice to match', 'Hey Sameer, how is the cut going?', 'Slow and steady. Want to try the Saturday group run?'] },
  { slug: 'aanya', name: 'Aanya Sharma', gender: 'female', age: 27, km: 2, bearing: 20, photos: 6, share: true,
    goals: ['muscle_gain', 'general_fitness', 'flexibility_yoga'], social: '@aanya.lifts',
    bio: 'Early-morning lifter with a desk job by day. Strength block in winter, a bit of running when the weather turns. Looking for someone who actually turns up and does not mind a long warm-up. Coffee after is non-negotiable.',
    prs: [L('Back squat', 140, 'kg', 3), L('Deadlift', 180, 'kg', 1), L('Bench press', 82.5, 'kg', 5), L('Overhead press', 55, 'kg', 5), L('Barbell row', 90, 'kg', 6), L('Hip thrust', 200, 'kg', 5)],
    messages: ['Hi! We both lift at 6, you look like you know your squats', 'Ha, thanks. Currently on a 5x5 block', 'Same! Want to compare programs this week?'] },
  { slug: 'kabir', name: 'Kabir Malhotra', gender: 'male', age: 31, km: 4, bearing: 110, photos: 4, share: true,
    goals: ['muscle_gain', 'weight_loss'], social: '@kabir.trains',
    bio: 'Powerlifting on weekdays, football on weekends.',
    prs: [L('Deadlift', 220, 'kg', 1), L('Back squat', 180, 'kg', 3), L('Bench press', 120, 'kg', 3), L('Overhead press', 70, 'kg', 4)],
    messages: ['Welcome to the buddy list! Which gym are you at?', 'Hey Kabir! Phool Gobhi ka gym, evenings mostly'] },
];

function loadSecret() {
  // fixed, allowlisted arguments only; credentials stay in memory
  return JSON.parse(execFileSync('gcloud.cmd', ['secrets', 'versions', 'access', 'latest', '--secret=auth-service-secrets-prod', '--project=phool-gobhi'],
    { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000 }));
}
const dobFor = (age) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - age); d.setUTCDate(d.getUTCDate() - 100); return d.toISOString().slice(0, 10); };
const place = (lat, lng, km, bearing) => { const r = (bearing * Math.PI) / 180; return { lat: lat + (km * Math.cos(r)) / 111, lng: lng + (km * Math.sin(r)) / (111 * Math.cos((lat * Math.PI) / 180)) }; };
const photoUrls = (slug, n, index) => Array.from({ length: n }, (_, i) => i === 0 ? `https://i.pravatar.cc/1080?img=${(index * 7) % 70 + 1}` : `https://picsum.photos/seed/review-buddy-${slug}-${i}/1080/1350`);

async function main() {
  const args = process.argv.slice(2);
  for (const a of args) if (!['--apply', '--remove', '--confirm-prod'].includes(a)) throw Error(`Unknown argument ${a}`);
  const apply = args.includes('--apply'), remove = args.includes('--remove');
  if (apply && !args.includes('--confirm-prod')) { console.log('Add --confirm-prod to write to PRODUCTION.'); }
  const live = apply && args.includes('--confirm-prod');

  const client = new Client({ connectionString: loadSecret().DATABASE_URL, connectionTimeoutMillis: 15000, query_timeout: 30000 });
  await client.connect();
  try {
    const v = (await client.query(`SELECT u.id,u.phone,u.role,u."isActive",b.lat,b.lng FROM auth."User" u LEFT JOIN buddy."BuddyProfile" b ON b."userId"=u.id WHERE u.id=$1`, [VIEWER_ID])).rows[0];
    if (!v || v.phone !== VIEWER_PHONE || v.role !== 'customer' || !v.isActive) throw Error('Account 22 is not the active 9999999999 customer');
    if (v.lat == null) throw Error('Account 22 has no buddy profile yet; create it in the app first (its location places the demo buddies)');
    const existing = (await client.query(`SELECT id FROM auth."User" WHERE email LIKE $1`, [`${EMAIL_PREFIX}%@${EMAIL_DOMAIN}`])).rows.map((r) => r.id);
    console.log(JSON.stringify({ mode: !live ? (remove ? 'plan-remove' : 'plan') : (remove ? 'remove' : 'apply'), environment: 'prod', viewer: VIEWER_ID, existingDemoBuddies: existing.length, buddies: CAST.map((c) => c.name), discoverable: false }));
    if (!live) { console.log('Nothing written.'); return; }

    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('review-demo-buddies-22'))`);

    if (remove) {
      if (existing.length) {
        const ms = (await client.query(`SELECT id FROM buddy."Match" WHERE "userLowId"=ANY($1) OR "userHighId"=ANY($1)`, [existing])).rows.map((m) => m.id);
        await client.query('SAVEPOINT ps'); try { await client.query(`DELETE FROM challenge."PairedStreak" WHERE "matchId"=ANY($1)`, [ms]); } catch { await client.query('ROLLBACK TO ps'); }
        await client.query(`DELETE FROM buddy."ChatMessage" WHERE "matchId"=ANY($1)`, [ms]);
        await client.query(`DELETE FROM buddy."Match" WHERE id=ANY($1)`, [ms]);
        await client.query(`DELETE FROM buddy."Swipe" WHERE "swiperId"=ANY($1) OR "swipeeId"=ANY($1)`, [existing]);
        await client.query(`DELETE FROM buddy."BuddyProfile" WHERE "userId"=ANY($1)`, [existing]); // photos, records, filter cascade
        await client.query(`DELETE FROM auth."User" WHERE id=ANY($1) AND email LIKE $2`, [existing, `${EMAIL_PREFIX}%@${EMAIL_DOMAIN}`]);
      }
      await client.query('COMMIT');
      console.log(JSON.stringify({ committed: true, removedDemoBuddies: existing.length })); return;
    }

    const out = { users: 0, profiles: 0, matches: 0, messagesAdded: 0, pairedStreak: 'skipped' };
    const matchIds = [];
    for (const [index, d] of CAST.entries()) {
      const u = await client.query(`
        INSERT INTO auth."User" (name, email, role, type, "isActive", gender, "dateOfBirth", "fitnessGoals", "updatedAt")
        VALUES ($1,$2,'customer','general',true,$3,$4,$5,now())
        ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, gender=EXCLUDED.gender, "dateOfBirth"=EXCLUDED."dateOfBirth", "fitnessGoals"=EXCLUDED."fitnessGoals", "updatedAt"=now()
        RETURNING id`, [d.name, emailOf(d.slug), d.gender, dobFor(d.age), d.goals]);
      const uid = u.rows[0].id; out.users++;
      const { lat, lng } = place(v.lat, v.lng, d.km, d.bearing);
      const p = await client.query(`
        INSERT INTO buddy."BuddyProfile" ("userId", bio, "socialMediaUrl", gender, "dateOfBirth", "fitnessGoals", "lastSyncedAt", lat, lng, "isDiscoverable", "isActive", "isShareable", "updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8,false,true,$9,now())
        ON CONFLICT ("userId") DO UPDATE SET bio=EXCLUDED.bio, "socialMediaUrl"=EXCLUDED."socialMediaUrl", gender=EXCLUDED.gender, "dateOfBirth"=EXCLUDED."dateOfBirth",
          "fitnessGoals"=EXCLUDED."fitnessGoals", "lastSyncedAt"=now(), lat=EXCLUDED.lat, lng=EXCLUDED.lng, "isDiscoverable"=false, "isActive"=true, "isShareable"=EXCLUDED."isShareable", "moderationHoldAt"=NULL, "womenOnlyBlocked"=false, "updatedAt"=now()
        RETURNING id`, [uid, d.bio, d.social, d.gender, dobFor(d.age), d.goals, lat, lng, d.share]);
      const pid = p.rows[0].id; out.profiles++;
      await client.query(`DELETE FROM buddy."BuddyPhoto" WHERE "buddyProfileId"=$1`, [pid]);
      const urls = photoUrls(d.slug, d.photos, index);
      for (const [order, url] of urls.entries()) await client.query(`INSERT INTO buddy."BuddyPhoto" ("buddyProfileId", url, "order") VALUES ($1,$2,$3)`, [pid, url, order]);
      await client.query(`UPDATE auth."User" SET "profileImageUrl"=$2 WHERE id=$1`, [uid, urls[0]]);
      await client.query(`DELETE FROM buddy."BuddyPersonalRecord" WHERE "buddyProfileId"=$1`, [pid]);
      for (const [i, r] of d.prs.entries()) await client.query(`INSERT INTO buddy."BuddyPersonalRecord" ("buddyProfileId","exerciseId","exerciseName",weight,unit,reps,"createdAt") VALUES ($1,$2,$3,$4,$5,$6, now() - ($7 || ' days')::interval)`, [pid, 9000 + i, r.name, r.weight, r.unit, r.reps, String((i * 5 + 3) % 40)]);

      // mutual likes + an active match, kept alive (lastActivityAt = now) on every run
      for (const [a, b] of [[VIEWER_ID, uid], [uid, VIEWER_ID]]) await client.query(`INSERT INTO buddy."Swipe" ("swiperId","swipeeId",action) VALUES ($1,$2,'like') ON CONFLICT ("swiperId","swipeeId") DO NOTHING`, [a, b]);
      const low = Math.min(VIEWER_ID, uid), high = Math.max(VIEWER_ID, uid);
      const m = await client.query(`
        INSERT INTO buddy."Match" ("userLowId","userHighId",status,"lastActivityAt") VALUES ($1,$2,'active',now())
        ON CONFLICT ("userLowId","userHighId") DO UPDATE SET status='active', "unmatchedBy"=NULL, "unmatchedAt"=NULL, "lastActivityAt"=now()
        RETURNING id`, [low, high]);
      const mid = m.rows[0].id; matchIds.push({ id: mid, other: uid }); out.matches++;
      // only seed the conversation if it is empty, so a reviewer's own messages are never touched
      const has = (await client.query(`SELECT 1 FROM buddy."ChatMessage" WHERE "matchId"=$1 LIMIT 1`, [mid])).rowCount;
      if (!has) for (const [i, body] of d.messages.entries()) {
        await client.query(`INSERT INTO buddy."ChatMessage" ("matchId","senderId",body,"createdAt") VALUES ($1,$2,$3, now() - ($4 || ' minutes')::interval)`, [mid, i % 2 === 0 ? uid : VIEWER_ID, body, String((d.messages.length - i) * 9 + 20)]);
        out.messagesAdded++;
      }
    }

    // a paired streak with the first buddy; optional, so a schema surprise cannot undo the rest
    await client.query('SAVEPOINT paired');
    try {
      const first = matchIds[0];
      const wk = (await client.query(`SELECT (date_trunc('week', (now() AT TIME ZONE 'Asia/Kolkata')) - interval '7 days')::timestamptz AS w`)).rows[0].w;
      if (!(await client.query(`SELECT 1 FROM challenge."PairedStreak" WHERE "matchId"=$1`, [first.id])).rowCount) {
        await client.query(`INSERT INTO challenge."PairedStreak" ("matchId","userAId","userBId","currentStreak","longestStreak","lastQualifiedWeekStart","updatedAt") VALUES ($1,$2,$3,2,3,$4,now())`, [first.id, VIEWER_ID, first.other, wk]);
        out.pairedStreak = 'created';
      } else out.pairedStreak = 'exists';
    } catch (e) { await client.query('ROLLBACK TO paired'); out.pairedStreak = 'skipped: ' + e.message.split('\n')[0]; }

    await client.query('COMMIT');
    console.log(JSON.stringify({ committed: true, ...out }));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { await client.end(); }
}
main().catch((err) => { console.error(JSON.stringify({ error: err.message, code: err.code, detail: err.detail })); process.exitCode = 1; });
