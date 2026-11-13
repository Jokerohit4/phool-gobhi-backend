import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

let importId = 0;
async function tokenService(t, runtime, { lifetime = 3600, fail = false } = {}) {
  const saved = { K_SERVICE: process.env.K_SERVICE, CLOUD_RUN_JOB: process.env.CLOUD_RUN_JOB };
  delete process.env.K_SERVICE;
  delete process.env.CLOUD_RUN_JOB;
  Object.assign(process.env, runtime);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const calls = { constructors: 0, clients: [], tokens: [] };
  t.mock.module('google-auth-library', { namedExports: {
    GoogleAuth: class {
      constructor() { calls.constructors++; }
      async getIdTokenClient(audience) {
        calls.clients.push(audience);
        return { idTokenProvider: { fetchIdToken: async (requested) => {
          calls.tokens.push(requested);
          if (fail) throw new Error('identity unavailable');
          const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + lifetime })).toString('base64url');
          return `header.${payload}.token${calls.tokens.length}`;
        } } };
      }
    },
  } });
  const moduleUrl = new URL('../utils/googleIdToken.js', import.meta.url);
  moduleUrl.searchParams.set('runtime-test', String(++importId));
  return { ...(await import(moduleUrl.href)), calls };
}

test('identity tokens: local execution does not request Cloud credentials', async (t) => {
  const service = await tokenService(t, {});
  assert.deepEqual(await service.googleIdTokenHeader('https://auth.example'), {});
  assert.equal(service.calls.constructors, 0);
});

test('identity tokens: Cloud Run services retain authenticated requests and cached tokens', async (t) => {
  const service = await tokenService(t, { K_SERVICE: 'health-service-dev' });
  const first = await service.googleIdTokenHeader('https://auth.example');
  assert.match(first.Authorization, /^Bearer /);
  assert.deepEqual(await service.googleIdTokenHeader('https://auth.example'), first);
  assert.deepEqual(service.calls.clients, ['https://auth.example']);
  assert.deepEqual(service.calls.tokens, ['https://auth.example']);
});

test('identity tokens: Cloud Run jobs authenticate using the built-in job marker alone', async (t) => {
  const service = await tokenService(t, { CLOUD_RUN_JOB: 'one-plan-dev-data' });
  assert.equal(process.env.K_SERVICE, undefined);
  assert.match((await service.googleIdTokenHeader('https://auth.example')).Authorization, /^Bearer /);
  assert.deepEqual(service.calls.tokens, ['https://auth.example']);
});

test('identity tokens: caches remain isolated by audience', async (t) => {
  const service = await tokenService(t, { CLOUD_RUN_JOB: 'one-plan-dev-data' });
  await service.googleIdTokenHeader('https://auth.example');
  await service.googleIdTokenHeader('https://booking.example');
  await service.googleIdTokenHeader('https://auth.example');
  assert.deepEqual(service.calls.clients, ['https://auth.example', 'https://booking.example']);
  assert.deepEqual(service.calls.tokens, ['https://auth.example', 'https://booking.example']);
});

test('identity tokens: refresh tokens near expiry without recreating the client', async (t) => {
  const service = await tokenService(t, { CLOUD_RUN_JOB: 'one-plan-dev-data' }, { lifetime: 30 });
  const first = await service.googleIdTokenHeader('https://auth.example');
  const second = await service.googleIdTokenHeader('https://auth.example');
  assert.notEqual(second.Authorization, first.Authorization);
  assert.equal(service.calls.clients.length, 1);
  assert.equal(service.calls.tokens.length, 2);
});

test('identity tokens: job identity failures reject rather than sending unauthenticated requests', async (t) => {
  const service = await tokenService(t, { CLOUD_RUN_JOB: 'one-plan-dev-data' }, { fail: true });
  await assert.rejects(() => service.googleIdTokenHeader('https://auth.example'), /identity unavailable/);
});

test('dev migration job environment does not override reserved Cloud Run markers', (t) => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const workflow = readFileSync(join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');
  const code = workflow.match(/name: Resolve deployed dev image and job environment[\s\S]*?node <<'NODE'\r?\n([\s\S]*?)\r?\n\s+NODE/)[1];
  const directory = mkdtempSync(join(tmpdir(), 'one-plan-job-env-test-'));
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'deploy/services.json'), 'utf8'));
  writeFileSync(join(directory, 'health-service-dev.json'), JSON.stringify({
    status: { latestReadyRevisionName: 'health-service-dev-test' },
    spec: { template: { spec: { serviceAccountName: manifest.runtimeServiceAccounts.dev,
      containers: [{ env: [{ name: 'SECRETS_JSON', valueFrom: { secretKeyRef: { name: 'health-service-secrets-dev' } } }] }],
    } } },
  }));
  writeFileSync(join(directory, 'health-revision.json'), JSON.stringify({ status: { imageDigest: 'test-image@sha256:test' } }));
  const result = spawnSync(process.execPath, ['-e', code], {
    cwd: repoRoot, encoding: 'utf8',
    env: { ...process.env, RUNNER_TEMP: directory, GITHUB_OUTPUT: join(directory, 'outputs') },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const env = JSON.parse(readFileSync(join(directory, 'one-plan-dev-env.json'), 'utf8'));
  assert.equal(env.NODE_ENV, 'development');
  assert.equal(env.ONE_PLAN_MIGRATION_ENV, 'dev');
  for (const marker of ['K_SERVICE', 'K_REVISION', 'K_CONFIGURATION', 'CLOUD_RUN_JOB', 'CLOUD_RUN_EXECUTION', 'CLOUD_RUN_TASK_INDEX']) {
    assert.equal(Object.hasOwn(env, marker), false, `${marker} must be provided by Cloud Run`);
  }
});
