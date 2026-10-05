import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { reportDate } from '../services/reportService.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRepo = resolve(here, '..', '..', '..', '..', 'phool-gobhi-customer-app');
const reportServiceSource = readFileSync(join(here, '..', 'services', 'reportService.js'), 'utf8');
const schema = readFileSync(join(here, '..', 'prisma', 'schema.prisma'), 'utf8');

/**
 * Where a report's date comes from, and what the app is told about it.
 *
 * Three sources now exist where there was one, and the ordering between them is
 * the entire safety property of the feature. A user's own date outranks a
 * parser's reading, a parser's reading outranks the upload day, and none of the
 * three may be silently promoted into another. These tests pin that order,
 * because a reordering here is invisible in every happy path and quietly
 * rewrites a user's health history.
 */

describe('report date precedence', () => {
  test('a date the user gave wins over one the parser read', () => {
    assert.equal(
      reportDate({ reportDate: '2026-03-04', detectedReportDate: '2026-07-01' }),
      '2026-03-04',
    );
  });

  test('a date the parser read wins over the upload day', () => {
    // The point of the feature: a report uploaded in October whose values were
    // measured in March. Keying the biometric entry on the upload day puts a
    // March measurement in an October trend, and because BiometricEntry is
    // unique on (userId, metric, localDate) it also overwrites any same-day
    // entry - two real measurements collapsed into one row with no error.
    assert.equal(
      reportDate({ detectedReportDate: '2026-03-04', createdAt: new Date('2026-10-06T09:00:00Z') }),
      '2026-03-04',
    );
  });

  test('the upload day remains the last resort', () => {
    assert.equal(
      reportDate({ createdAt: new Date('2026-10-06T09:00:00Z') }),
      '2026-10-06',
    );
  });

  test('an empty string is not a date', () => {
    // The app sends null for "no date", but a caller that sends '' should get
    // the same answer rather than an unparseable day reaching the upsert key.
    assert.equal(
      reportDate({ reportDate: '', detectedReportDate: '', createdAt: new Date('2026-10-06T09:00:00Z') }),
      '2026-10-06',
    );
  });

  test('a malformed detected date is ignored rather than trusted', () => {
    // Only ocrService.js writes this column, and it validates first. The shape
    // check here is belt-and-braces: a malformed day reaching BiometricEntry's
    // localDate would write a row nothing else can read or overwrite correctly.
    for (const bad of ['2026-3-4', '04/03/2026', 'not-a-date', '2026-03-04T00:00:00Z', 20260304]) {
      assert.equal(
        reportDate({ detectedReportDate: bad, createdAt: new Date('2026-10-06T09:00:00Z') }),
        '2026-10-06',
        `detectedReportDate ${JSON.stringify(bad)} should not be used`,
      );
    }
  });

  test('a malformed user date falls through to the next source', () => {
    assert.equal(
      reportDate({ reportDate: 'nonsense', detectedReportDate: '2026-03-04' }),
      '2026-03-04',
    );
  });

  test('a report with no usable source at all does not throw', () => {
    // CreatedAt is NOT NULL in the schema, so this is unreachable in practice -
    // but the confirm button returning a 500 is worse than a possibly-misdated
    // entry, and the date is visible and correctable either way.
    assert.doesNotThrow(() => reportDate({}));
    assert.match(reportDate({}), /^\d{4}-\d{2}-\d{2}$/);
  });

  test('a report with a null createdAt falls back to today rather than throwing', () => {
    assert.doesNotThrow(() => reportDate({ reportDate: null, createdAt: null }));
  });
});

describe('detected date storage', () => {
  test('the column exists and is nullable', () => {
    assert.match(schema, /detectedReportDate\s+String\?/);
  });

  test('it is a separate column from the one the user fills', () => {
    // One column for both would make a parser's reading indistinguishable from
    // a user's statement everywhere downstream, which is the reason this is
    // additive rather than a change to HealthReport.reportDate.
    assert.match(schema, /reportDate\s+String\?/);
    const model = schema.slice(schema.indexOf('model HealthReport'), schema.indexOf('model ReportExtraction'));
    assert.match(model, /detectedReportDate/);
  });

  test('the migration adds the column without touching existing rows', () => {
    const migration = readFileSync(
      join(here, '..', 'prisma', 'migrations', '20261013000000_health_report_detected_date', 'migration.sql'),
      'utf8',
    );
    assert.match(migration, /ADD COLUMN IF NOT EXISTS "detectedReportDate" TEXT/);
    assert.doesNotMatch(
      migration,
      /UPDATE\s+"health"\."HealthReport"/i,
      'no backfill: an existing report has no detected date, and inventing one would be a guess',
    );
  });

  test('a detected date never overwrites a user date', () => {
    const processStart = reportServiceSource.indexOf('export async function processReportService');
    const processBody = reportServiceSource.slice(
      processStart,
      reportServiceSource.indexOf('\nexport ', processStart + 10),
    );

    assert.match(
      processBody,
      /detectedDate\?\.date\s*&&\s*!report\.reportDate/,
      'the detected date must be conditional on the user not having given one',
    );

    // The write itself names only the detected column. An update listing
    // reportDate would be an overwrite whatever the guard above says.
    const write = processBody.match(/data:\s*\{\s*detectedReportDate[^}]*\}/);
    assert.ok(write, 'expected a write of detectedReportDate');
    assert.doesNotMatch(write[0], /reportDate:\s*[^.]/, 'the write must not touch reportDate');
  });

  test('a failure to store the detected date does not fail the report', () => {
    // The date is worth having but is not worth losing the report's readings
    // over. Best-effort, so a detection problem stays visible in the logs
    // without turning into a processing failure the user cannot act on.
    const processStart = reportServiceSource.indexOf('export async function processReportService');
    const processBody = reportServiceSource.slice(
      processStart,
      reportServiceSource.indexOf('\nexport ', processStart + 10),
    );
    assert.match(
      processBody,
      /data:\s*\{\s*detectedReportDate[\s\S]*?\}\)\s*\.catch\(/,
      'the detected date write should be best-effort',
    );
  });

  test('the OCR response shape carries the date alongside the readings', () => {
    const ocrSource = readFileSync(join(here, '..', 'utils', 'ocrService.js'), 'utf8');
    assert.match(ocrSource, /return \{\s*extractions:\s*results,\s*detectedDate:/);
    assert.match(reportServiceSource, /const \{ extractions, detectedDate \} = await extractBiomarkersFromPDF/);
  });

  test('the detector reads the document text, not the trained entities', () => {
    const ocrSource = readFileSync(join(here, '..', 'utils', 'ocrService.js'), 'utf8');
    assert.match(
      ocrSource,
      /data\.document\.text/,
      'nothing in the processor schema is promised to be a date; document.text always is',
    );
  });
});

describe('the app is told which source a date came from', () => {
  test('the model exposes both dates', () => {
    const model = readFileSync(
      join(appRepo, 'lib', 'data', 'models', 'health_report_model.dart'),
      'utf8',
    );
    assert.match(model, /final String\? detectedReportDate;/);
    assert.match(model, /json\['detectedReportDate'\]/);
  });

  test('the tile says a parsed date was read off the report', () => {
    // The screen is the place a user compares this against their own paperwork.
    // A machine reading presented in the same voice as something the user said
    // would be a small lie that only matters on the day it is wrong.
    const screen = readFileSync(
      join(appRepo, 'lib', 'presentation', 'pages', 'health', 'health_vault_verification_screen.dart'),
      'utf8',
    );
    assert.match(screen, /isReportDateDetected/);
    assert.match(screen, /Read from your report as/);
  });
});