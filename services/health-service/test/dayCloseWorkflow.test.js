import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const validator = fileURLToPath(new URL('../../../.github/scripts/check-day-close-result.cjs', import.meta.url));

for (const [name, response, succeeds] of [
  ['successful close', { data: { eligible: 2, closed: 2, alreadyClosed: 0, failed: 0 } }, true],
  ['idempotent retry', { data: { eligible: 2, closed: 0, alreadyClosed: 2, failed: 0 } }, true],
  ['no eligible users', { data: { eligible: 0, closed: 0, failed: 0 } }, true],
  ['disabled sweep', { data: { disabled: true, failed: 0 } }, true],
  ['partial failure despite HTTP success', { data: { eligible: 2, closed: 1, failed: 1 } }, false],
  ['all users failed', { data: { eligible: 2, closed: 0, failed: 2 } }, false],
  ['missing failure count', { data: { closed: 2 } }, false],
  ['unwrapped response', { failed: 0 }, false],
  ['null response', null, false],
  ['string zero', { data: { failed: '0' } }, false],
  ['negative failure count', { data: { failed: -1 } }, false],
  ['fractional failure count', { data: { failed: 0.5 } }, false],
]) {
  test(`day-close workflow: ${name}`, () => {
    const result = spawnSync(process.execPath, [validator], { input: JSON.stringify(response), encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, succeeds ? 0 : 1, result.stderr);
    if (!succeeds) assert.ok(result.stderr.trim(), 'failed jobs must explain the failure');
  });
}

test('day-close workflow: malformed JSON fails', () => {
  const result = spawnSync(process.execPath, [validator], { input: '<html>upstream error</html>', encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.trim());
});

test('day-close workflow invokes the validator after the HTTP check and retains the release gates', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/close-ledger-days.yml', import.meta.url), 'utf8');
  assert.match(workflow, /uses: actions\/checkout@v4/);
  assert.match(workflow, /curl --fail-with-body/);
  assert.match(workflow, /node \.github\/scripts\/check-day-close-result\.cjs < "\$response_file"/);
  assert.match(workflow, /env: \[dev\]/);
  assert.match(workflow, /cron: '0 20 \* \* \*'/);
});
