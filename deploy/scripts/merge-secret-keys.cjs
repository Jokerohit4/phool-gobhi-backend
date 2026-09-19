#!/usr/bin/env node
/*
 * Merges keys into a service's consolidated SECRETS_JSON blob, without ever
 * printing a secret value.
 *
 * Every service reads ONE Secret Manager secret (<service>-secrets-<env>)
 * holding a JSON object that bootstrap-secrets.js copies onto process.env. So
 * adding a key means rewriting the whole blob — and the obvious way to do that
 * (`echo '{"NEW":"..."}' | gcloud secrets versions add ...`) replaces it,
 * dropping DATABASE_URL and INTERNAL_API_KEY and taking the service down on
 * its next cold start. This reads the current version, merges, and writes the
 * result back, which is the difference between adding a key and losing a
 * database.
 *
 * Values are read from stdin, never argv: an API key in argv is visible to
 * `ps` for the life of the process and lands in shell history.
 *
 * Every value is trimmed. A trailing newline pasted into a secret has broken
 * this fleet twice (internal-api-key-*, then all three cloudinary-*-prod), and
 * the failure is a confusing 401/403 from a credential that looks correct in
 * the console.
 *
 * Usage:
 *   node deploy/scripts/merge-secret-keys.cjs <service> <env> KEY [KEY...]
 *   node deploy/scripts/merge-secret-keys.cjs <service> <env> --from-json
 *
 * Examples:
 *   # prompts for each value on stdin
 *   node deploy/scripts/merge-secret-keys.cjs health-service dev \
 *     ASSISTANT_PROVIDER_API_KEY ASSISTANT_PROVIDER_BASE_URL ASSISTANT_PROVIDER_MODEL
 *
 *   # pipe a JSON object of keys to merge (no prompts, for scripted use)
 *   cat new-keys.json | node deploy/scripts/merge-secret-keys.cjs health-service dev --from-json
 *
 * Flags:
 *   --dry-run   show what would change (key names only) and write nothing
 *
 * Exit: 0 = merged (or dry run), 1 = refused or failed.
 */
const { execFileSync } = require('child_process');
const readline = require('readline');

const PROJECT = process.env.GCP_PROJECT || 'phool-gobhi';
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const fromJson = argv.includes('--from-json');
const [service, env, ...rest] = argv.filter((a) => !a.startsWith('--'));
const keys = rest;

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!service || !env) die('usage: merge-secret-keys.cjs <service> <env> KEY [KEY...] [--from-json] [--dry-run]');
if (!['dev', 'prod'].includes(env)) die(`env must be dev or prod, got "${env}"`);
// Both of these end up inside a --secret= argument that, on Windows, is parsed
// by a shell (see GCLOUD below). Anything outside this character set is
// rejected rather than escaped — a service name is always a plain slug, so
// there is no legitimate input this turns away.
if (!/^[a-z][a-z0-9-]*$/.test(service)) {
  die(`service must match /^[a-z][a-z0-9-]*$/, got "${service}"`);
}
if (!fromJson && keys.length === 0) die('name at least one KEY to merge, or pass --from-json');

const secretName = `${service}-secrets-${env}`;

// On Windows the gcloud entry point is a .cmd shim, and since the
// CVE-2024-27980 mitigation Node refuses to execFileSync a .cmd/.bat without
// a shell (EINVAL). So a shell is unavoidable there — which means argv now
// passes through cmd.exe parsing, and the two values that reach it have to be
// provably safe. Hence the strict patterns above: `service` is matched against
// [a-z0-9-] and `env` against a two-item allowlist before either is
// interpolated. The secret itself never touches argv at all; it travels on
// stdin precisely so this question cannot arise for the part that matters.
const ON_WINDOWS = process.platform === 'win32';
const GCLOUD = ON_WINDOWS ? 'gcloud.cmd' : 'gcloud';

function gcloud(args, opts = {}) {
  const base = { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, ...opts };
  if (!ON_WINDOWS) return execFileSync(GCLOUD, args, base);
  // Passing an args ARRAY alongside shell:true is deprecated (DEP0190),
  // because Node concatenates without escaping. So on Windows the command is
  // assembled here instead — which is only sound because every interpolated
  // value was validated against a strict pattern above, and the secret never
  // appears here at all.
  return execFileSync([GCLOUD, ...args].join(' '), { ...base, shell: true });
}

/** Reads one value without echoing it, so a shoulder-surfer or a screen share
 *  never sees the key. Falls back to a visible prompt when stdin is not a TTY
 *  (piped input), where muting is meaningless anyway. */
function promptHidden(label) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // Non-interactive: read a single line from the pipe.
      const rl = readline.createInterface({ input: process.stdin });
      rl.once('line', (line) => {
        rl.close();
        resolve(line);
      });
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      // Re-write the prompt with no echo of what was typed.
      if (['\n', '\r', ''].includes(char.toString())) return;
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(`${label}: `);
    };
    process.stdin.on('data', onData);
    rl.question(`${label}: `, (answer) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function collectFromPrompts(names) {
  const out = {};
  console.log('Values are not echoed. Press Enter to skip a key.\n');
  for (const name of names) {
    const raw = await promptHidden(name);
    if (raw.trim() === '') {
      console.log(`  ${name}: skipped`);
      continue;
    }
    out[name] = raw;
  }
  return out;
}

function collectFromStdin() {
  const raw = require('fs').readFileSync(0, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    die(`--from-json expects a JSON object on stdin: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    die('--from-json expects a JSON OBJECT of { KEY: "value" }');
  }
  return parsed;
}

(async () => {
  // --- read what is there now ----------------------------------------------
  let currentRaw;
  try {
    currentRaw = gcloud([
      'secrets', 'versions', 'access', 'latest',
      `--secret=${secretName}`, `--project=${PROJECT}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    die(
      `could not read ${secretName}. Either it does not exist yet, or this account ` +
      `lacks secretAccessor on it.\n  ${String(err.stderr || err.message).trim()}`
    );
  }

  let current;
  try {
    current = JSON.parse(currentRaw);
  } catch (err) {
    die(
      `${secretName} is not valid JSON, so merging into it would corrupt it. ` +
      `Inspect it by hand before continuing.\n  ${err.message}`
    );
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    die(`${secretName} is not a JSON object — refusing to merge.`);
  }

  const before = Object.keys(current).sort();
  console.log(`${secretName} currently holds ${before.length} key(s): ${before.join(', ')}\n`);

  // --- collect the new values ----------------------------------------------
  const incoming = fromJson ? collectFromStdin() : await collectFromPrompts(keys);
  const names = Object.keys(incoming);
  if (names.length === 0) die('nothing to merge — every value was skipped.');

  const merged = { ...current };
  const added = [];
  const changed = [];
  const unchanged = [];
  for (const [k, v] of Object.entries(incoming)) {
    if (typeof v !== 'string') die(`value for ${k} must be a string`);
    // See the header: a pasted trailing newline is a real, repeated outage
    // cause here, and it is invisible in the console.
    const clean = v.trim();
    if (!(k in current)) added.push(k);
    else if (current[k] !== clean) changed.push(k);
    else unchanged.push(k);
    merged[k] = clean;
  }

  // Key names only. Never the values.
  console.log('\nplanned change (names only):');
  for (const k of added) console.log(`  + ${k}  (new)`);
  for (const k of changed) console.log(`  ~ ${k}  (overwrites existing value)`);
  for (const k of unchanged) console.log(`  = ${k}  (identical, no change)`);

  // Guard the whole point of this script.
  const lost = before.filter((k) => !(k in merged));
  if (lost.length) die(`refusing to write: would drop ${lost.join(', ')}`);

  if (added.length === 0 && changed.length === 0) {
    console.log('\nNothing to do — every value already matches.');
    return;
  }

  if (dryRun) {
    console.log(`\n--dry-run: no new version written to ${secretName}.`);
    return;
  }

  if (env === 'prod') {
    console.log(
      '\n⚠  This writes to PROD. The new version takes effect on each service ' +
      'instance\'s next cold start, not immediately.'
    );
  }

  // --- write it back --------------------------------------------------------
  // Pretty-printed so a human reading the version in the console can see the
  // shape; JSON.parse in bootstrap-secrets.js does not care either way.
  const payload = JSON.stringify(merged, null, 2);
  try {
    gcloud([
      'secrets', 'versions', 'add', secretName,
      `--project=${PROJECT}`, '--data-file=-',
    ], { input: payload, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    die(`failed to add a new version of ${secretName}:\n  ${String(err.stderr || err.message).trim()}`);
  }

  const after = Object.keys(merged).sort();
  console.log(`\n✓ ${secretName} now holds ${after.length} key(s): ${after.join(', ')}`);
  console.log(
    `\nRedeploy ${service} so running instances pick it up — the secret is read ` +
    `once at boot:\n  gh workflow run deploy.yml --ref ${env === 'prod' ? 'main' : 'dev'}`
  );
})();
