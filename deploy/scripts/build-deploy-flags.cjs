#!/usr/bin/env node
/*
 * Reads deploy/services.json and emits the --set-env-vars / --set-secrets
 * flag values `gcloud run deploy` needs for one service+env, so the manifest
 * is the only place this config is ever hand-edited (both the CI workflow
 * and the manual `.claude/commands/deploy.md` break-glass path call this).
 *
 * Usage: node deploy/scripts/build-deploy-flags.cjs <service> <dev|prod>
 *
 * Writes three lines to $GITHUB_OUTPUT if that env var is set (CI), otherwise
 * prints them to stdout for local/manual use:
 *   env-vars=^~^KEY1=val1~KEY2=val2
 *   secrets=^~^KEY1=secret-base-dev:latest~KEY2=secret-base-dev:latest
 *   service-account=backend-svc-sa@phool-gobhi.iam.gserviceaccount.com
 *
 * A non-comma delimiter (gcloud's `^DELIM^` custom-delimiter syntax, here
 * using `~`) is used instead of the default `,` because a couple of plain
 * env values here are full https:// URLs and nothing guarantees a future
 * value won't contain a literal comma — this sidesteps that class of bug
 * entirely rather than hoping no value ever needs escaping.
 */
const fs = require('fs');
const path = require('path');

const [, , service, env] = process.argv;

if (!service || !env || !['dev', 'prod'].includes(env)) {
  console.error('Usage: build-deploy-flags.cjs <service> <dev|prod>');
  process.exit(1);
}

const manifestPath = path.join(__dirname, '..', 'services.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const svc = manifest.services[service];
if (!svc) {
  console.error(`Unknown service "${service}" — not in deploy/services.json`);
  process.exit(1);
}

const envConfig = svc.env[env];
if (!envConfig) {
  console.error(`No "${env}" env block for service "${service}" in deploy/services.json`);
  process.exit(1);
}

const plain = envConfig.plain || {};
const secrets = envConfig.secrets || {};

const TODO_RE = /^TODO-/;
for (const [key, value] of [...Object.entries(plain), ...Object.entries(secrets)]) {
  if (TODO_RE.test(value)) {
    console.error(
      `deploy/services.json has an unresolved placeholder for ${service}.${env}.${key} = "${value}" — resolve it before deploying.`
    );
    process.exit(1);
  }
}

const DELIM_CHAR = '~';
const PREFIX = `^${DELIM_CHAR}^`;

const envVarsFlag = Object.entries(plain)
  .map(([k, v]) => `${k}=${v}`)
  .join(DELIM_CHAR);

const secretsFlag = Object.entries(secrets)
  .map(([k, secretBaseName]) => `${k}=${secretBaseName}-${env}:latest`)
  .join(DELIM_CHAR);

// `gcloud run deploy` only defaults the runtime identity when it CREATES a
// service; on an existing one it preserves whatever is already there. That
// default is the Compute Engine default SA, which holds roles/editor on this
// project — so the very first deploy of a brand-new service silently lands it
// on a far more privileged identity than its siblings, and nothing about the
// deploy fails to tell you. That is exactly what happened to
// health-service-prod / challenge-service-prod on 2026-09-10. Pinning the
// identity on every deploy makes the manifest the source of truth and removes
// the create-vs-update asymmetry entirely.
//
// Every prod service runs as backend-svc-sa (no project-level roles, granted
// per-resource); dev runs as the compute default; the gateway is the one
// exception in both envs, hence the per-service override.
const runtimeServiceAccount = svc.runtimeServiceAccount || (manifest.runtimeServiceAccounts || {})[env];
if (!runtimeServiceAccount) {
  console.error(
    `No runtime service account resolvable for ${service}.${env} — add deploy/services.json's ` +
      `runtimeServiceAccounts.${env} or a per-service runtimeServiceAccount.`
  );
  process.exit(1);
}

const lines = [
  `env-vars=${PREFIX}${envVarsFlag}`,
  `secrets=${PREFIX}${secretsFlag}`,
  `service-account=${runtimeServiceAccount}`,
];

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
} else {
  console.log(lines.join('\n'));
}
