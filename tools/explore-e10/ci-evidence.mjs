// No dependencies, Docker calls or DB access. Upload an allowlist, never .runtime wholesale.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { redact } from './redact.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = resolve(root, 'tools/explore-e10/.runtime');
const output = resolve(root, 'tools/explore-e10/ci-evidence');
mkdirSync(output, { recursive: true });
const files = [
  'rehearsal-result.json', 'fresh-migrate.local.log', 'old-chain.local.log', 'old-forward.local.log',
  'telemetry-e10_runtime.local.json', 'telemetry-e10_upgrade.local.json', 'telemetry-e10_upgrade_empty.local.json',
  'postgres-e10_runtime.local.log', 'postgres-e10_upgrade.local.log',
  'postgres-e10_upgrade_empty.local.log', 'ci-preflight.local.log',
  'ci-install.local.log', 'ci-image.local.log', 'ci-rehearsal.local.log',
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const logs = [];
for (const file of files) {
  if (!existsSync(resolve(runtime, file))) continue;
  const text = redact(readFileSync(resolve(runtime, file), 'utf8'));
  writeFileSync(resolve(output, file), text);
  logs.push({ file, redactedSha256: sha256(text) });
}
const git = args => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Cannot record source identity: git ${args.join(' ')}`);
  return result.stdout.trim();
};
const sourcePaths = [
  '.github/workflows/explore-e10-postgres.yml',
  ...['rehearse.mjs', 'postgres.test.mjs', 'redact.mjs', 'ci-evidence.mjs', 'telemetry-postgres.mjs', 'migration-inputs.mjs', 'migration-inputs.test.mjs'].map(f => `tools/explore-e10/${f}`),
  ...['exploration/service.js', 'exploration/telemetry.js', 'utils/analytics.js', 'services/authService.js', 'services/exportService.js', 'prisma/schema.prisma'].map(f => `services/auth-service/${f}`),
  ...['', 'services/auth-service/', 'services/booking-service/'].map(p => `${p}package-lock.json`),
  ...readdirSync(resolve(root, 'services/auth-service/prisma/migrations'), { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => `services/auth-service/prisma/migrations/${d.name}/migration.sql`),
];
const versions = {};
for (const service of ['auth', 'booking']) {
  const path = resolve(root, `services/${service}-service/node_modules/prisma/package.json`);
  versions[`${service}Prisma`] = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).version : 'not installed';
}
const receipt = {
  recordedAt: new Date().toISOString(),
  sourceCommit: git(['rev-parse', 'HEAD']),
  parentSchemaCommit: '5214fa8dd8242093e542bd89a169dcf9321753b2',
  node: process.version, platform: process.platform, ...versions,
  workflow: process.env.GITHUB_WORKFLOW ?? null,
  ref: process.env.GITHUB_REF ?? null,
  runId: process.env.GITHUB_RUN_ID ?? null,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  jobStatusBeforeCollection: process.env.E10_JOB_STATUS ?? 'not a hosted run',
  rehearsalReceiptAvailable: logs.some(l => l.file === 'rehearsal-result.json'),
  // Absence of a rehearsal receipt is not a passed DB run.
  command: 'node tools/explore-e10/rehearse.mjs',
  sourceFiles: sourcePaths.map(path => ({ path, gitBlob: git(['rev-parse', `HEAD:${path}`]),
    rawSha256: sha256(readFileSync(resolve(root, path))) })),
  logs,
};
writeFileSync(resolve(output, 'ci-source.json'), JSON.stringify(receipt, null, 2) + '\n');
