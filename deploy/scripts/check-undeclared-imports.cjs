#!/usr/bin/env node
/*
 * Every bare package a service imports must be declared in that service's own
 * package.json. Nothing catches this locally: the repo root and sibling
 * services have their own node_modules, so an undeclared import resolves fine
 * on a dev machine and fails only inside the service's Docker image, where
 * `npm install` installed exactly what package.json asked for.
 *
 * The failure mode is the worst kind — not a test failure, not a build
 * failure, but a container that builds successfully and then exits(1) on
 * boot, so the deploy dies at "failed to start and listen on PORT" with the
 * real cause buried in Cloud Logging.
 *
 * It has now happened twice:
 *   - auth-service imported axios, which it has never depended on (caught by
 *     a unit test before it shipped, by luck rather than design);
 *   - health-service imported firebase-admin from utils/notifyUser.js and
 *     took down the dev deploy on 2026-09-10.
 *
 * Usage: node deploy/scripts/check-undeclared-imports.cjs
 * Exit:  0 = every imported package is declared, 1 = at least one is not.
 */
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SERVICES_DIR = path.join(REPO_ROOT, 'services');

// Source directories that actually ship inside the image. `test` is scanned
// too: a test-only import still has to be declared somewhere, and devDeps are
// accepted for it below.
const SOURCE_DIRS = ['routes', 'controllers', 'services', 'utils', 'middleware', 'config', 'jobs', 'test'];
const SOURCE_FILES = ['app.js', 'index.js', 'server.js'];

// `import x from 'pkg'`, `import 'pkg'`, `export ... from 'pkg'`,
// `require('pkg')` and `import('pkg')`. Relative paths and builtins are
// filtered out by isBarePackage below.
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

// The npm package-name grammar. This is a second, independent filter on top
// of the comment stripping below, and it earns its place: without it the
// `from '...'` half of the pattern happily reports English prose as a missing
// package. Anything with a space, a comma or a capital letter is prose that
// survived stripping, not a dependency — and a nonsense error trains people
// to ignore the whole check.
const NPM_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

// Strips block and line comments. Deliberately crude — it can mangle a `//`
// inside a string literal, which costs nothing here because the only thing
// this text is used for afterwards is matching import specifiers, and a URL
// in a string was never a valid one.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

function isBarePackage(spec) {
  if (!spec) return false;
  if (spec.startsWith('.') || spec.startsWith('/')) return false;
  if (BUILTINS.has(spec)) return false;
  return true;
}

// '@scope/pkg/sub' -> '@scope/pkg';  'pkg/sub' -> 'pkg'
function packageName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    // node_modules is the whole point of this check — never look inside it,
    // or every transitive dependency's own imports get reported.
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const problems = [];

for (const service of fs.readdirSync(SERVICES_DIR)) {
  const serviceDir = path.join(SERVICES_DIR, service);
  const pkgPath = path.join(serviceDir, 'package.json');
  if (!fs.existsSync(pkgPath)) continue;

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const declared = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
  ]);

  const files = [
    ...SOURCE_FILES.map((f) => path.join(serviceDir, f)).filter((f) => fs.existsSync(f)),
    ...SOURCE_DIRS.flatMap((d) => walk(path.join(serviceDir, d))),
  ];

  for (const file of files) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (!isBarePackage(spec)) continue;
      const name = packageName(spec);
      if (!NPM_NAME_RE.test(name)) continue;
      if (declared.has(name)) continue;
      problems.push({
        service,
        file: path.relative(REPO_ROOT, file).replace(/\\/g, '/'),
        pkg: name,
      });
    }
  }
}

if (problems.length === 0) {
  console.log('check-undeclared-imports: OK — every imported package is declared by the service that imports it.');
  process.exit(0);
}

// One line per (service, package), listing every file it came from.
const grouped = new Map();
for (const p of problems) {
  const key = `${p.service}::${p.pkg}`;
  if (!grouped.has(key)) grouped.set(key, { ...p, files: new Set() });
  grouped.get(key).files.add(p.file);
}

console.error('UNDECLARED IMPORTS — these would build fine and then crash the container on boot:');
console.error('');
for (const entry of grouped.values()) {
  console.error(`  ${entry.service} imports "${entry.pkg}" but does not declare it`);
  for (const f of entry.files) console.error(`      ${f}`);
  console.error(`      fix: cd services/${entry.service} && npm install ${entry.pkg} --save`);
  console.error('');
}
process.exit(1);
