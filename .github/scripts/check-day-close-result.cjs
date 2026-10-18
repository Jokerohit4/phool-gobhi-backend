// The endpoint can return HTTP 200 after individual users failed to close.
// Read its real controller envelope; HTTP success alone is not job success.
const { readFileSync } = require('node:fs');

try {
  const response = JSON.parse(readFileSync(0, 'utf8'));
  const failed = response?.data?.failed;
  if (!Number.isInteger(failed) || failed < 0) {
    throw new Error('Day-close response is missing a valid data.failed count.');
  }
  if (failed !== 0) {
    throw new Error(`Day close failed for ${failed} user(s); inspect the service logs and retry.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
