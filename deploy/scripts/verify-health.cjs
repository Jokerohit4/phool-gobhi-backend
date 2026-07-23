#!/usr/bin/env node
/*
 * Post-deploy health verification. Resolves the live Cloud Run URL for
 * <service>-<env> and polls GET <url>/health with backoff, so a bad
 * revision fails the deploy job loudly (and triggers the workflow's
 * rollback step) instead of silently serving broken traffic.
 *
 * Usage: node deploy/scripts/verify-health.cjs <service> <env>
 * Exit: 0 = healthy within retry budget, 1 = never returned 2xx.
 */
const { execFileSync } = require('child_process');
const https = require('https');

const [, , service, env] = process.argv;

if (!service || !env || !['dev', 'prod'].includes(env)) {
  console.error('Usage: verify-health.cjs <service> <dev|prod>');
  process.exit(1);
}

const cloudRunName = `${service}-${env}`;
const ATTEMPTS = 5;
const BASE_DELAY_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getServiceUrl() {
  const url = execFileSync(
    'gcloud',
    [
      'run', 'services', 'describe', cloudRunName,
      '--project', 'phool-gobhi',
      '--region', 'asia-south1',
      '--format', 'value(status.url)',
    ],
    // gcloud ships as gcloud.cmd on Windows, which Node can only invoke via a
    // shell — only opt into that on win32 so CI (Linux, real gcloud binary)
    // doesn't take the shell-arg-escaping risk/deprecation warning for no reason.
    { encoding: 'utf8', shell: process.platform === 'win32' }
  ).trim();

  if (!url) {
    throw new Error(`gcloud returned no URL for service "${cloudRunName}"`);
  }
  return url;
}

function checkOnce(healthUrl) {
  return new Promise((resolve) => {
    const req = https.get(healthUrl, { timeout: 10000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: body.slice(0, 500) });
      });
    });
    req.on('error', (err) => resolve({ statusCode: null, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ statusCode: null, error: 'request timed out' });
    });
  });
}

async function main() {
  const serviceUrl = getServiceUrl();
  const healthUrl = `${serviceUrl}/health`;

  let last = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    last = await checkOnce(healthUrl);

    if (last.statusCode && last.statusCode >= 200 && last.statusCode < 300) {
      console.log(`OK — ${healthUrl} returned ${last.statusCode} on attempt ${attempt}/${ATTEMPTS}`);
      process.exit(0);
    }

    console.log(
      `Attempt ${attempt}/${ATTEMPTS}: ${healthUrl} -> ${last.statusCode ?? 'no response'}` +
      (last.error ? ` (${last.error})` : '')
    );

    if (attempt < ATTEMPTS) {
      await sleep(BASE_DELAY_MS * attempt);
    }
  }

  console.error(`FAILED — ${healthUrl} never returned 2xx after ${ATTEMPTS} attempts.`);
  if (last?.body) console.error(`Last response body: ${last.body}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`verify-health.cjs error: ${err.message}`);
  process.exit(1);
});
