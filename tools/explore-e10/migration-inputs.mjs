import { spawnSync } from 'node:child_process';

export const parentCommit = '5214fa8dd8242093e542bd89a169dcf9321753b2';
export const migrationPath = 'services/auth-service/prisma/migrations/';
export const replayPrerequisites = ['20260703000000_restore_auth_foundation'];
export const forwardMigrations = [
  '20261023000000_exploration_core',
  '20261023000100_drop_unreleased_collectible_find',
  '20261023170000_explore_receipt_telemetry',
];

// Read exact historical bytes from the frozen tree, never filter current files by date.
export function baselineFiles(root) {
  const git = args => {
    const result = spawnSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/').replace(/\/$/, '')}`, ...args], { cwd: root });
    if (result.status !== 0) throw new Error('Cannot read frozen migration baseline');
    return result.stdout;
  };
  const paths = git(['ls-tree', '-r', '--name-only', parentCommit, '--', migrationPath]).toString('utf8').trim().split('\n');
  if (!paths.length || paths.some(p => !p.startsWith(migrationPath))) throw new Error('Invalid baseline tree');
  return paths.map(path => ({ path: path.slice(migrationPath.length), bytes: git(['show', `${parentCommit}:${path}`]) }));
}

// Prisma schema diff omits this SQL-only CHECK; preserve its production expression.
export function telemetryOutcomeConstraint(sql) {
  const constraint = sql.match(/CONSTRAINT "ExploreReceiptEvent_outcome_check" CHECK \([\s\S]*?\n  \)/)?.[0];
  if (!constraint) throw new Error('Telemetry outcome constraint not found in approved migration');
  return `ALTER TABLE auth."ExploreReceiptEvent" ADD ${constraint}`;
}
