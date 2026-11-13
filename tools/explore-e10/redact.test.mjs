import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from './redact.mjs';

test('artifact redaction removes local passwords, database URIs and authentication tokens', () => {
  const password = 'synthetic-random-container-password';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.signature';
  const raw = JSON.stringify({
    error: `postgresql://postgres:${password}@127.0.0.1:5432/e10_runtime failed`,
    multiline: `postgres://postgres:${password}@localhost/db\nnext line`,
    header: `Bearer ${jwt}`, token: jwt, argument: `POSTGRES_PASSWORD=${password}`,
    fixture: 'e10-local-only', naked: password,
    useful: 'fresh historical chain failed P3009; cleanup owned container removed',
  });
  const result = redact(raw, [password]);
  for (const secret of [password, jwt, 'postgresql://', 'postgres://', 'e10-local-only']) {
    assert.ok(!result.includes(secret), secret);
  }
  assert.equal(JSON.parse(result).useful, JSON.parse(raw).useful);
  assert.equal(JSON.parse(result).multiline, '[redacted-db-uri]\nnext line');
  assert.equal(redact(result, [password]), result);
});
