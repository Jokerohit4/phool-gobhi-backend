#!/usr/bin/env node
/*
 * Fails when a tracked text file contains mojibake: text written in one
 * encoding and read back in another, so characters such as an em dash, the
 * rupee sign or Devanagari turn into junk. It is easy to miss in review
 * because the damage looks like harmless punctuation, but in a string literal
 * it is shown to users.
 *
 * Detected, per line:
 *   1. U+FFFD, the replacement character (the original bytes are gone).
 *   2. UTF-8 read as Windows-1252: a lead character (from the bytes C2 C3 C4
 *      C5 CE CF D0 D1 E0 E2 EF F0) followed by a Windows-1252 continuation
 *      character (bytes 80-BF, including euro/quote/dash code points and C1
 *      controls). An em dash becomes a-circumflex, euro sign, right quote.
 *   3. UTF-8 read as DOS code page 437: a box-drawing tee (U+251C / U+252C)
 *      directly followed by U+00A0-U+00FF, or U+251C+U+2310, U+252C+U+2556,
 *      or Greek capital gamma (U+0393) followed by U+00A1-U+00FF. Plain
 *      box-drawing diagrams never match.
 *   4. Bytes that are not valid UTF-8.
 *   5. A UTF-8 byte order mark at the start of a file (except BOM_ALLOWED_EXT).
 *
 * This file is deliberately pure ASCII and builds every character set from
 * numeric code points, so it can never match itself. Keep it that way.
 *
 * Usage: node deploy/scripts/check-text-encoding.cjs
 * Exit:  0 = clean, 1 = mojibake / invalid UTF-8 / BOM found, 2 = git failed.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');

// Files that legitimately contain one of the sequences above. Path (as printed
// by git ls-files) -> reason. Never edit applied prisma migrations to satisfy
// this guard; allowlist the exact path here instead.
const ALLOWLIST = new Map([
  // Third-party exercise descriptions captured verbatim; the upstream text
  // already contains Windows-1252 mojibake (for example a mangled apostrophe).
  // Provenance snapshots - exact bytes matter, so they are not rewritten.
  ["services/health-service/prisma/sources/remaining-trainer-candidate-metadata.json", "upstream source snapshot"],
  ["services/health-service/prisma/sources/reviewed-tutorial-metadata.json", "upstream source snapshot"],
  ["services/health-service/prisma/sources/trainer-tutorial-candidate-metadata.json", "upstream source snapshot"],
]);

const TEXT_EXT = new Set([
  '.js', '.cjs', '.mjs', '.json', '.md', '.sql', '.yml', '.yaml',
  '.txt', '.sh', '.html', '.css', '.prisma', '.toml',
]);

// Data files that may keep a byte order mark. services/health-service/
// exercise-media-audit.json (generated output of scripts/auditExerciseMedia.mjs)
// carries one; it is data, so it is left as is.
const BOM_ALLOWED_EXT = new Set(['.json']);

// Lockfiles are generated; these directory names are vendored or generated.
const SKIP_BASENAMES = new Set(['package-lock.json']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.next', 'generated', 'vendor']);

/** Characters for a regex class, from code points and [lo, hi] ranges. */
function chars(parts) {
  let out = '';
  for (const p of parts) {
    if (Array.isArray(p)) out += String.fromCodePoint(p[0]) + '-' + String.fromCodePoint(p[1]);
    else out += String.fromCodePoint(p);
  }
  return out;
}
const cp = (n) => String.fromCodePoint(n);

// UTF-8 lead bytes of Latin-1, Latin Extended-A, Greek, Cyrillic, Indic (E0),
// punctuation/symbols (E2), specials (EF) and emoji (F0), as Windows-1252 chars.
const leads = chars([0xC2, 0xC3, 0xC4, 0xC5, 0xCE, 0xCF, 0xD0, 0xD1, 0xE0, 0xE2, 0xEF, 0xF0]);
// Continuation bytes 80-BF in Windows-1252, incl. the C1 controls it leaves undefined.
const continuations = chars([
  [0x80, 0xBF],
  0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017D, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022,
  0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x017E, 0x0178,
]);
const boxLeads = chars([0x251C, 0x252C]);
const latin1 = chars([[0xA0, 0xFF]]);
const gammaLatin1 = chars([[0xA1, 0xFF]]);

const patterns = [
  ['replacement character (original bytes lost)', new RegExp(cp(0xFFFD))],
  ['UTF-8 read as Windows-1252', new RegExp('[' + leads + '][' + continuations + ']')],
  [
    'UTF-8 read as code page 437',
    new RegExp(
      '[' + boxLeads + '][' + latin1 + ']|' + cp(0x251C) + cp(0x2310) + '|' +
        cp(0x252C) + cp(0x2556) + '|' + cp(0x0393) + '[' + gammaLatin1 + ']',
    ),
  ],
];

let listing;
try {
  listing = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
} catch (err) {
  console.error('git ls-files failed: ' + err.message);
  process.exit(2);
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const problems = [];
let scanned = 0;

for (const file of listing.split(cp(0)).filter(Boolean)) {
  if (ALLOWLIST.has(file)) continue;
  const parts = file.split('/');
  const base = parts[parts.length - 1];
  if (SKIP_BASENAMES.has(base) || parts.slice(0, -1).some((d) => SKIP_DIRS.has(d))) continue;
  const ext = path.extname(base).toLowerCase();
  if (!TEXT_EXT.has(ext)) continue;
  const abs = path.join(repoRoot, file);
  if (!fs.existsSync(abs)) continue;
  scanned++;

  const bytes = fs.readFileSync(abs);
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF && !BOM_ALLOWED_EXT.has(ext)) {
    problems.push(file + ': starts with a UTF-8 byte order mark (BOM)');
  }

  let text;
  try {
    text = decoder.decode(bytes);
  } catch (err) {
    problems.push(file + ': not valid UTF-8');
    continue;
  }

  const lines = text.split(cp(10));
  for (let i = 0; i < lines.length; i++) {
    for (const [label, re] of patterns) {
      if (!re.test(lines[i])) continue;
      const line = lines[i].trim();
      const shown = line.length > 90 ? line.slice(0, 90) + '...' : line;
      problems.push(file + ':' + (i + 1) + ': ' + label + cp(10) + '      ' + shown);
      break;
    }
  }
}

if (problems.length) {
  console.error('Text encoding problems in ' + problems.length + ' place(s):' + cp(10));
  for (const p of problems) console.error(p);
  console.error(
    cp(10) + 'These are characters damaged by reading or writing a file in the wrong encoding. ' +
      'Restore the intended character (do not just delete it) and write files as UTF-8 without a BOM. ' +
      'Never edit applied prisma migrations: allowlist the exact path in ALLOWLIST with a reason.',
  );
  process.exit(1);
}
console.log('check-text-encoding: OK - ' + scanned + ' text files, no mojibake or BOM.');
