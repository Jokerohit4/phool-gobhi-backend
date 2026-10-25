// Dev-only league fixtures. No notifications, payments, rewards or config writes.
// Preview: node deploy/scripts/seed-dev-consistency-league.cjs --user-id 7
// Apply:   node deploy/scripts/seed-dev-consistency-league.cjs --user-id 7 --apply
// Fixtures only (no existing customer account changed): --fixtures-only --apply
// Reads only the explicitly named *-secrets-dev secrets; credentials stay in memory.
const { execFileSync } = require('node:child_process');
const { createHmac } = require('node:crypto');
const { createRequire } = require('node:module');
const path = require('node:path');
const { Client } = createRequire(path.join(__dirname, '../../package.json'))('pg');

const PROJECT = 'phool-gobhi';
const BASE = 'https://gateway-dev-1077801427223.asia-south1.run.app';
const VERSION = 'dev-league-demo-v1';
const DEMOS = [
  ['asha', 'Asha', 474], ['ravi', 'Ravi', 450], ['neha', 'Neha', 425],
  ['arjun', 'Arjun', 385], ['meera', 'Meera', 355], ['kabir', 'Kabir', 315],
  ['sana', 'Sana', 275], ['dev', 'Dev', 210],
];

function loadSecret(service) {
  if (!['auth-service', 'buddy-service', 'health-service'].includes(service)) throw Error('Unsupported service');
  // All shell arguments are fixed strings from the allowlist above.
  return JSON.parse(execFileSync('gcloud.cmd', [
    'secrets', 'versions', 'access', 'latest',
    `--secret=${service}-secrets-dev`, `--project=${PROJECT}`,
  ], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000 }));
}

function daysBeforeToday() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const midnight = new Date(`${today}T00:00:00Z`).getTime();
  return Array.from({ length: 7 }, (_, i) => new Date(midnight - (7 - i) * 86400000).toISOString().slice(0, 10));
}

async function seedDays(client, userId, base, days) {
  let inserted = 0;
  for (const [index, localDate] of days.entries()) {
    const close = base + (index - 3) * 4;
    const open = close - 4;
    const result = await client.query(`
      INSERT INTO health."ScoreDaySnapshot"
        ("userId","localDate","open","high","low","close","breakdown","rulesVersion","closedAt")
      VALUES ($1,$2::text,$3,$4,$3,$4,$5::jsonb,$6,($2::text::date+interval '23 hours') AT TIME ZONE 'Asia/Kolkata')
      ON CONFLICT ("userId","localDate") DO NOTHING`,
    [userId, localDate, open, close, JSON.stringify([{ key: 'dev_league_demo', label: 'Dev league preview fixture', kind: 'earned', points: 4, detail: 'Synthetic development data; no coins awarded.' }]), VERSION]);
    inserted += result.rowCount;
  }
  return inserted;
}

async function verifyApi(userId, secret) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ id: userId, role: 'customer', type: 'general', iat: now, exp: now + 300 })}`;
  const token = `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
  const response = await fetch(`${BASE}/api/buddy/league`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(90000),
  });
  const body = await response.json();
  if (!response.ok) throw Error(`Dev league API returned ${response.status}: ${body.error || 'request failed'}`);
  const league = body.data;
  if (!Array.isArray(league?.league) || league.league.length < 9) throw Error('Dev API has fewer than nine league participants');
  if (!league.league.some(p => p.isMe) || league.myRank < 1) throw Error('Dev API is missing the signed-in customer');
  if (league.league.filter(p => p.score > 0).length < 8) throw Error('Dev API is not returning the seeded scores');
  if (league.league.some(p => !p.name || p.name === 'Buddy' || p.name === 'Unknown Buddy')) throw Error('Dev API is not resolving participant names');
  console.log(JSON.stringify({ api: 'verified', userId, totalParticipants: league.totalParticipants, myRank: league.myRank, leaderboard: league.league }, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(['--apply', '--fixtures-only', '--user-id', '--phone', '--verify-only']);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw Error('Unknown argument');
    if (['--user-id', '--phone'].includes(args[i])) i++;
  }
  const value = key => { const index = args.indexOf(key); return index < 0 ? null : args[index + 1]; };
  const fixturesOnly = args.includes('--fixtures-only');
  const apply = args.includes('--apply');
  const userId = value('--user-id');
  const phone = value('--phone')?.replace(/\D/g, '');
  const localPhone = phone?.length === 12 && phone.startsWith('91') ? phone.slice(2) : phone?.length === 11 && phone.startsWith('0') ? phone.slice(1) : phone;
  if (!fixturesOnly && !userId && !phone) throw Error('Specify a customer --user-id or --phone');
  if (userId && !/^[1-9]\d*$/.test(userId)) throw Error('Invalid user ID');
  if (phone && !/^\d{10,13}$/.test(phone)) throw Error('Invalid phone number');
  const secrets = Object.fromEntries(['auth-service', 'buddy-service', 'health-service'].map(service => [service, loadSecret(service)]));
  const urls = Object.values(secrets).map(s => s.DATABASE_URL);
  if (urls.some(url => !url) || new Set(urls).size !== 1) throw Error('Expected one shared dev database across auth, buddy and health');
  const client = new Client({ connectionString: urls[0], connectionTimeoutMillis: 15000, query_timeout: 20000 });
  await client.connect();
  let target;
  try {
    const days = daysBeforeToday();
    if (!fixturesOnly) {
      const result = await client.query(`SELECT id,name,role,"isActive" FROM auth."User" WHERE ${userId ? 'id=$1' : 'phone=$1'}`,
        userId ? [Number(userId)] : [localPhone]);
      if (result.rows.length !== 1 || result.rows[0].role !== 'customer' || !result.rows[0].isActive) throw Error('Expected exactly one active customer account');
      target = result.rows[0];
    }
    if (args.includes('--verify-only')) {
      if (!target) throw Error('API verification requires a target');
      await verifyApi(target.id, secrets['auth-service'].JWT_SECRET);
      return;
    }
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'plan', environment: 'dev', target: target || null, demoParticipants: DEMOS.length, closedDayWindow: days, preserveExistingSnapshots: true }));
    if (!apply) return;
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('dev-consistency-league-seed'))`);
    let insertedDays = 0;
    let attachedMatches = 0;
    const demoIds = [];
    for (const [slug, name, base] of DEMOS) {
      const email = `league-demo-${slug}@dev.phoolgobhi.invalid`;
      const result = await client.query(`INSERT INTO auth."User" (name,email,role,type,"isActive","updatedAt") VALUES ($1,$2,'customer','general',true,now()) ON CONFLICT (email) DO UPDATE SET "updatedAt"=now() RETURNING id,name,role`, [`${name} (Demo)`, email]);
      const demo = result.rows[0];
      if (demo.role !== 'customer' || demo.name !== `${name} (Demo)`) throw Error('Demo email belongs to a different account');
      demoIds.push(demo.id);
      await client.query(`INSERT INTO buddy."BuddyProfile" ("userId",bio,lat,lng,"isDiscoverable","isActive","updatedAt") VALUES ($1,'Synthetic dev league participant',28.4595,77.0266,false,true,now()) ON CONFLICT ("userId") DO NOTHING`, [demo.id]);
      insertedDays += await seedDays(client, demo.id, base, days);
      if (target) {
        const low = Math.min(target.id, demo.id), high = Math.max(target.id, demo.id);
        const blocked = await client.query(`SELECT id FROM buddy."BlockedUser" WHERE ("blockerId"=$1 AND "blockedId"=$2) OR ("blockerId"=$2 AND "blockedId"=$1)`, [low, high]);
        if (blocked.rowCount) throw Error('A demo participant was explicitly blocked; no matches were changed');
        const match = await client.query(`INSERT INTO buddy."Match" ("userLowId","userHighId",status,"lastActivityAt") VALUES ($1,$2,'active',now()) ON CONFLICT ("userLowId","userHighId") DO UPDATE SET "lastActivityAt"=now() WHERE buddy."Match".status='active' RETURNING id`, [low, high]);
        if (!match.rowCount) throw Error('A demo participant was explicitly unmatched; no matches were changed');
        attachedMatches += match.rowCount;
      }
    }
    if (target) insertedDays += await seedDays(client, target.id, 405, days);
    await client.query('COMMIT');
    console.log(JSON.stringify({ committed: true, environment: 'dev', demoIds, insertedScoreDays: insertedDays, attachedMatches, targetId: target?.id }));
    if (target) await verifyApi(target.id, secrets['auth-service'].JWT_SECRET);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { await client.end(); }
}
main().catch(err => { console.error(JSON.stringify({ error: err.message, code: err.code })); process.exitCode = 1; });
