// Local tooling test only: synthetic logs in an isolated Git fixture, no Docker/build/DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('CI collector retains failed/not-started status, redacts logs and excludes runtime assets', () => {
  const source = fileURLToPath(new URL('../../', import.meta.url));
  const runtime = resolve(source, 'tools/explore-e10/.runtime');
  mkdirSync(runtime, { recursive: true });
  const fixture = mkdtempSync(resolve(runtime, 'ci-collector-test-'));
  const run = (bin, args, env = process.env) => {
    const result = spawnSync(bin, args, { cwd: fixture, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    for (const file of [
      'tools/explore-e10/dev-lineage.mjs', 'tools/explore-e10/dev-lineage.test.mjs', 'tools/explore-e10/capture-dev-lineage.mjs',
      'tools/explore-e10/dev-baseline-audit.mjs', 'tools/explore-e10/dev-baseline-audit.test.mjs',
      'index.js', 'package.json', 'utils/analytics.js', 'utils/exploreQueueDiagnosticSchema.js',
      'docs/analytics-events.json', 'test/gateway.test.js', 'test/exploreQueueDiagnosticSchema.test.js',
      'test/queueDiagnosticProvider.test.js', 'tools/explore-e10/http.test.mjs',
      '.github/workflows/explore-e10-postgres.yml',
      ...['rehearse.mjs', 'postgres.test.mjs', 'redact.mjs', 'ci-evidence.mjs', 'telemetry-postgres.mjs', 'migration-inputs.mjs', 'migration-inputs.test.mjs', 'response-hold.mjs', 'response-hold.test.mjs', 'error-envelope.mjs', 'error-envelope.test.mjs', 'bootstrap-inputs.mjs', 'bootstrap-inputs.test.mjs', 'bootstrap.mjs'].map(f => `tools/explore-e10/${f}`),
      ...['exploration/routes.js', 'exploration/contracts.js', 'test/exploration.test.js', 'exploration/service.js', 'exploration/telemetry.js', 'utils/analytics.js', 'services/authService.js', 'services/exportService.js', 'prisma/schema.prisma'].map(f => `services/auth-service/${f}`),
      ...['provisioning-inputs.mjs', 'provisioning-inputs.test.mjs'].map(f => `tools/explore-e2/${f}`),
      ...['', 'services/auth-service/', 'services/booking-service/'].map(p => `${p}package-lock.json`),
      'services/auth-service/prisma/migrations/20261023000000_exploration_core/migration.sql',
      'services/auth-service/prisma/migrations/20261023170000_explore_receipt_telemetry/migration.sql',
    ]) {
      const target = resolve(fixture, file);
      mkdirSync(resolve(target, '..'), { recursive: true });
      cpSync(resolve(source, file), target);
    }
    run('git', ['init', '--quiet']);
    run('git', ['add', '.']);
    run('git', ['-c', 'user.name=E10 fixture', '-c', 'user.email=e10@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'synthetic evidence fixture']);
    const local = resolve(fixture, 'tools/explore-e10/.runtime');
    const output = resolve(fixture, 'tools/explore-e10/ci-evidence');
    mkdirSync(local);
    writeFileSync(resolve(local, 'ci-install.local.log'), 'failed install; Bearer synthetic-token\n');
    writeFileSync(resolve(local, 'ci-client-diagnostics.local.log'), 'diagnostic checks passed\n');
    writeFileSync(resolve(local, 'private-client.js'), 'must never be uploaded');
    const env = { ...process.env, E10_JOB_STATUS: 'failure' };
    run(process.execPath, ['tools/explore-e10/ci-evidence.mjs'], env);
    let metadata = JSON.parse(readFileSync(resolve(output, 'ci-source.json')));
    assert.equal(metadata.jobStatusBeforeCollection, 'failure');
    assert.equal(metadata.rehearsalReceiptAvailable, false);
    assert.deepEqual(readdirSync(output).sort(), ['ci-client-diagnostics.local.log', 'ci-install.local.log', 'ci-source.json']);
    assert.ok(!readFileSync(resolve(output, 'ci-install.local.log'), 'utf8').includes('synthetic-token'));
    writeFileSync(resolve(local, 'rehearsal-result.json'), JSON.stringify({
      result: 'blocked-or-failed', error: 'postgresql://user:password@127.0.0.1/db refused',
      cleanup: 'owned container and volumes removed',
    }));
    writeFileSync(resolve(local, 'telemetry-e10_runtime.local.json'), JSON.stringify({result: 'failed-or-incomplete', checks: []}));
    writeFileSync(resolve(local, 'bootstrap-parent.rendered.sql'), 'CREATE SCHEMA \"auth\";\n');
    writeFileSync(resolve(local, 'bootstrap-e10_bootstrap_empty.local.json'), JSON.stringify({ kind: 'fixture-only', historyBefore: [], result: 'not-executed' }));
    writeFileSync(resolve(local, 'old-forward.local.log'), 'forward failed; postgresql://user:password@127.0.0.1/db');
    run(process.execPath, ['tools/explore-e10/ci-evidence.mjs'], env);
    metadata = JSON.parse(readFileSync(resolve(output, 'ci-source.json')));
    assert.equal(metadata.rehearsalReceiptAvailable, true);
    assert.equal(readFileSync(resolve(output, 'bootstrap-parent.rendered.sql'), 'utf8'), 'CREATE SCHEMA \"auth\";\n');
    assert.equal(JSON.parse(readFileSync(resolve(output, 'bootstrap-e10_bootstrap_empty.local.json'))).result, 'not-executed');
    assert.equal(JSON.parse(readFileSync(resolve(output, 'telemetry-e10_runtime.local.json'))).result, 'failed-or-incomplete');
    assert.ok(!readFileSync(resolve(output, 'old-forward.local.log'), 'utf8').includes('password'));
    assert.ok(metadata.sourceFiles.some(f => f.path.includes('20261023170000_explore_receipt_telemetry/migration.sql')));
    assert.ok(metadata.sourceFiles.some(f => f.path === 'utils/exploreQueueDiagnosticSchema.js'));
    const receipt = JSON.parse(readFileSync(resolve(output, 'rehearsal-result.json')));
    assert.equal(receipt.result, 'blocked-or-failed');
    assert.equal(receipt.error, '[redacted-db-uri] refused');
    assert.equal(receipt.cleanup, 'owned container and volumes removed');
    assert.ok(metadata.sourceFiles.every(f => /^[0-9a-f]{40}$/.test(f.gitBlob) && /^[0-9a-f]{64}$/.test(f.rawSha256)));
  } finally {
    const owned = relative(runtime, fixture);
    assert.ok(owned.startsWith('ci-collector-test-') && !isAbsolute(owned) && !owned.includes('..'));
    rmSync(fixture, { recursive: true, force: true });
  }
});
