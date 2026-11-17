// Keeps the App Review swipe-deck profiles (seed-prod-review-swipe-deck.cjs) next to account 22
// (9999999999, user 22) wherever its SAVED buddy location moves. The deck only shows profiles within the
// viewer's radius (the server caps that at 100 km), and the saved location changes whenever the buddy
// profile is saved from the app, so without this the deck goes empty after someone saves from elsewhere.
//
//   node deploy/scripts/review-deck-follow-trigger.cjs                          (shows what it would do)
//   node deploy/scripts/review-deck-follow-trigger.cjs --test                   (tests inside a ROLLED-BACK transaction)
//   node deploy/scripts/review-deck-follow-trigger.cjs --install --confirm-prod
//   node deploy/scripts/review-deck-follow-trigger.cjs --drop --confirm-prod    (removes trigger + function)
//
// What it installs (one trigger + one function, nothing else; outside Prisma):
//   buddy.review_deck_follow_22()  trigger review_deck_follow_22 ON buddy."BuddyProfile"
//   AFTER UPDATE OF lat, lng, only for "userId" = 22. Moves the six review-deck-* profiles to the same
//   offsets the seed script uses (they must stay in step with CAST there) and keeps their age lock equal to
//   the viewer's age.
// Safety properties:
//   * FAIL CLOSED: if a REAL discoverable user of the viewer's age is within 30 km of the new location (a
//     demo profile's max offset 13 km + its 15 km radius), the profiles are NOT moved. The deck goes empty
//     instead of showing fake people to a real user. A WARNING is logged.
//   * It can never block a profile save: the body swallows every error (RAISE WARNING) and always returns NEW.
//   * SECURITY DEFINER, so it works even if buddy-service's DB role cannot read auth."User"; search_path pinned.
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const path = require('node:path');
const { Client } = createRequire(path.join(__dirname, '../../package.json'))('pg');

const VIEWER_ID = 22;
const OFFSETS = [['priya', 2, 20], ['daniel', 4, 110], ['emily', 6, 200], ['arjun', 8, 300], ['sofia', 11, 70], ['marcus', 13, 160]]; // slug, km, bearing: keep equal to the seed script
const GUARD_KM = 30;

const FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION buddy.review_deck_follow_22() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE exposed int; viewer_age int;
BEGIN
  BEGIN
    IF NEW.lat IS NOT DISTINCT FROM OLD.lat AND NEW.lng IS NOT DISTINCT FROM OLD.lng THEN RETURN NEW; END IF;
    IF NEW."dateOfBirth" IS NULL THEN RETURN NEW; END IF;
    viewer_age := extract(year from age(NEW."dateOfBirth"))::int;
    SELECT count(*) INTO exposed
      FROM buddy."BuddyProfile" r JOIN auth."User" ru ON ru.id = r."userId"
     WHERE r."isActive" AND r."isDiscoverable" AND r."userId" <> NEW."userId" AND r."dateOfBirth" IS NOT NULL
       AND COALESCE(ru.email, '') NOT LIKE 'review-%@review.phoolgobhi.invalid'
       AND extract(year from age(r."dateOfBirth"))::int = viewer_age
       AND 6371 * acos(least(1, cos(radians(NEW.lat)) * cos(radians(r.lat)) * cos(radians(r.lng) - radians(NEW.lng))
                                 + sin(radians(NEW.lat)) * sin(radians(r.lat)))) <= ${GUARD_KM};
    IF exposed > 0 THEN
      RAISE WARNING 'review_deck_follow_22: % real user(s) of age % within ${GUARD_KM} km of the new location; demo profiles NOT moved', exposed, viewer_age;
      RETURN NEW;
    END IF;
    UPDATE buddy."BuddyProfile" bp
       SET lat = NEW.lat + (o.km * cos(radians(o.bearing))) / 111.0,
           lng = NEW.lng + (o.km * sin(radians(o.bearing))) / (111.0 * cos(radians(NEW.lat))),
           "updatedAt" = now()
      FROM (VALUES ${OFFSETS.map(([s, k, b]) => `('${s}', ${k}, ${b})`).join(', ')}) AS o(slug, km, bearing), auth."User" u
     WHERE u.id = bp."userId" AND u.email = 'review-deck-' || o.slug || '@review.phoolgobhi.invalid';
    UPDATE buddy."BuddyFilter" f SET "minAge" = viewer_age, "maxAge" = viewer_age, "updatedAt" = now()
      FROM auth."User" u WHERE u.id = f."userId" AND u.email LIKE 'review-deck-%@review.phoolgobhi.invalid';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'review_deck_follow_22 skipped: %', SQLERRM;
  END;
  RETURN NEW;
END
$fn$;`;
const TRIGGER_SQL = `
DROP TRIGGER IF EXISTS review_deck_follow_22 ON buddy."BuddyProfile";
CREATE TRIGGER review_deck_follow_22 AFTER UPDATE OF lat, lng ON buddy."BuddyProfile"
  FOR EACH ROW WHEN (NEW."userId" = ${VIEWER_ID}) EXECUTE FUNCTION buddy.review_deck_follow_22();
COMMENT ON TRIGGER review_deck_follow_22 ON buddy."BuddyProfile" IS 'App Review: moves the review-deck-* demo profiles next to account 22 when its saved location changes. Remove with: node deploy/scripts/review-deck-follow-trigger.cjs --drop --confirm-prod';`;

function loadSecret() {
  return JSON.parse(execFileSync('gcloud.cmd', ['secrets', 'versions', 'access', 'latest', '--secret=auth-service-secrets-prod', '--project=phool-gobhi'],
    { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000 }));
}
const km = (a, b, c, d) => { const t = (x) => (x * Math.PI) / 180, dl = t(c - a), dg = t(d - b); const h = Math.sin(dl / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dg / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(h)); };

async function demoPositions(c) {
  return (await c.query(`SELECT u.email, bp.lat, bp.lng FROM buddy."BuddyProfile" bp JOIN auth."User" u ON u.id=bp."userId" WHERE u.email LIKE 'review-deck-%@review.phoolgobhi.invalid' ORDER BY u.email`)).rows;
}

async function main() {
  const args = process.argv.slice(2);
  for (const a of args) if (!['--install', '--drop', '--test', '--confirm-prod'].includes(a)) throw Error(`Unknown argument ${a}`);
  const confirm = args.includes('--confirm-prod');
  const client = new Client({ connectionString: loadSecret().DATABASE_URL, connectionTimeoutMillis: 15000, query_timeout: 30000 });
  const notices = []; client.on('notice', (n) => notices.push(n.message));
  await client.connect();
  try {                                    // always closes the connection
    const v = (await client.query(`SELECT u.phone, b.lat, b.lng, b."dateOfBirth" FROM auth."User" u JOIN buddy."BuddyProfile" b ON b."userId"=u.id WHERE u.id=$1`, [VIEWER_ID])).rows[0];
    if (!v || v.phone !== '9999999999') throw Error('Account 22 is not the 9999999999 customer');
    const present = (await client.query(`SELECT (SELECT count(*) FROM pg_trigger WHERE tgname='review_deck_follow_22' AND NOT tgisinternal)::int AS trig, (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='buddy' AND p.proname='review_deck_follow_22')::int AS fn`)).rows[0];
    const demos = (await demoPositions(client)).length;

    if (args.includes('--test')) {
      // Everything below happens inside ONE transaction that is rolled back, so account 22's real saved
      // location and the demo profiles are never changed for anyone else.
      const before = await demoPositions(client);
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '3s'`); await client.query(`SET LOCAL statement_timeout = '20s'`);
      await client.query(FUNCTION_SQL); await client.query(TRIGGER_SQL);   // test the exact code that would be installed
      const results = [];
      // T1: move account 22 to Bengaluru (no real users there): all six demo profiles must follow
      await client.query(`UPDATE buddy."BuddyProfile" SET lat=12.9716, lng=77.5946 WHERE "userId"=$1`, [VIEWER_ID]);
      const t1 = await demoPositions(client);
      const dists = t1.map((p) => +km(12.9716, 77.5946, p.lat, p.lng).toFixed(1)).sort((a, b) => a - b);
      const want = OFFSETS.map(([, k]) => k).sort((a, b) => a - b);
      results.push({ test: 'follows to Bengaluru', ok: JSON.stringify(dists.map(Math.round)) === JSON.stringify(want), distancesKm: dists, expectedKm: want });
      // T2: fail-closed guard. Put a REAL discoverable user of the same age 3 km from Mumbai, then move 22 to Mumbai
      const real = (await client.query(`SELECT r."userId" FROM buddy."BuddyProfile" r JOIN auth."User" u ON u.id=r."userId" WHERE r."isActive" AND r."isDiscoverable" AND r."userId"<>$1 AND COALESCE(u.email,'') NOT LIKE 'review-%@review.phoolgobhi.invalid' LIMIT 1`, [VIEWER_ID])).rows[0];
      if (real) {
        await client.query(`UPDATE buddy."BuddyProfile" SET lat=19.0760+0.027, lng=72.8777, "dateOfBirth"=$2 WHERE "userId"=$1`, [real.userId, v.dateOfBirth]);
        const pre = await demoPositions(client); notices.length = 0;
        await client.query(`UPDATE buddy."BuddyProfile" SET lat=19.0760, lng=72.8777 WHERE "userId"=$1`, [VIEWER_ID]);
        const post = await demoPositions(client);
        results.push({ test: 'refuses to move next to a real same-age user', ok: JSON.stringify(pre) === JSON.stringify(post) && notices.some((m) => /NOT moved/.test(m)), warning: notices.find((m) => /NOT moved/.test(m)) });
      } else results.push({ test: 'guard (no real discoverable user to test with)', ok: null });
      await client.query('ROLLBACK');
      const after = await demoPositions(client);
      const loc = (await client.query(`SELECT lat,lng FROM buddy."BuddyProfile" WHERE "userId"=$1`, [VIEWER_ID])).rows[0];
      console.log(JSON.stringify({ mode: 'test', results, afterRollback: { demoProfilesUnchanged: JSON.stringify(before) === JSON.stringify(after), account22LocationUnchanged: loc.lat === v.lat && loc.lng === v.lng, triggerInstalledAfterTest: (await client.query(`SELECT count(*)::int n FROM pg_trigger WHERE tgname='review_deck_follow_22'`)).rows[0].n } }, null, 1));
      return;
    }

    console.log(JSON.stringify({ mode: args.includes('--install') ? 'install' : args.includes('--drop') ? 'drop' : 'plan', environment: 'prod', alreadyInstalled: present, demoDeckProfiles: demos, account22Location: { lat: +v.lat.toFixed(3), lng: +v.lng.toFixed(3) } }));
    if (!(args.includes('--install') || args.includes('--drop')) || !confirm) { console.log(confirm ? '' : 'Nothing changed (add --install or --drop together with --confirm-prod).'); return; }
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '3s'`); await client.query(`SET LOCAL statement_timeout = '20s'`);
    if (args.includes('--drop')) {
      await client.query(`DROP TRIGGER IF EXISTS review_deck_follow_22 ON buddy."BuddyProfile"`);
      await client.query(`DROP FUNCTION IF EXISTS buddy.review_deck_follow_22()`);
    } else { await client.query(FUNCTION_SQL); await client.query(TRIGGER_SQL); }
    await client.query('COMMIT');
    const now = (await client.query(`SELECT (SELECT count(*) FROM pg_trigger WHERE tgname='review_deck_follow_22' AND NOT tgisinternal)::int AS trig`)).rows[0];
    console.log(JSON.stringify({ committed: true, triggerNow: now.trig }));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { await client.end(); }
}
main().catch((err) => { console.error(JSON.stringify({ error: err.message, code: err.code, detail: err.detail })); process.exitCode = 1; });
