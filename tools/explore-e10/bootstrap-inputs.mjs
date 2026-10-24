// File staging only. Historical inputs remain audit material, never executable here.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { forwardNames } from '../explore-e2/provisioning-inputs.mjs';

export const bootstrapName = '00000000000000_e2_parent_5214fa8_schema_bootstrap';
export const bootstrapDatabases = ['e10_bootstrap_empty', 'e10_bootstrap_populated'];
export function baselineMigration(sql) { return Buffer.from(`BEGIN;\n${sql}\nCOMMIT;\n`); }
function put(directory, path, bytes) {
  const target = resolve(directory, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: 'wx' });
}
function required(files, path) {
  const found = files.find(f => f.path === path);
  if (!found) throw new Error(`Missing bootstrap input: ${path}`);
  return found.bytes;
}
export function stageBootstrap(directory, files, renderedSql) {
  mkdirSync(directory); // Refuse overwriting any previous rehearsal stage.
  put(directory, 'schema.prisma', required(files, 'parent.prisma'));
  put(directory, 'migrations/migration_lock.toml', required(files, 'historical/migration_lock.toml'));
  put(directory, `migrations/${bootstrapName}/migration.sql`, baselineMigration(renderedSql));
}
export function stageForward(directory, files) {
  for (const name of forwardNames) put(directory, `migrations/${name}/migration.sql`, required(files, `forward/${name}/migration.sql`));
}
