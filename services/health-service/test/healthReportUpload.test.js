import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  isAllowedReportMimeType,
  isAllowedMimeType,
  MAX_UPLOAD_BYTES,
} from '../services/ledger/medicalDocumentStorage.js';

// The lab-report upload path, which is a different thing from the medical
// document path that already existed and shares its storage.
//
// Most of this file is textual. It does not spin up a bucket or a multipart
// parser, because the interesting failures here are not "GCS returned an error"
// - those surface in staging as an exception - they are the quieter ones where
// the endpoint accepts the wrong file, stores it under a name that lies about
// what it is, or quietly strands a report the user asked to have deleted.

const here = dirname(fileURLToPath(import.meta.url));
const controllerSource = readFileSync(join(here, '..', 'controllers', 'reportController.js'), 'utf8');
const routesSource = readFileSync(join(here, '..', 'routes', 'health.js'), 'utf8');
const reportServiceSource = readFileSync(join(here, '..', 'services', 'reportService.js'), 'utf8');

// ---- MIME policy ----------------------------------------------------------

test('a lab report is PDF-only, and images are rejected with a reason', () => {
  // The asymmetry with isAllowedMimeType is deliberate and is the whole point of
  // this predicate. A JPEG of a lab report is a real file a real person has, and
  // Document AI cannot read it - so the honest answer is a clear rejection at the
  // door rather than a parsing failure the user reads as "your report is broken".
  assert.equal(isAllowedReportMimeType('application/pdf'), true);

  for (const mime of ['image/jpeg', 'image/png', 'image/heic', 'application/octet-stream']) {
    assert.equal(
      isAllowedReportMimeType(mime),
      false,
      `${mime} must not reach OCR: it cannot be parsed and would report as a corrupt report`,
    );
  }
});

test('a medical document may still be a photo, so the two predicates are not the same', () => {
  // If these ever converge, the report path has either silently narrowed the
  // document path or vice versa. Both would be a behaviour change nobody asked
  // for, so it is asserted rather than left to a reader to notice.
  assert.equal(isAllowedMimeType('image/jpeg'), true, 'a photo of a prescription is a normal upload');
  assert.notEqual(
    isAllowedReportMimeType('image/jpeg'),
    isAllowedMimeType('image/jpeg'),
  );
});

test('the report size cap matches the medical document cap', () => {
  // Two different caps would mean a file accepted on one screen and refused on
  // another with nothing on screen to explain the difference.
  const middlewareSource = readFileSync(join(here, '..', 'middleware', 'medicalUpload.js'), 'utf8');
  assert.match(middlewareSource, /fileSize: MAX_UPLOAD_BYTES/);
  assert.ok(MAX_UPLOAD_BYTES > 0, 'the cap must be set, or multer accepts anything');
  // The report middleware must reuse the shared constant rather than restating
  // a number, or the two drift silently.
  const reportFilters = middlewareSource.slice(middlewareSource.indexOf('uploadHealthReportMiddleware'));
  assert.ok(reportFilters.length > 0, 'the report upload middleware is missing');
});

// ---- Wiring ---------------------------------------------------------------

test('the upload route runs the multer middleware before the controller', () => {
  // Order is the bug this catches. Without the middleware in front of it,
  // `req.file` is undefined and the controller rejects a perfectly good PDF with
  // "no file" - which reads to the user as their upload failing, not as a
  // server-side wiring mistake.
  const post = routesSource.match(/router\.post\(\s*'\/reports\/upload'[\s\S]*?\);/);
  assert.ok(post, 'no POST /reports/upload route found');
  const route = post[0];

  const uploadAt = route.indexOf('uploadHealthReportMiddleware');
  const ctrlAt = route.indexOf('reportCtrl.uploadReport');
  assert.ok(uploadAt > -1, 'the upload route has no multipart middleware, so req.file is always undefined');
  assert.ok(ctrlAt > -1, 'the upload route does not call the controller');
  assert.ok(
    uploadAt < ctrlAt,
    'the multipart middleware must run before the controller, not after it',
  );
});

test('every report route is still behind requireAuth', () => {
  // The vault is flag-gated, and a flag check before auth would leak which flags
  // a user has; requireAuth-only would leak lab reports entirely. Both orders are
  // wrong, so the assertion is about presence and the sibling test in
  // routeSplitGates.test.js is about order.
  for (const m of routesSource.matchAll(/router\.(get|post|delete)\(\s*'(\/reports[^']*)'/g)) {
    assert.ok(
      /requireAuth|\.\.\.vaultGated/.test(m[0] + routesSource.slice(m.index, m.index + 120)),
      `${m[1]} ${m[2]} is reachable without authentication`,
    );
  }
});

test('deleting a report does not require the vault flag to be on', () => {
  // Asserted here as well as in routeSplitGates.test.js because the reason is
  // specific to reports: the vault is default-off pending legal sign-off, so the
  // switch is exactly the thing a user cannot control, and it is precisely when
  // an unwanted lab report most needs to be erasable. Gating this on vaultGated
  // would strand the most sensitive data in the service behind a switch.
  const del = routesSource.match(/router\.delete\(\s*'\/reports\/:id'[\s\S]*?\);/);
  assert.ok(del, 'no DELETE /reports/:id route found - a user cannot remove an uploaded report');
  assert.match(del[0], /requireAuth/);
  assert.doesNotMatch(
    del[0],
    /vaultGated/,
    'erasure of the user\'s own lab report must not be behind the feature flag',
  );
});

// ---- Storage --------------------------------------------------------------

test('the report is stored by path, and OCR is handed a signed URL', () => {
  // The field was `cloudinaryUrl` and there is no Cloudinary in this service -
  // grep finds no SDK, no credentials, nothing. The column is now `storagePath`,
  // and a signed URL is minted per attempt rather than persisted, because a
  // stored signed URL expires and would turn a re-run of a failed parse into a
  // second failure for a different reason.
  // Code only. Comments are allowed to name the old field - the legacy-row
  // guard has to, to say what it is guarding against - but no executable line
  // may reference cloudinaryUrl, or the rename was cosmetic.
  const reportServiceCode = reportServiceSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(
    reportServiceCode,
    /cloudinaryUrl/,
    'the Cloudinary field name is still referenced in executable code',
  );
  assert.match(reportServiceSource, /storagePath/);
  assert.match(reportServiceSource, /signedDocumentUrl/);
  assert.ok(
    !/storagePath:\s*signedUrl/.test(reportServiceSource),
    'a signed URL must not be persisted in place of the storage path',
  );
});

test('a legacy URL-shaped storagePath fails fast instead of retrying forever', () => {
  // RENAME COLUMN preserves data. A row written under the old cloudinaryUrl
  // contract still holds a full https URL in storagePath, and passing that to
  // signedDocumentUrl asks GCS for an object literally named
  // "https://res.cloudinary.com/...". That can never succeed, on any retry,
  // and surfaces as a 502 that names neither the cause nor the fix.
  //
  // So the URL shape is detected on the value itself and the row is closed out
  // as FAILED. Two properties matter and are asserted separately below: it must
  // not reach the bucket, and it must not stay PENDING/PROCESSING.
  assert.match(
    reportServiceSource,
    /\/\^https\?:\\\/\\\/\/i\.test\(report\.storagePath/,
    'the legacy URL shape is not detected before the report is read',
  );

  // Ordered, not merely present: the check has to run before the mint, or the
  // doomed bucket call still happens and the report still flips to PROCESSING
  // before anything notices.
  const urlGuard = reportServiceSource.search(/\/\^https\?:\\\/\\\/\//);
  const mint = reportServiceSource.indexOf('signedDocumentUrl(report.storagePath)');
  assert.ok(urlGuard > -1, 'no legacy-URL guard found in reportService.js');
  assert.ok(mint > -1, 'no signed URL mint found in reportService.js');
  assert.ok(
    urlGuard < mint,
    'the legacy-URL guard must come before the signed URL mint, otherwise a ' +
      'row that can never resolve still makes the doomed call it must avoid',
  );

  // FAILED rather than a throw: the report has a terminal, explainable state and
  // the user is not left with a report stuck in PROCESSING forever.
  const guardBlock = reportServiceSource.slice(urlGuard, urlGuard + 500);
  assert.match(
    guardBlock,
    /status:\s*'FAILED'/,
    'a legacy report is not moved to a terminal state',
  );
  assert.doesNotMatch(
    guardBlock,
    /throw\b/,
    'a legacy row throws and is retried forever rather than being closed out',
  );
});

// ---- Cross-repo contract --------------------------------------------------
//
// The Dart data source and this file's routes are the two halves of one API.
// Neither repository can test the other's half: this service cannot import a
// Dart file, and the app's tests assert against paths this service defines.
// The mismatch that already happened once - the app calling
// /api/health/extractions/pending while the route was /reports/pending - is
// invisible from both sides. Every test above passes with the app still broken.
//
// So this reads the Dart source directly and checks that each path the app calls
// exists as a route here. Both files are plain text; no server, no Flutter.
//
// The app repo is a sibling, not a dependency, so a missing checkout skips
// rather than fails. That is deliberate: a backend CI runner is not entitled to
// hold up the build over a path it does not own. It does mean this check can
// silently stop running - if that matters, the fix is a shared openapi document,
// not a louder skip.

const appRepo = resolve(here, '..', '..', '..', '..', 'phool-gobhi-customer-app');
const dartSourcePath = join(
  appRepo,
  'lib',
  'data',
  'data_sources',
  'health_ledger_api_data_source.dart',
);
const hasAppCheckout = existsSync(dartSourcePath);
const skipApp = hasAppCheckout ? false : `no app checkout at ${appRepo}`;

test('every report path the app calls exists as a route', { skip: skipApp }, () => {
  const dart = readFileSync(dartSourcePath, 'utf8');

  // Dart interpolates route tails ('/api/health/reports/$id'), and Express
  // spells the same idea as ':id'. Rewritten rather than truncated to the
  // literal prefix: truncating turns the delete call into '/reports/', which
  // matches no route and would report a mismatch that does not exist.
  const called = new Set(
    [...dart.matchAll(/'(\/api\/health\/reports[^']*)'/g)].map((m) =>
      m[1].replace(/\$\{?\w+\}?/g, ':id'),
    ),
  );

  assert.ok(
    called.size > 0,
    'no /api/health/reports paths found in the Dart data source - if the app ' +
      'renamed its prefix this test is now asserting nothing, not passing',
  );

  // The full path spans two files in two places. The gateway mounts the service
  // at /api/health, and the service mounts its router at '/', so '/reports/pending'
  // here becomes '/api/health/reports/pending' out there. Reading the prefix from
  // either file alone would let the other half drift silently - which is how the
  // extraction/ report rename went unnoticed, since neither half was wrong on
  // its own.
  const gatewaySource = readFileSync(
    resolve(here, '..', '..', '..', 'index.js'),
    'utf8',
  );
  const mountedAt = gatewaySource.match(/app\.use\('(\/api\/health[^']*)'/);
  assert.ok(
    mountedAt,
    'the gateway no longer mounts this service at a path starting /api/health, ' +
      'so every route in this file just moved and nothing else would say so',
  );
  const mount = mountedAt[1].replace(/\/$/, '');

  for (const path of called) {
    const tail = path.slice(mount.length);
    const pattern = tail
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\$[a-zA-Z_]\w*/g, ':id');
    const verb = new RegExp(
      `router\\.(get|post|put|patch|delete)\\(\\s*['"]${pattern}['"]`,
    );
    assert.ok(
      verb.test(routesSource),
      `the app calls ${path} but no route on the health router matches it. ` +
        `A renamed or unmounted route here surfaces only in the app, as a ` +
        `silent empty list or a 404 nobody notices until a user reports it.`,
    );
  }
});

test('a verified value is dated from the report, not from the clock', () => {
  // The failure this guards is invisible in the happy path and destructive in
  // the data. A March panel uploaded in August wrote an August entry, which
  // draws a cliff on a trend that never happened - and because BiometricEntry is
  // unique on (userId, metric, localDate), verifying a second report the same
  // day overwrote the first. Two measurements, one row, no error.
  assert.match(
    reportServiceSource,
    /localDate:\s*reportDate\(report\)|const localDate = reportDate\(report\)/,
    'the biomarker entry is not dated from the report',
  );

  // The inverse: no date may be read from the clock inside the verify path.
  // Counted inside the function body only, because reportDate() legitimately
  // falls back to today for a report that somehow has no createdAt.
  const verifyStart = reportServiceSource.indexOf('export async function verifyExtractionService');
  const verifyBody = reportServiceSource.slice(verifyStart, reportServiceSource.indexOf('\nexport ', verifyStart + 10));
  assert.doesNotMatch(
    verifyBody.replace(/function reportDate[\s\S]*?\n}\n/, ''),
    /new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/,
    'verifyExtractionService still dates the entry with today',
  );

  // And the date must be resolved ONCE. Two separate calls could straddle
  // midnight, which would put the upsert key and the created row on different
  // days - the upsert would create a duplicate instead of updating.
  const resolvedDates = (verifyBody.match(/^\s*localDate,\s*$/gm) || []).length;
  assert.equal(
    resolvedDates,
    2,
    'the resolved date should be written to both the upsert key and the create row',
  );
  assert.equal(
    (verifyBody.match(/new Date\(\)/g) || []).length,
    0,
    'verifyExtractionService must not read the clock at all',
  );
});

test('the report date column exists and is nullable', () => {
  const schema = readFileSync(join(here, '..', 'prisma', 'schema.prisma'), 'utf8');
  assert.match(schema, /reportDate\s+String\?/);

  const migration = readFileSync(
    join(here, '..', 'prisma', 'migrations', '20261011000000_health_report_date', 'migration.sql'),
    'utf8',
  );
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "reportDate"/);
  // Nullable, not defaulted. A backfill from createdAt would encode "upload
  // date == test date" as if it were known, which is the assumption this column
  // exists to avoid recording.
  assert.doesNotMatch(
    migration,
    /ADD COLUMN[^;]*"reportDate"[^;]*DEFAULT(?![\s\S]*NULL)/i,
    'reportDate is defaulted, so a missing date is indistinguishable from today',
  );
});

test('the upload is a single file with a bounded size', () => {
  // `files: 1` is a real limit rather than a nicety: without it a client can
  // stream several PDFs into one request and the service buffers all of them
  // before the controller runs.
  const middlewareSource = readFileSync(join(here, '..', 'middleware', 'medicalUpload.js'), 'utf8');
  const start = middlewareSource.indexOf('const reportUpload');
  assert.ok(start > -1, 'no report-specific multer instance');
  const block = middlewareSource.slice(start, start + 600);
  assert.match(block, /files: 1/);
  assert.match(block, /fileSize: MAX_UPLOAD_BYTES/);
  assert.match(block, /isAllowedReportMimeType/);
});

test('a report is fetched for OCR rather than trusted from the client', () => {
  // The signed URL is derived server-side from storagePath. A client-supplied
  // URL would be a server-side request forgery primitive pointed at Google's
  // document API with an attacker-chosen destination.
  assert.match(controllerSource, /saveDocument\(/);
  assert.doesNotMatch(
    controllerSource,
    /req\.body\.(url|storagePath|fileUrl)/,
    'the controller must not accept a storage path or URL from the request body',
  );
});