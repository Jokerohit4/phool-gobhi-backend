import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

/**
 * The customer app splits large Dart files into `part` files that live in a
 * folder named after the file's stem (`foo_screen.dart` + `foo_screen/*.dart`).
 * Contract tests that look for a path, key or route in a Dart "file" must read
 * the whole library, or they silently find nothing once the file is split.
 *
 * Returns the file's source followed by every .dart file under its part folder
 * (sorted, so the result is stable). The file itself may be missing when only
 * the folder exists.
 */
export function readDartLibrary(path) {
  const chunks = [];
  if (existsSync(path)) chunks.push(readFileSync(path, 'utf8'));
  const partsDir = join(dirname(path), basename(path, '.dart'));
  if (existsSync(partsDir) && statSync(partsDir).isDirectory()) {
    for (const file of listDart(partsDir)) chunks.push(readFileSync(file, 'utf8'));
  }
  return chunks.join('\n');
}

function listDart(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listDart(full));
    else if (entry.name.endsWith('.dart')) out.push(full);
  }
  return out;
}
