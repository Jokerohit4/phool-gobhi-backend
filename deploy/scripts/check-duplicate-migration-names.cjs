#!/usr/bin/env node
/*
 * Prisma migration names must be unique across services.
 *
 * In dev (and any environment that shares one database) every service writes to
 * the same `public._prisma_migrations` table. `prisma migrate deploy` skips a
 * migration whose name is already recorded there, so two services that both ship
 * `20261117010000_health_guidance` collide: whichever deploys second is silently
 * marked applied and never runs, and the next migration then fails on a missing
 * table. That happened on 2026-11-21 (wallet-service vs health-service).
 *
 * Usage: node deploy/scripts/check-duplicate-migration-names.cjs
 * Exit:  0 = every migration name is unique, 1 = a name is used by 2+ services.
 */
const fs = require('fs');
const path = require('path');

const servicesDir = path.join(__dirname, '..', '..', 'services');
const owners = new Map();

for (const service of fs.readdirSync(servicesDir, { withFileTypes: true })) {
  if (!service.isDirectory()) continue;
  const migrations = path.join(servicesDir, service.name, 'prisma', 'migrations');
  if (!fs.existsSync(migrations)) continue;
  for (const entry of fs.readdirSync(migrations, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    owners.set(entry.name, [...(owners.get(entry.name) || []), service.name]);
  }
}

const duplicates = [...owners].filter(([, services]) => services.length > 1);
if (duplicates.length) {
  console.error('Duplicate Prisma migration names across services:');
  for (const [name, services] of duplicates) console.error(`  ${name}: ${services.join(', ')}`);
  console.error('Rename one so the name is unique; a shared _prisma_migrations table would skip it.');
  process.exit(1);
}
console.log(`check-duplicate-migration-names: OK — ${owners.size} migration names, none shared between services.`);
