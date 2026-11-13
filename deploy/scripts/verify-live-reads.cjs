// Read-only live smoke checks. Never emits account data, tokens or credentials.
const { execFileSync } = require('node:child_process');
const { createHmac } = require('node:crypto');
const { Client } = require('pg');
const environment = process.argv[2];
if (!['dev', 'prod'].includes(environment)) throw Error('Specify dev or prod');
function cloud(args) {
  return execFileSync(process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud', args,
    { shell: process.platform === 'win32', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
(async () => {
  const secret = JSON.parse(cloud(['secrets', 'versions', 'access', 'latest',
    `--secret=auth-service-secrets-${environment}`, '--project=phool-gobhi']));
  const client = new Client({ connectionString: secret.DATABASE_URL, connectionTimeoutMillis: 15000 });
  let user;
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    user = (await client.query(`SELECT id,role,type FROM auth."User"
      WHERE role='customer' AND "isActive"=true ORDER BY id LIMIT 1`)).rows[0];
    await client.query('ROLLBACK');
  } finally { await client.end(); }
  if (!user) throw Error('No existing active customer is available for read-only smoke checks');
  const encode = object => Buffer.from(JSON.stringify(object)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const signed = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ ...user, iat: now, exp: now + 300 });
  const bearer = signed + '.' + createHmac('sha256', secret.JWT_SECRET).update(signed).digest('base64url');
  const base = `https://gateway-${environment}-pwixdiy6va-el.a.run.app`;
  for (const [route, authenticated, expected] of [
    ['/health', false, 200], ['/api/auth/app-config', false, 200],
    ['/api/auth/me', false, 401], ['/api/auth/me', true, 200],
    ['/api/bookings/mine', true, 200], ['/api/wallet/subscriptions/mine', true, 200],
    ['/api/health/health-profile', true, 200],
  ]) {
    const started = Date.now();
    const response = await fetch(base + route, { signal: AbortSignal.timeout(30000),
      headers: authenticated ? { Authorization: 'Bearer ' + bearer } : {} });
    let body = null;
    try { body = await response.json(); } catch { /* Still report non-JSON failures by status. */ }
    const passed = response.status === expected && body && typeof body === 'object';
    console.log(JSON.stringify({ environment, route, authenticated, status: response.status,
      expected, milliseconds: Date.now() - started, passed }));
    if (!passed) process.exitCode = 1;
  }
})().catch(error => { console.error(JSON.stringify({ environment, failed: true, code: error.code || error.name })); process.exitCode = 1; });
