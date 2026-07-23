#!/usr/bin/env node
/*
 * Weekly drift check: compares deploy/services.json against what's actually
 * live on Cloud Run, so a manual out-of-band `gcloud run services update`
 * (bypassing the manifest) gets caught instead of silently persisting until
 * someone notices behavior drifted from what the repo says is deployed.
 *
 * Compares env-var/secret-ref *names* and plain values (nothing here is a
 * secret VALUE — secret values are never fetched by this script, only which
 * Secret Manager entry each var is bound to).
 *
 * Usage: node deploy/scripts/check-manifest-drift.cjs
 * Exit: 0 = no drift, 1 = drift found (details on stdout).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const manifestPath = path.join(__dirname, '..', 'services.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

function getLiveEnv(cloudRunName) {
  const raw = execFileSync(
    'gcloud',
    [
      'run', 'services', 'describe', cloudRunName,
      '--project', manifest.project,
      '--region', manifest.region,
      '--format', 'json(spec.template.spec.containers[0].env)',
    ],
    { encoding: 'utf8', shell: process.platform === 'win32' }
  );
  const parsed = JSON.parse(raw);
  const envList = parsed?.spec?.template?.spec?.containers?.[0]?.env || [];

  const plain = {};
  const secrets = {};
  for (const entry of envList) {
    if (entry.value !== undefined) {
      plain[entry.name] = entry.value;
    } else if (entry.valueFrom?.secretKeyRef?.name) {
      secrets[entry.name] = entry.valueFrom.secretKeyRef.name;
    }
  }
  return { plain, secrets };
}

function stripEnvSuffix(secretRefName, env) {
  const suffix = `-${env}`;
  return secretRefName.endsWith(suffix) ? secretRefName.slice(0, -suffix.length) : secretRefName;
}

let driftFound = false;
const report = [];

for (const [serviceName, svc] of Object.entries(manifest.services)) {
  for (const env of ['dev', 'prod']) {
    const cloudRunName = `${svc.cloudRunServiceBaseName}-${env}`;
    const expected = svc.env[env] || { plain: {}, secrets: {} };
    let live;
    try {
      live = getLiveEnv(cloudRunName);
    } catch (err) {
      report.push(`${cloudRunName}: could not describe service (${err.message.split('\n')[0]})`);
      driftFound = true;
      continue;
    }

    const expectedPlain = expected.plain || {};
    const expectedSecrets = expected.secrets || {};

    for (const [key, value] of Object.entries(expectedPlain)) {
      if (!(key in live.plain)) {
        report.push(`${cloudRunName}: manifest declares plain env "${key}" but it's not live`);
        driftFound = true;
      } else if (live.plain[key] !== value) {
        report.push(`${cloudRunName}: plain env "${key}" = "${live.plain[key]}" live, manifest says "${value}"`);
        driftFound = true;
      }
    }
    for (const key of Object.keys(live.plain)) {
      if (!(key in expectedPlain)) {
        report.push(`${cloudRunName}: live has plain env "${key}" not declared in manifest`);
        driftFound = true;
      }
    }

    for (const [key, baseName] of Object.entries(expectedSecrets)) {
      if (!(key in live.secrets)) {
        report.push(`${cloudRunName}: manifest declares secret env "${key}" but it's not live`);
        driftFound = true;
      } else {
        const liveBase = stripEnvSuffix(live.secrets[key], env);
        if (liveBase !== baseName) {
          report.push(`${cloudRunName}: secret env "${key}" bound to "${live.secrets[key]}" live, manifest expects base "${baseName}"`);
          driftFound = true;
        }
      }
    }
    for (const key of Object.keys(live.secrets)) {
      if (!(key in expectedSecrets)) {
        report.push(`${cloudRunName}: live has secret env "${key}" (-> ${live.secrets[key]}) not declared in manifest`);
        driftFound = true;
      }
    }
  }
}

if (driftFound) {
  console.log(`DRIFT FOUND (${report.length} issue(s)):\n`);
  report.forEach((line) => console.log(`  - ${line}`));
  process.exit(1);
}

console.log('No drift — deploy/services.json matches live Cloud Run config for all services.');
process.exit(0);
