#!/usr/bin/env node
/*
 * CI-runnable port of the manual `.claude/commands/deploy.md` gym-service
 * guard: gymRoutes is mounted at app.use('/', gymRoutes), so its GET /:id
 * swallows /health if the health route is registered after the mount
 * (this broke Cloud Run healthchecks once already, fixed in commit
 * 3b3def4 — this script exists so a regression fails CI instead of
 * surfacing as a live healthcheck outage).
 *
 * Usage: node deploy/scripts/check-gym-health-route-order.cjs
 * Exit: 0 = /health registered before the router mount (or file layout
 *       doesn't match the pattern this checks — see stderr), 1 = /health
 *       comes after the mount and would be swallowed.
 */
const fs = require('fs');
const path = require('path');

const APP_FILE = path.join(__dirname, '..', '..', 'services', 'gym-service', 'app.js');

const HEALTH_RE = /app\.(?:get|all)\(\s*['"]\/health['"]/;
const MOUNT_RE = /app\.use\(\s*['"]\/['"]\s*,/;

const text = fs.readFileSync(APP_FILE, 'utf8');
const lines = text.split('\n');

const healthLine = lines.findIndex((l) => HEALTH_RE.test(l));
const mountLine = lines.findIndex((l) => MOUNT_RE.test(l));

if (healthLine === -1) {
  console.error(`Could not find a '/health' route registration in ${APP_FILE} — verify manually before deploying.`);
  process.exit(1);
}

if (mountLine === -1) {
  console.log(`No root router mount (app.use('/', ...)) found in ${APP_FILE} — nothing to swallow /health, OK.`);
  process.exit(0);
}

if (mountLine < healthLine) {
  console.error(
    `gym-service/app.js:${mountLine + 1} mounts the router BEFORE /health is registered at line ${healthLine + 1} — ` +
    `GET /:id will swallow /health and Cloud Run healthchecks will fail. Move the /health route above the app.use('/', ...) mount.`
  );
  process.exit(1);
}

console.log(`OK — /health (line ${healthLine + 1}) is registered before the router mount (line ${mountLine + 1}).`);
process.exit(0);
