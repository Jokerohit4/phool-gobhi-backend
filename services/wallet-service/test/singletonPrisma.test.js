import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// One PrismaClient per service (one engine + one connection pool). Runtime code
// must import the shared client from db/prisma.js, never construct its own.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'test', 'prisma', 'scripts', 'tools']);
// Allow-list (relative, posix). Only the singleton itself.
const ALLOWED = new Set(['db/prisma.js']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (/\.(c|m)?js$/.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

test('only db/prisma.js constructs a PrismaClient', () => {
  const offenders = walk(root)
    .map((f) => path.relative(root, f).split(path.sep).join('/'))
    .filter((rel) => !ALLOWED.has(rel))
    .filter((rel) => fs.readFileSync(path.join(root, rel), 'utf8').includes('new PrismaClient('));
  assert.deepEqual(offenders, [], `import prisma from the db/prisma.js singleton instead of new PrismaClient(): ${offenders.join(', ')}`);
});
