// Dev-only buddy fixtures: one of every kind of profile the swipe deck, the
// matched-profile view and the consistency league can show. Nothing here
// touches payments, notifications, rewards or config.
//
// Preview (writes nothing):  node deploy/scripts/seed-dev-buddy-profiles.cjs --user-id 357
// Apply:                     node deploy/scripts/seed-dev-buddy-profiles.cjs --user-id 357 --apply
// Remove every fixture:      node deploy/scripts/seed-dev-buddy-profiles.cjs --user-id 357 --remove --apply
//
// --user-id is the (existing, active) customer who will look at the deck. It
// must already have a buddy profile: its location and filters decide which
// fixtures it can see, and the preview says which and why.
//
// Fixtures are marked by their email (buddy-demo-<slug>@dev.phoolgobhi.invalid)
// and are safe to re-run: everything is upserted or replaced, nothing outside
// that marker is ever deleted. Reads only the explicitly named *-secrets-dev
// secrets; credentials stay in memory. Photos are links to public placeholder
// images (pravatar / picsum), not uploads.
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const path = require('node:path');
const { Client } = createRequire(path.join(__dirname, '../../package.json'))('pg');

const PROJECT = 'phool-gobhi';
const EMAIL_DOMAIN = 'dev.phoolgobhi.invalid';
const EMAIL_PREFIX = 'buddy-demo-';
const SNAPSHOT_VERSION = 'dev-buddy-demo-v1';

// ---------------------------------------------------------------------------
// The cast. `note` says what each one is there to show.
//   km/bearing  where they live relative to the viewer
//   share       isShareable (code, PRs, followers, health score on the card)
//   health      7-day health score to seed, or null for "no data yet"
//   followers   how many fixture fans follow them
//   likesYou    they already liked the viewer (a like-back makes a match)
//   matched     already matched with the viewer, with a short chat
// ---------------------------------------------------------------------------
const L = (name, weight, unit, reps) => ({ name, weight, unit, reps });
const LONG_BIO = 'Early-morning lifter, desk job by day. I train five days a week - strength block in winter, a bit of running when the weather turns. Looking for someone who actually turns up at 6am and does not mind a long warm-up. Happy to spot, happy to be spotted. I like tracking numbers, comparing notes on programs, and eating far too much after leg day. New to the city and still finding my gym crowd, so say hi - I promise I am more fun once the first set is done. Coffee after is non-negotiable.';

const CAST = [
  { slug: 'aanya', name: 'Aanya Sharma', gender: 'female', age: 27, km: 2, bearing: 20, photos: 6, share: true, health: 92, followers: 24,
    goals: ['muscle_gain', 'general_fitness', 'sports_training', 'flexibility_yoga'], social: '@aanya.lifts', likesYou: true,
    bio: LONG_BIO,
    prs: [L('Back squat', 140, 'kg', 3), L('Deadlift', 180, 'kg', 1), L('Bench press', 82.5, 'kg', 5), L('Overhead press', 55, 'kg', 5), L('Barbell row', 90, 'kg', 6),
      L('Front squat', 110, 'kg', 3), L('Romanian deadlift', 140, 'kg', 8), L('Pull-up (weighted)', 20, 'kg', 8), L('Hip thrust', 200, 'kg', 5),
      L('Incline dumbbell press', 36, 'kg', 10), L('Leg press', 300, 'kg', 10), L('Bicep curl', 20, 'kg', 12)],
    note: 'Star profile: everything on - 6 photos, long bio, 4 goals, 12 PRs, 24 followers, health 92, likes you' },
  { slug: 'kabir', name: 'Kabir Malhotra', gender: 'male', age: 31, km: 4, bearing: 110, photos: 4, share: true, health: 78, followers: 9,
    goals: ['muscle_gain', 'weight_loss'], social: '@kabir.trains', likesYou: true,
    bio: 'Powerlifting on weekdays, football on weekends.',
    prs: [L('Deadlift', 220, 'kg', 1), L('Back squat', 180, 'kg', 3), L('Bench press', 120, 'kg', 3), L('Overhead press', 70, 'kg', 4), L('Barbell row', 100, 'kg', 6)],
    note: 'Sharer, strong lifts, health 78, 9 followers, likes you' },
  { slug: 'neha', name: 'Neha Iyer', gender: 'female', age: 24, km: 1, bearing: 200, photos: 3, share: true, health: 64, followers: 3,
    goals: ['weight_loss'], social: null, prs: [],
    bio: 'Just getting started. Be kind!',
    note: 'Sharer with NO PRs: pills show health + followers, no lifts block' },
  { slug: 'rohan', name: 'Rohan Das', gender: 'male', age: 29, km: 6, bearing: 300, photos: 3, share: true, health: null, followers: 0,
    goals: ['sports_training'], social: null,
    bio: 'Cricket in the evenings, gym in the mornings.',
    prs: [L('Back squat', 120, 'kg', 5), L('Bench press', 90, 'kg', 5), L('Deadlift', 150, 'kg', 3)],
    note: 'Sharer with PRs but NO health data and 0 followers (those pills are simply absent)' },
  { slug: 'meera', name: 'Meera Nair', gender: 'female', age: 35, km: 3, bearing: 70, photos: 3, share: false, health: 88, followers: 12,
    goals: ['flexibility_yoga', 'general_fitness', 'rehabilitation'], social: '@meera.moves', prs: [L('Deadlift', 100, 'kg', 5)],
    bio: 'Yoga teacher, recovering from a knee injury and building strength back slowly.',
    note: 'NOT sharing: has PRs/health/followers in the DB but none may show; just photos, bio, goals' },
  { slug: 'arjun', name: 'Arjun', gender: 'male', age: 26, km: 8, bearing: 160, photos: 3, share: false, health: null, followers: 0,
    goals: [], social: null, bio: '', prs: [],
    note: 'Bare profile: single name, no bio, no goals, not sharing' },
  { slug: 'ananya', name: 'अनन्या शर्मा', gender: 'female', age: 22, km: 5, bearing: 250, photos: 4, share: true, health: 85, followers: 6,
    goals: ['general_fitness', 'weight_loss'], social: '@ananya.fit',
    bio: 'कॉलेज के बाद जिम। नए वर्कआउट पार्टनर की तलाश है!',
    prs: [L('Back squat', 70, 'kg', 5), L('Deadlift', 90, 'kg', 3), L('Hip thrust', 100, 'kg', 8)],
    note: 'Devanagari name and bio (name shortens to the first initial of the surname)' },
  { slug: 'sana', name: 'Sana Fernandes Khan', gender: 'female', age: 41, km: 12, bearing: 340, photos: 3, share: true, health: 55, followers: 4,
    goals: ['rehabilitation', 'general_fitness'], social: null,
    bio: 'Back to training after a long break.',
    prs: [L('Leg press', 120, 'kg', 10), L('Lat pulldown', 45, 'kg', 10)],
    note: 'Three-part name (shows as "Sana K."), mid-distance, health 55' },
  { slug: 'dev', name: 'Dev Patel', gender: 'male', age: 19, km: 3, bearing: 30, photos: 3, share: false, health: null, followers: 0,
    goals: ['muscle_gain'], social: null, prs: [],
    bio: 'First year, first time in a gym, first time on this app. I do not know what a deload is but I am willing to learn. Ask me about my cricket stats, not my bench press. Looking for someone patient who will not laugh when I misload the bar. Please tell me which protein powder is actually worth buying, because the internet has given me forty answers and none agree. Happy to learn, happy to train, happy to carry the plates back. I show up early and I always re-rack.',
    note: 'Youngest age (19), a bio at the length limit, not sharing' },
  { slug: 'ishita', name: 'Ishita Rao', gender: 'female', age: 52, km: 7, bearing: 90, photos: 5, share: true, health: 71, followers: 15,
    goals: ['general_fitness', 'muscle_gain'], social: '@ishita.rao',
    bio: 'Masters lifter. Age is just a number on the bar.',
    prs: [L('Single-arm dumbbell Romanian deadlift with a long pause at the bottom', 102.5, 'lb', 12), L('Back squat', 95, 'kg', 5), L('Bench press', 60, 'kg', 5)],
    note: 'Long exercise name, lb with a fractional weight, age 52' },
  { slug: 'vikram', name: 'Vikram Chauhan', gender: 'male', age: 58, km: 9, bearing: 270, photos: 3, share: false, health: null, followers: 0,
    goals: ['general_fitness'], social: null, prs: [],
    bio: 'Walking, light weights, long chats.',
    note: 'Oldest age (58), not sharing' },
  { slug: 'tara', name: 'Tara Menon', gender: 'female', age: 28, km: 3, bearing: 135, photos: 4, share: true, health: 80, followers: 7,
    goals: ['muscle_gain'], social: '@tara.m', womenOnly: true,
    bio: 'Women-only mode is on for me.',
    prs: [L('Back squat', 100, 'kg', 5), L('Deadlift', 125, 'kg', 3)],
    note: 'Women-only mode: only a WOMAN viewer can ever see her' },
  { slug: 'farhan', name: 'Farhan Ali', gender: 'male', age: 33, km: 22, bearing: 45, photos: 3, share: true, health: 60, followers: 2,
    goals: ['sports_training'], social: null,
    bio: 'Far across town.',
    prs: [L('Bench press', 100, 'kg', 5)],
    note: 'Far away (22 km): shown only if your radius reaches that far' },
  { slug: 'priya', name: 'Priya Verma', gender: 'other', age: 25, km: 5, bearing: 190, photos: 3, share: true, health: 74, followers: 5,
    goals: ['flexibility_yoga', 'general_fitness'], social: '@priya.v',
    bio: 'Climbing, yoga and the occasional heavy day.',
    prs: [L('Pull-up (weighted)', 15, 'kg', 6), L('Deadlift', 110, 'kg', 5)],
    note: 'Gender "other"' },
  { slug: 'liam', name: "Liam O'Connor", gender: 'male', age: 27, km: 2, bearing: 320, photos: 6, share: true, health: 83, followers: 18,
    goals: ['muscle_gain', 'sports_training'], social: '@liam.oc',
    bio: 'Rugby off-season. Bulking, apparently.',
    prs: [L('Back squat', 160, 'kg', 3), L('Bench press', 110, 'kg', 4), L('Deadlift', 200, 'kg', 2), L('Power clean', 100, 'kg', 3)],
    note: "Apostrophe in the surname (shows as \"Liam O.\"), 6 photos" },
  // Already matched with the viewer, so they live in Matches, not the deck.
  { slug: 'maya', name: 'Maya Kapoor', gender: 'female', age: 27, km: 3, bearing: 15, photos: 5, share: true, health: 90, followers: 11,
    goals: ['general_fitness', 'muscle_gain'], social: '@maya.kapoor', matched: true,
    bio: 'Marathon in spring, deadlifts in winter.',
    prs: [L('Deadlift', 130, 'kg', 3), L('Back squat', 100, 'kg', 5)],
    messages: ['Hey! Saw you also train at 6am', 'Yes! Chest day tomorrow if you are around?', 'I am in. Spotting each other?'],
    note: 'MATCH: sharing, social handle, PRs - full matched profile with the Social chip' },
  { slug: 'sameer', name: 'Sameer Joshi', gender: 'male', age: 30, km: 4, bearing: 215, photos: 3, share: false, health: null, followers: 0,
    goals: ['weight_loss'], social: '@sameerj', matched: true, prs: [],
    bio: 'Down 12 kg and counting.',
    messages: ['Hi! Nice to match', 'Hey Sameer, how is the cut going?'],
    note: 'MATCH: not sharing, but a social handle - matches still see it, code stays hidden' },
];

const FAN_COUNT = 24;

// ---------------------------------------------------------------------------

function loadSecret(service) {
  if (!['auth-service', 'buddy-service', 'health-service'].includes(service)) throw Error('Unsupported service');
  // All shell arguments are fixed strings from the allowlist above.
  return JSON.parse(execFileSync('gcloud.cmd', [
    'secrets', 'versions', 'access', 'latest',
    `--secret=${service}-secrets-dev`, `--project=${PROJECT}`,
  ], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000 }));
}

const emailOf = (slug) => `${EMAIL_PREFIX}${slug}@${EMAIL_DOMAIN}`;
const fanEmail = (i) => `${EMAIL_PREFIX}fan${String(i).padStart(2, '0')}@${EMAIL_DOMAIN}`;

function dobFor(age) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - age);
  d.setUTCDate(d.getUTCDate() - 100); // comfortably past the birthday, so the age is exact
  return d.toISOString().slice(0, 10);
}

function ageOf(dob) {
  const d = new Date(dob), now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) a--;
  return a;
}

function place(lat, lng, km, bearing) {
  const rad = (bearing * Math.PI) / 180;
  return {
    lat: lat + (km * Math.cos(rad)) / 111,
    lng: lng + (km * Math.sin(rad)) / (111 * Math.cos((lat * Math.PI) / 180)),
  };
}

const photoUrls = (slug, n, index) => Array.from({ length: n }, (_, i) =>
  i === 0
    ? `https://i.pravatar.cc/1080?img=${(index * 7) % 70 + 1}`
    : `https://picsum.photos/seed/buddy-demo-${slug}-${i}/1080/1350`);

function lastSevenClosedDays() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const midnight = new Date(`${today}T00:00:00Z`).getTime();
  return Array.from({ length: 7 }, (_, i) => new Date(midnight - (7 - i) * 86400000).toISOString().slice(0, 10));
}

// What the viewer's own filter and profile let them see, and why not.
function visibility(viewer, demo, pos) {
  const f = viewer.filter || {};
  const age = demo.age;
  const km = demo.km;
  const reasons = [];
  if (km > (f.radiusKm ?? 25)) reasons.push(`outside your ${f.radiusKm ?? 25} km radius`);
  if (f.minAge != null && (age < f.minAge || age > f.maxAge)) reasons.push(`age ${age} outside your ${f.minAge}-${f.maxAge}`);
  if (viewer.gender === 'female' && f.genders?.length && !f.womenOnly && !f.genders.includes(demo.gender)) reasons.push('not in your gender filter');
  if (viewer.gender === 'female' && f.womenOnly && demo.gender !== 'female') reasons.push('you are in women-only mode');
  if (f.fitnessGoals?.length && !demo.goals.some((g) => f.fitnessGoals.includes(g))) reasons.push('no goal in common with your goal filter');
  if (demo.womenOnly && viewer.gender !== 'female') reasons.push('women-only profile, you are not a woman');
  if (demo.matched) return { visible: false, label: 'in Matches (already matched)' };
  return reasons.length ? { visible: false, label: reasons.join('; ') } : { visible: true, label: 'in your deck' };
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(['--apply', '--remove', '--user-id']);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw Error(`Unknown argument ${args[i]}`);
    if (args[i] === '--user-id') i++;
  }
  const apply = args.includes('--apply');
  const remove = args.includes('--remove');
  const idArg = args[args.indexOf('--user-id') + 1];
  if (!idArg || !/^[1-9]\d*$/.test(idArg)) throw Error('Specify the viewing customer with --user-id <id>');
  const viewerId = Number(idArg);

  const secrets = Object.fromEntries(['auth-service', 'buddy-service', 'health-service'].map((s) => [s, loadSecret(s)]));
  const urls = Object.values(secrets).map((s) => s.DATABASE_URL);
  if (urls.some((u) => !u) || new Set(urls).size !== 1) throw Error('Expected one shared dev database across auth, buddy and health');
  const client = new Client({ connectionString: urls[0], connectionTimeoutMillis: 15000, query_timeout: 30000 });
  await client.connect();

  try {
    const vq = await client.query(`
      SELECT u.id, u.name, u.role, u."isActive", b.lat, b.lng, b.gender, b."dateOfBirth", b."isDiscoverable",
             f."radiusKm", f."minAge", f."maxAge", f.genders, f."fitnessGoals", f."womenOnly"
      FROM auth."User" u
      LEFT JOIN buddy."BuddyProfile" b ON b."userId" = u.id
      LEFT JOIN buddy."BuddyFilter" f ON f."userId" = u.id
      WHERE u.id = $1`, [viewerId]);
    const row = vq.rows[0];
    if (!row || row.role !== 'customer' || !row.isActive) throw Error('Expected one active customer account');
    if (row.lat == null) throw Error('That customer has no buddy profile yet - create one in the app first (its location places the fixtures)');
    const viewer = {
      id: row.id, name: row.name, gender: row.gender, lat: row.lat, lng: row.lng, isDiscoverable: row.isDiscoverable,
      filter: row.radiusKm == null ? null : {
        radiusKm: row.radiusKm, minAge: row.minAge, maxAge: row.maxAge, genders: row.genders, fitnessGoals: row.fitnessGoals, womenOnly: row.womenOnly,
      },
    };

    const existing = await client.query(`SELECT id, email FROM auth."User" WHERE email LIKE $1`, [`${EMAIL_PREFIX}%@${EMAIL_DOMAIN}`]);
    const plan = CAST.map((d) => ({ slug: d.slug, name: d.name, ...visibility(viewer, d), note: d.note }));
    console.log(JSON.stringify({
      mode: remove ? (apply ? 'remove' : 'plan-remove') : (apply ? 'apply' : 'plan'),
      environment: 'dev',
      viewer: { id: viewer.id, name: viewer.name, gender: viewer.gender, hasFilter: !!viewer.filter, discoverable: viewer.isDiscoverable },
      existingFixtures: existing.rowCount,
      fixtures: CAST.length, fans: FAN_COUNT,
    }));
    if (!remove) for (const p of plan) console.log(`  ${p.visible ? 'SEE ' : 'hide'}  ${p.name.padEnd(22)} ${p.label.padEnd(34)} ${p.note}`);
    if (!apply) { console.log('\nNothing written. Re-run with --apply.'); return; }

    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('dev-buddy-profile-seed'))`);
    const fixtureIds = existing.rows.map((r) => r.id);

    // ---- removal (also the first step of a re-seed's cleanliness) ----------
    if (remove) {
      if (fixtureIds.length) {
        const matches = await client.query(`SELECT id FROM buddy."Match" WHERE "userLowId" = ANY($1) OR "userHighId" = ANY($1)`, [fixtureIds]);
        await client.query(`DELETE FROM buddy."ChatMessage" WHERE "matchId" = ANY($1)`, [matches.rows.map((m) => m.id)]);
        await client.query(`DELETE FROM buddy."Match" WHERE id = ANY($1)`, [matches.rows.map((m) => m.id)]);
        await client.query(`DELETE FROM buddy."Swipe" WHERE "swiperId" = ANY($1) OR "swipeeId" = ANY($1)`, [fixtureIds]);
        await client.query(`DELETE FROM buddy."BuddyFollow" WHERE "followerId" = ANY($1) OR "targetId" = ANY($1)`, [fixtureIds]);
        await client.query(`DELETE FROM health."ScoreDaySnapshot" WHERE "userId" = ANY($1) AND "rulesVersion" = $2`, [fixtureIds, SNAPSHOT_VERSION]);
        await client.query(`DELETE FROM buddy."BuddyProfile" WHERE "userId" = ANY($1)`, [fixtureIds]); // photos, records, filter cascade
        await client.query(`DELETE FROM auth."User" WHERE id = ANY($1) AND email LIKE $2`, [fixtureIds, `${EMAIL_PREFIX}%@${EMAIL_DOMAIN}`]);
      }
      await client.query('COMMIT');
      console.log(JSON.stringify({ committed: true, removedFixtures: fixtureIds.length }));
      return;
    }

    // ---- create / refresh ---------------------------------------------------
    const days = lastSevenClosedDays();
    const profileIds = new Map(); // slug -> { userId, profileId, publicCode }
    let index = 0;

    async function upsertUser(email, name, gender, age, goals, image) {
      const r = await client.query(`
        INSERT INTO auth."User" (name, email, role, type, "isActive", gender, "dateOfBirth", "fitnessGoals", "updatedAt")
        VALUES ($1, $2, 'customer', 'general', true, $3, $4, $5, now())
        ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, gender = EXCLUDED.gender, "dateOfBirth" = EXCLUDED."dateOfBirth",
          "fitnessGoals" = EXCLUDED."fitnessGoals", "isActive" = true, "updatedAt" = now()
        RETURNING id`, [name, email, gender, dobFor(age), goals]);
      return r.rows[0].id;
    }

    for (const d of CAST) {
      const userId = await upsertUser(emailOf(d.slug), d.name, d.gender, d.age, d.goals);
      const { lat, lng } = place(viewer.lat, viewer.lng, d.km, d.bearing);
      const p = await client.query(`
        INSERT INTO buddy."BuddyProfile" ("userId", bio, "socialMediaUrl", gender, "dateOfBirth", "fitnessGoals", "lastSyncedAt", lat, lng,
                                          "isDiscoverable", "isActive", "isShareable", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, true, true, $9, now())
        ON CONFLICT ("userId") DO UPDATE SET bio = EXCLUDED.bio, "socialMediaUrl" = EXCLUDED."socialMediaUrl", gender = EXCLUDED.gender,
          "dateOfBirth" = EXCLUDED."dateOfBirth", "fitnessGoals" = EXCLUDED."fitnessGoals", "lastSyncedAt" = now(), lat = EXCLUDED.lat, lng = EXCLUDED.lng,
          "isDiscoverable" = true, "isActive" = true, "isShareable" = EXCLUDED."isShareable", "moderationHoldAt" = NULL, "womenOnlyBlocked" = false, "updatedAt" = now()
        RETURNING id, "publicCode"`,
      [userId, d.bio || null, d.social, d.gender, dobFor(d.age), d.goals, lat, lng, d.share]);
      const profileId = p.rows[0].id;
      profileIds.set(d.slug, { userId, profileId, publicCode: p.rows[0].publicCode });

      // photos: replaced wholesale
      await client.query(`DELETE FROM buddy."BuddyPhoto" WHERE "buddyProfileId" = $1`, [profileId]);
      const urls = photoUrls(d.slug, d.photos, index);
      for (const [order, url] of urls.entries()) {
        await client.query(`INSERT INTO buddy."BuddyPhoto" ("buddyProfileId", url, "order") VALUES ($1, $2, $3)`, [profileId, url, order]);
      }
      await client.query(`UPDATE auth."User" SET "profileImageUrl" = $2 WHERE id = $1`, [userId, urls[0]]);

      // personal records: staggered dates so the best one is not also the newest
      await client.query(`DELETE FROM buddy."BuddyPersonalRecord" WHERE "buddyProfileId" = $1`, [profileId]);
      for (const [i, r] of d.prs.entries()) {
        await client.query(`
          INSERT INTO buddy."BuddyPersonalRecord" ("buddyProfileId", "exerciseId", "exerciseName", weight, unit, reps, "createdAt")
          VALUES ($1, $2, $3, $4, $5, $6, now() - ($7 || ' days')::interval)`,
        [profileId, 9000 + i, r.name, r.weight, r.unit, r.reps, String((i * 5 + 3) % 40)]);
      }

      // filter row: only the women-only fixture has one
      await client.query(`DELETE FROM buddy."BuddyFilter" WHERE "userId" = $1`, [userId]);
      if (d.womenOnly) {
        await client.query(`INSERT INTO buddy."BuddyFilter" ("userId", "radiusKm", "minAge", "maxAge", genders, "fitnessGoals", "womenOnly", "updatedAt")
          VALUES ($1, 25, 18, 60, ARRAY['female']::buddy."Gender"[], ARRAY[]::buddy."FitnessGoal"[], true, now())`, [userId]);
      }

      // 7 closed days that average to the wanted health score (score = close / 500 * 100)
      await client.query(`DELETE FROM health."ScoreDaySnapshot" WHERE "userId" = $1 AND "rulesVersion" = $2`, [userId, SNAPSHOT_VERSION]);
      if (d.health != null) {
        const wobble = [-10, 5, 0, 10, -5, 0, 0]; // sums to zero, so the average is exact
        for (const [i, day] of days.entries()) {
          const close = Math.round(d.health * 5) + wobble[i];
          await client.query(`
            INSERT INTO health."ScoreDaySnapshot" ("userId", "localDate", "open", "high", "low", "close", "breakdown", "rulesVersion", "closedAt")
            VALUES ($1, $2::text, $3, $4, $3, $4, $5::jsonb, $6, ($2::text::date + interval '23 hours') AT TIME ZONE 'Asia/Kolkata')
            ON CONFLICT ("userId", "localDate") DO NOTHING`,
          [userId, day, close - 4, close, JSON.stringify([{ key: 'dev_buddy_demo', label: 'Dev buddy preview fixture', kind: 'earned', points: 4, detail: 'Synthetic development data; no coins awarded.' }]), SNAPSHOT_VERSION]);
        }
      }
      index++;
    }

    // fans: minimal, hidden profiles whose only job is to follow
    const fanUserIds = [];
    for (let i = 1; i <= FAN_COUNT; i++) {
      const userId = await upsertUser(fanEmail(i), `Fan ${i}`, i % 2 ? 'female' : 'male', 20 + (i % 15), []);
      await client.query(`
        INSERT INTO buddy."BuddyProfile" ("userId", gender, "dateOfBirth", lat, lng, "isDiscoverable", "isActive", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, false, true, now())
        ON CONFLICT ("userId") DO UPDATE SET "isDiscoverable" = false, "isActive" = true, "updatedAt" = now()`,
      [userId, i % 2 ? 'female' : 'male', dobFor(20 + (i % 15)), viewer.lat, viewer.lng]);
      fanUserIds.push(userId);
    }
    const everyId = [...profileIds.values()].map((v) => v.userId);
    await client.query(`DELETE FROM buddy."BuddyFollow" WHERE "followerId" = ANY($1) AND "targetId" = ANY($2)`, [fanUserIds, everyId]);
    let follows = 0;
    for (const d of CAST) {
      const target = profileIds.get(d.slug).userId;
      for (let i = 0; i < Math.min(d.followers, FAN_COUNT); i++) {
        await client.query(`INSERT INTO buddy."BuddyFollow" ("followerId", "targetId") VALUES ($1, $2) ON CONFLICT DO NOTHING`, [fanUserIds[i], target]);
        follows++;
      }
    }

    // the viewer sees every deck fixture afresh: forget any earlier swipes on them
    await client.query(`DELETE FROM buddy."Swipe" WHERE "swiperId" = $1 AND "swipeeId" = ANY($2)`, [viewer.id, everyId]);
    await client.query(`DELETE FROM buddy."Swipe" WHERE "swipeeId" = $1 AND "swiperId" = ANY($2)`, [viewer.id, everyId]);

    let likes = 0, matchesMade = 0, messagesMade = 0;
    for (const d of CAST) {
      const demo = profileIds.get(d.slug).userId;
      if (d.likesYou) {
        await client.query(`INSERT INTO buddy."Swipe" ("swiperId", "swipeeId", action) VALUES ($1, $2, 'like') ON CONFLICT ("swiperId", "swipeeId") DO NOTHING`, [demo, viewer.id]);
        likes++;
      }
      if (d.matched) {
        // mutual likes keep them out of the deck; the match puts them in Matches
        for (const [a, b] of [[viewer.id, demo], [demo, viewer.id]]) {
          await client.query(`INSERT INTO buddy."Swipe" ("swiperId", "swipeeId", action) VALUES ($1, $2, 'like') ON CONFLICT ("swiperId", "swipeeId") DO NOTHING`, [a, b]);
        }
        const low = Math.min(viewer.id, demo), high = Math.max(viewer.id, demo);
        const m = await client.query(`
          INSERT INTO buddy."Match" ("userLowId", "userHighId", status, "lastActivityAt") VALUES ($1, $2, 'active', now())
          ON CONFLICT ("userLowId", "userHighId") DO UPDATE SET status = 'active', "unmatchedBy" = NULL, "unmatchedAt" = NULL, "lastActivityAt" = now()
          RETURNING id`, [low, high]);
        matchesMade++;
        await client.query(`DELETE FROM buddy."ChatMessage" WHERE "matchId" = $1`, [m.rows[0].id]);
        for (const [i, body] of (d.messages || []).entries()) {
          await client.query(`INSERT INTO buddy."ChatMessage" ("matchId", "senderId", body, "createdAt") VALUES ($1, $2, $3, now() - ($4 || ' minutes')::interval)`,
            [m.rows[0].id, i % 2 === 0 ? demo : viewer.id, body, String((d.messages.length - i) * 7)]);
          messagesMade++;
        }
      }
    }

    await client.query('COMMIT');
    console.log(JSON.stringify({
      committed: true, environment: 'dev', fixtures: CAST.length, fans: FAN_COUNT, follows, likesToYou: likes, matches: matchesMade, messages: messagesMade,
      note: 'Decks are cached for up to 45 s per server instance; pull-to-refresh or wait a minute if they do not show at once.',
    }));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { await client.end(); }
}

main().catch((err) => { console.error(JSON.stringify({ error: err.message, code: err.code, detail: err.detail })); process.exitCode = 1; });
