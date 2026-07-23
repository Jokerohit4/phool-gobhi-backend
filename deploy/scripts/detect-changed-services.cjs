#!/usr/bin/env node
/*
 * Decides which deploy units changed between two git refs, using
 * deploy/services.json's `pathTriggers` as the ONLY source of truth for
 * "what counts as a change to this service" — deliberately not duplicated
 * as a second glob list inside the workflow YAML (e.g. dorny/paths-filter),
 * so the manifest can't drift out of sync with the CI trigger logic.
 *
 * Usage: node deploy/scripts/detect-changed-services.cjs <baseRef> <headRef>
 *
 * Writes to $GITHUB_OUTPUT (or stdout if unset):
 *   matrix=["auth-service","gym-service"]   (only services with a matching change)
 *   any=true|false
 *
 * If baseRef doesn't exist locally (e.g. the all-zeros SHA GitHub sends for
 * a branch's first-ever push, or a shallow checkout missing history), every
 * service is treated as changed — safer than silently deploying nothing.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [, , baseRef, headRef] = process.argv;

if (!baseRef || !headRef) {
  console.error('Usage: detect-changed-services.cjs <baseRef> <headRef>');
  process.exit(1);
}

const manifestPath = path.join(__dirname, '..', 'services.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const services = manifest.services;

function refExists(ref) {
  if (!ref || /^0+$/.test(ref)) return false;
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getChangedFiles() {
  if (!refExists(baseRef)) {
    console.error(
      `Base ref "${baseRef}" not found locally (first push on a new branch, or shallow checkout) — treating all services as changed.`
    );
    return null; // signal "everything changed"
  }
  const out = execFileSync('git', ['diff', '--name-only', `${baseRef}`, `${headRef}`], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function matchesTrigger(file, trigger) {
  if (trigger.endsWith('/**')) {
    const prefix = trigger.slice(0, -2); // keep trailing '/'
    return file.startsWith(prefix);
  }
  return file === trigger;
}

const changedFiles = getChangedFiles();

const changedServices = Object.entries(services)
  .filter(([, svc]) => {
    if (changedFiles === null) return true; // unknown diff base -> deploy everything
    return svc.pathTriggers.some((trigger) => changedFiles.some((file) => matchesTrigger(file, trigger)));
  })
  .map(([name]) => name);

const lines = [
  `matrix=${JSON.stringify(changedServices)}`,
  `any=${changedServices.length > 0}`,
];

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
} else {
  console.log(lines.join('\n'));
}
