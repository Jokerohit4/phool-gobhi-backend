import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = new URL('../', import.meta.url);
function scan(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? scan(path) : path.endsWith('.js') ? [path] : [];
  });
}
test('runtime calendar code keeps timezone and offset literals in sessionDay only', () => {
  const violations = ['services/', 'controllers/', 'middleware/', 'utils/'].flatMap(dir => scan(fileURLToPath(new URL(dir, root))))
    .filter(path => !path.endsWith('sessionDay.js'))
    .filter(path => /Asia\/Kolkata|IST_OFFSET|(?:5\.5|330)\s*\*|19800000/.test(readFileSync(path, 'utf8')));
  assert.deepEqual(violations, []);
});
