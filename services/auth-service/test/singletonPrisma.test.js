import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'test', 'prisma', 'scripts']);
// Only the shared singleton may construct a PrismaClient. No exceptions.
const ALLOWED = new Set(['db/prisma.js']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (/\.(c|m)?js$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

test('only db/prisma.js constructs a PrismaClient', () => {
  const offenders = walk(root)
    .map((f) => path.relative(root, f).split(path.sep).join('/'))
    .filter((rel) => !ALLOWED.has(rel))
    .filter((rel) => fs.readFileSync(path.join(root, rel), 'utf8').includes('new PrismaClient('));
  assert.deepEqual(
    offenders,
    [],
    `new PrismaClient() found in: ${offenders.join(', ')}. Import the shared client instead: import prisma from '<relative>/db/prisma.js'`
  );
});
