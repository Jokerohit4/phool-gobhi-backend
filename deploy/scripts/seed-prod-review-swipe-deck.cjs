// App Review swipe-deck profiles for PRODUCTION account 9999999999 (user 22): people the reviewer
// can actually see in the deck, swipe on, and match with. Companion to
// seed-prod-review-account.cjs and seed-prod-review-buddies.cjs.
//
//   node deploy/scripts/seed-prod-review-swipe-deck.cjs                          (plan + exposure check, writes nothing)
//   node deploy/scripts/seed-prod-review-swipe-deck.cjs --apply --confirm-prod   (create / refresh)
//   node deploy/scripts/seed-prod-review-swipe-deck.cjs --remove --apply --confirm-prod
//
// These profiles ARE discoverable (that is the point), so they must not be visible to real users.
// The deck rule is two-way (buddyService.targetEligibility + distanceAcceptsBothWays): a profile is
// only shown to a viewer who passes the PROFILE'S OWN filter. Each demo profile therefore gets a
// BuddyFilter that only account 22 satisfies:
//   * age range = exactly account 22's age
//   * radius = small (RADIUS_KM) around account 22's saved location
//   * a female demo profile also only accepts the viewer's gender
// and the script COUNTS real discoverable users who would pass that filter. It refuses to write if the
// count is not zero (override: --allow-exposure, do not). Positions follow account 22's CURRENT saved
// location, so re-run it after that location changes (it moves them along and re-checks).
//
// Account 22's own filter also applies to the deck: its goal filter needs a shared goal, so every demo
// profile lists the goals the viewer filters on. The first LIKES_YOU of them have already liked the
// viewer, so swiping right on them makes a match; the rest do not.
//
// Only rows tied to the marker email review-deck-*@review.phoolgobhi.invalid are ever created,
// refreshed or removed. No phone numbers, no followers, no health scores (those could reach real
// users' leaderboards).
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const path = require('node:path');
const { Client } = createRequire(path.join(__dirname, '../../package.json'))('pg');

const VIEWER_ID = 22, VIEWER_PHONE = '9999999999';
const EMAIL_DOMAIN = 'review.phoolgobhi.invalid', EMAIL_PREFIX = 'review-deck-';
const RADIUS_KM = 15, LIKES_YOU = 4;
const emailOf = (slug) => `${EMAIL_PREFIX}${slug}@${EMAIL_DOMAIN}`;
const L = (name, weight, unit, reps) => ({ name, weight, unit, reps });

const CAST = [
  { slug: 'priya',  name: 'Priya Nair',      gender: 'female', age: 25, km: 2,  bearing: 20,  photos: 4, share: true,  extra: ['general_fitness', 'flexibility_yoga'], social: '@priya.moves',
    bio: 'Yoga in the morning, lifting after work. Looking for a buddy to keep me honest on leg day.',
    prs: [L('Back squat', 80, 'kg', 5), L('Deadlift', 100, 'kg', 3), L('Hip thrust', 110, 'kg', 8)] },
  { slug: 'daniel', name: 'Daniel Kim',      gender: 'male',   age: 29, km: 4,  bearing: 110, photos: 3, share: true,  extra: ['muscle_gain'], social: '@dkim.lifts',
    bio: 'Software engineer, weekend runner. Cutting right now and happy to share meal-prep ideas.',
    prs: [L('Deadlift', 160, 'kg', 3), L('Bench press', 95, 'kg', 5), L('Overhead press', 60, 'kg', 5)] },
  { slug: 'emily',  name: 'Emily Carter',    gender: 'female', age: 27, km: 6,  bearing: 200, photos: 5, share: true,  extra: ['general_fitness'], social: '@emily.trains',
    bio: 'Training for a half marathon. Always up for an early session and a coffee after.',
    prs: [L('Back squat', 90, 'kg', 5), L('Bench press', 55, 'kg', 5)] },
  { slug: 'arjun',  name: 'Arjun Mehta',     gender: 'male',   age: 31, km: 8,  bearing: 300, photos: 3, share: false, extra: ['sports_training'], social: null,
    bio: 'Cricket on weekends, gym on weekdays. Down 8 kg since March.', prs: [] },
  { slug: 'sofia',  name: 'Sofia Alvarez',   gender: 'female', age: 29, km: 11, bearing: 70,  photos: 4, share: true,  extra: ['muscle_gain', 'general_fitness'], social: '@sofia.lifts',
    bio: 'Powerlifting block this winter. I like numbers, programs and big plates.',
    prs: [L('Deadlift', 150, 'kg', 3), L('Back squat', 120, 'kg', 3), L('Bench press', 70, 'kg', 5)] },
  { slug: 'marcus', name: 'Marcus Johnson',  gender: 'male',   age: 33, km: 13, bearing: 160, photos: 3, share: false, extra: ['rehabilitation', 'general_fitness'], social: null,
    bio: 'Getting back into training after a long break. Patient spotter wanted.', prs: [] },
];

function loadSecret() {
  return JSON.parse(execFileSync('gcloud.cmd', ['secrets', 'versions', 'access', 'latest', '--secret=auth-service-secrets-prod', '--project=phool-gobhi'],
    { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000 }));
}
const dobFor = (age) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - age); d.setUTCDate(d.getUTCDate() - 100); return d.toISOString().slice(0, 10); };
const ageOf = (dob) => { const d = new Date(dob), n = new Date(); let a = n.getFullYear() - d.getFullYear(); if (n.getMonth() < d.getMonth() || (n.getMonth() === d.getMonth() && n.getDate() < d.getDate())) a--; return a; };
const place = (lat, lng, km, bearing) => { const r = (bearing * Math.PI) / 180; return { lat: lat + (km * Math.cos(r)) / 111, lng: lng + (km * Math.sin(r)) / (111 * Math.cos((lat * Math.PI) / 180)) }; };
const haversine = (a, b, c, d) => { const R = 6371, t = (x) => (x * Math.PI) / 180, dl = t(c - a), dg = t(d - b); const h = Math.sin(dl / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dg / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const photoUrls = (slug, n, index) => Array.from({ length: n }, (_, i) => i === 0 ? `https://i.pravatar.cc/1080?img=${(index * 11 + 5) % 70 + 1}` : `https://picsum.photos/seed/review-deck-${slug}-${i}/1080/1350`);

async function main() {
  const args = process.argv.slice(2);
  for (const a of args) if (!['--apply', '--remove', '--confirm-prod', '--allow-exposure'].includes(a)) throw Error(`Unknown argument ${a}`);
  const apply = args.includes('--apply'), remove = args.includes('--remove');
  if (apply && !args.includes('--confirm-prod')) console.log('Add --confirm-prod to write to PRODUCTION.');
  const live = apply && args.includes('--confirm-prod');

  const client = new Client({ connectionString: loadSecret().DATABASE_URL, connectionTimeoutMillis: 15000, query_timeout: 30000 });
  await client.connect();
  try {                                    // the finally below ALWAYS closes the connection, even on error
    const v = (await client.query(`
      SELECT u.id,u.phone,u.role,u."isActive" AS "userActive",b.lat,b.lng,b.gender,b."dateOfBirth",
             f."radiusKm" AS vr,f."minAge" AS vmin,f."maxAge" AS vmax,f."fitnessGoals" AS vgoals,f.genders AS vgenders
      FROM auth."User" u LEFT JOIN buddy."BuddyProfile" b ON b."userId"=u.id LEFT JOIN buddy."BuddyFilter" f ON f."userId"=u.id WHERE u.id=$1`, [VIEWER_ID])).rows[0];
    if (!v || v.phone !== VIEWER_PHONE || v.role !== 'customer' || !v.userActive) throw Error('Account 22 is not the active 9999999999 customer');
    if (v.lat == null) throw Error('Account 22 has no buddy profile yet');
    const viewerAge = ageOf(v.dateOfBirth);
    // pg hands back enum[] columns as text like '{weight_loss,general_fitness}', not as an array
    const enumList = (x) => (Array.isArray(x) ? x : String(x || '').replace(/^\{|\}$/g, '').split(',').map((t) => t.trim()).filter(Boolean));
    const viewerGoals = enumList(v.vgoals);
    const existing = (await client.query(`SELECT id FROM auth."User" WHERE email LIKE $1`, [`${EMAIL_PREFIX}%@${EMAIL_DOMAIN}`])).rows.map((r) => r.id);

    // real, discoverable people: the only ones who could ever see a demo profile
    const real = (await client.query(`
      SELECT bp."userId",bp.lat,bp.lng,bp.gender,bp."dateOfBirth" FROM buddy."BuddyProfile" bp JOIN auth."User" u ON u.id=bp."userId"
      WHERE bp."isActive" AND bp."isDiscoverable" AND bp."userId"<>$1 AND u.email NOT LIKE 'review-%@review.phoolgobhi.invalid'`, [VIEWER_ID])).rows;

    const goalsFor = (d) => [...new Set([...(viewerGoals.length ? viewerGoals : ['weight_loss']), ...d.extra])];
    const planned = CAST.map((d) => {
      const pos = place(v.lat, v.lng, d.km, d.bearing);
      const exposed = real.filter((r) => haversine(pos.lat, pos.lng, r.lat, r.lng) <= RADIUS_KM && ageOf(r.dateOfBirth) === viewerAge && (d.gender !== 'female' || r.gender === v.gender)).length;
      return { d, pos, exposed };
    });
    const totalExposed = planned.reduce((n, p) => n + p.exposed, 0);
    console.log(JSON.stringify({
      mode: !live ? (remove ? 'plan-remove' : 'plan') : (remove ? 'remove' : 'apply'), environment: 'prod',
      viewer: { id: VIEWER_ID, gender: v.gender, age: viewerAge, lat: +v.lat.toFixed(3), lng: +v.lng.toFixed(3), radiusKm: v.vr ?? 25, minAge: v.vmin, maxAge: v.vmax, goalFilter: viewerGoals },
      existingDeckProfiles: existing.length, realDiscoverableProfiles: real.length,
      realUsersWhoCouldSeeADemoProfile: totalExposed,
      profiles: planned.map((p) => `${p.d.name} (${p.d.km} km, ${p.d.age}, ${p.d.slug === CAST[0].slug || CAST.indexOf(p.d) < LIKES_YOU ? 'likes you' : 'no like yet'})`),
    }));
    if (!remove && totalExposed > 0 && !args.includes('--allow-exposure')) throw Error(`Refusing: ${totalExposed} real user(s) could see a demo profile. Nothing written.`);
    if (!live) { console.log('Nothing written.'); return; }

    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('review-demo-deck-22'))`);
    if (remove) {
      if (existing.length) {
        await client.query(`DELETE FROM buddy."Swipe" WHERE "swiperId"=ANY($1) OR "swipeeId"=ANY($1)`, [existing]);
        const ms = (await client.query(`SELECT id FROM buddy."Match" WHERE "userLowId"=ANY($1) OR "userHighId"=ANY($1)`, [existing])).rows.map((m) => m.id);
        if (ms.length) {
          await client.query('SAVEPOINT ps'); try { await client.query(`DELETE FROM challenge."PairedStreak" WHERE "matchId"=ANY($1)`, [ms]); } catch { await client.query('ROLLBACK TO ps'); }
          await client.query(`DELETE FROM buddy."ChatMessage" WHERE "matchId"=ANY($1)`, [ms]);
          await client.query(`DELETE FROM buddy."Match" WHERE id=ANY($1)`, [ms]);
        }
        await client.query(`DELETE FROM buddy."BuddyProfile" WHERE "userId"=ANY($1)`, [existing]);
        await client.query(`DELETE FROM auth."User" WHERE id=ANY($1) AND email LIKE $2`, [existing, `${EMAIL_PREFIX}%@${EMAIL_DOMAIN}`]);
      }
      await client.query('COMMIT'); console.log(JSON.stringify({ committed: true, removedDeckProfiles: existing.length })); return;
    }

    const out = { profiles: 0, likesToYou: 0 };
    const ids = [];
    for (const [index, p] of planned.entries()) {
      const d = p.d, goals = goalsFor(d);
      const u = await client.query(`
        INSERT INTO auth."User" (name,email,role,type,"isActive",gender,"dateOfBirth","fitnessGoals","updatedAt") VALUES ($1,$2,'customer','general',true,$3,$4,$5,now())
        ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, gender=EXCLUDED.gender, "dateOfBirth"=EXCLUDED."dateOfBirth", "fitnessGoals"=EXCLUDED."fitnessGoals", "updatedAt"=now() RETURNING id`,
        [d.name, emailOf(d.slug), d.gender, dobFor(d.age), goals]);
      const uid = u.rows[0].id; ids.push(uid);
      const bp = await client.query(`
        INSERT INTO buddy."BuddyProfile" ("userId",bio,"socialMediaUrl",gender,"dateOfBirth","fitnessGoals","lastSyncedAt",lat,lng,"isDiscoverable","isActive","isShareable","updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8,true,true,$9,now())
        ON CONFLICT ("userId") DO UPDATE SET bio=EXCLUDED.bio,"socialMediaUrl"=EXCLUDED."socialMediaUrl",gender=EXCLUDED.gender,"dateOfBirth"=EXCLUDED."dateOfBirth","fitnessGoals"=EXCLUDED."fitnessGoals",
          "lastSyncedAt"=now(),lat=EXCLUDED.lat,lng=EXCLUDED.lng,"isDiscoverable"=true,"isActive"=true,"isShareable"=EXCLUDED."isShareable","moderationHoldAt"=NULL,"womenOnlyBlocked"=false,"updatedAt"=now() RETURNING id`,
        [uid, d.bio, d.social, d.gender, dobFor(d.age), goals, p.pos.lat, p.pos.lng, d.share]);
      const pid = bp.rows[0].id; out.profiles++;
      await client.query(`DELETE FROM buddy."BuddyPhoto" WHERE "buddyProfileId"=$1`, [pid]);
      for (const [order, url] of photoUrls(d.slug, d.photos, index).entries()) await client.query(`INSERT INTO buddy."BuddyPhoto" ("buddyProfileId",url,"order") VALUES ($1,$2,$3)`, [pid, url, order]);
      await client.query(`UPDATE auth."User" SET "profileImageUrl"=(SELECT url FROM buddy."BuddyPhoto" WHERE "buddyProfileId"=$1 ORDER BY "order" LIMIT 1) WHERE id=$2`, [pid, uid]);
      await client.query(`DELETE FROM buddy."BuddyPersonalRecord" WHERE "buddyProfileId"=$1`, [pid]);
      for (const [i, r] of d.prs.entries()) await client.query(`INSERT INTO buddy."BuddyPersonalRecord" ("buddyProfileId","exerciseId","exerciseName",weight,unit,reps,"createdAt") VALUES ($1,$2,$3,$4,$5,$6, now() - ($7 || ' days')::interval)`, [pid, 9100 + i, r.name, r.weight, r.unit, r.reps, String((i * 5 + 3) % 40)]);
      // the visibility lock: only the viewer's age, only nearby, and (for women) only the viewer's gender
      await client.query(`DELETE FROM buddy."BuddyFilter" WHERE "userId"=$1`, [uid]);
      await client.query(`INSERT INTO buddy."BuddyFilter" ("userId","radiusKm","minAge","maxAge",genders,"fitnessGoals","womenOnly","updatedAt") VALUES ($1,$2,$3,$3,$4::buddy."Gender"[],ARRAY[]::buddy."FitnessGoal"[],false,now())`,
        [uid, RADIUS_KM, viewerAge, d.gender === 'female' && v.gender ? [v.gender] : []]);
    }
    // fresh start: forget any earlier swipes between the viewer and these profiles, then add the likes
    await client.query(`DELETE FROM buddy."Swipe" WHERE ("swiperId"=$1 AND "swipeeId"=ANY($2)) OR ("swipeeId"=$1 AND "swiperId"=ANY($2))`, [VIEWER_ID, ids]);
    for (const [index, uid] of ids.entries()) {
      if (index < LIKES_YOU) { await client.query(`INSERT INTO buddy."Swipe" ("swiperId","swipeeId",action) VALUES ($1,$2,'like') ON CONFLICT ("swiperId","swipeeId") DO NOTHING`, [uid, VIEWER_ID]); out.likesToYou++; }
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ committed: true, ...out, note: 'The deck is cached for up to 45 s per server instance; pull to refresh or wait a minute.' }));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { await client.end(); }
}
main().catch((err) => { console.error(JSON.stringify({ error: err.message, code: err.code, detail: err.detail })); process.exitCode = 1; });
