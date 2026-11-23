// Service Docker contexts are isolated. Keep the transport byte-identical.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
for (const service of readdirSync(resolve(root, 'services'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
 for (const name of ['analyticsTransport.js','bigQueryAnalytics.js']) {
  const source = readFileSync(resolve(root, 'utils', name));
  const target = resolve(root, 'services', service, 'utils', name);
  if (process.argv.includes('--check')) {
    if (!source.equals(readFileSync(target))) throw Error(`Analytics transport drift: ${service}`);
  } else writeFileSync(target, source);
 }
}
// Push telemetry is vendored only into services that send FCM messages.
for (const service of ['auth-service','booking-service','buddy-service','health-service','wallet-service','notification-service']) {
  const source = readFileSync(resolve(root, 'utils', 'pushTelemetry.js'));
  const target = resolve(root, 'services', service, 'utils', 'pushTelemetry.js');
  if (process.argv.includes('--check')) {
    if (!existsSync(target) || !source.equals(readFileSync(target))) throw Error(`Push telemetry drift: ${service}`);
  } else writeFileSync(target, source);
}
