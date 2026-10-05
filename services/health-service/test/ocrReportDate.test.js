import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectReportDateFromText } from '../utils/ocrService.js';

const NOW = new Date('2026-10-06T12:00:00Z');

describe('detectReportDateFromText', () => {
  describe('reads a labelled, unambiguous date', () => {
    test('takes an ISO date after a collection label', () => {
      const found = detectReportDateFromText('COLLECTION DATE: 2026-03-04\nSpecimen: Serum', NOW);
      assert.equal(found.date, '2026-03-04');
    });

    test('takes a spelled-out month written day-first', () => {
      const found = detectReportDateFromText('Collected: 4 Mar 2026 09:15\nHaemoglobin: 14.2 g/dL', NOW);
      assert.equal(found.date, '2026-03-04');
    });

    test('takes a spelled-out month written month-first', () => {
      const found = detectReportDateFromText('Sample date Mar 4, 2026\nGlucose 5.1 mmol/L', NOW);
      assert.equal(found.date, '2026-03-04');
    });

    test('takes a hyphenated spelled-out month', () => {
      const found = detectReportDateFromText('Date collected - 04-March-2026', NOW);
      assert.equal(found.date, '2026-03-04');
    });

    test('prefers the draw date over a later reported date on the same page', () => {
      const found = detectReportDateFromText('Collected: 04 Mar 2026\nReported: 06 Mar 2026', NOW);
      assert.equal(found.date, '2026-03-04');
      assert.equal(found.confidence, 0.9);
    });

    test('falls back to the reported date when no draw date is present', () => {
      const found = detectReportDateFromText('Reported: 06 Mar 2026\nHaemoglobin 14.2', NOW);
      assert.equal(found.date, '2026-03-06');
      assert.ok(found.confidence < 0.7, 'a reported date is a weaker reading');
    });

    test('reports the text it matched alongside the confidence', () => {
      const found = detectReportDateFromText('Collection Date: 2026-03-04', NOW);
      assert.equal(found.label, '2026-03-04');
      assert.ok(found.confidence > 0.9);
    });
  });

  describe('refuses to guess', () => {
    test('returns null for a numeric date that could be read either way round', () => {
      // 3 April in most of the world, 4 March in the US. Silently picking one is
      // how a report ends up filed under a day nothing happened.
      assert.equal(detectReportDateFromText('Collected: 03/04/2026', NOW), null);
    });

    test('returns null for an unlabelled date', () => {
      assert.equal(detectReportDateFromText('2026-03-04\nHaemoglobin 14.2', NOW), null);
    });

    test('reads a numeric date when the day can only be the day', () => {
      assert.equal(detectReportDateFromText('Collected: 13/04/2026', NOW).date, '2026-04-13');
      assert.equal(detectReportDateFromText('Collected: 04/13/2026', NOW).date, '2026-04-13');
    });

    test('skips a date of birth to reach the draw date on the next line', () => {
      const found = detectReportDateFromText('Date of Birth: 4 Mar 1980\nCollected: 2026-03-04', NOW);
      assert.equal(found.date, '2026-03-04');
    });

    test('returns null when a date of birth is the only labelled date', () => {
      assert.equal(detectReportDateFromText('Date of Birth: 4 Mar 1980', NOW), null);
    });

    test('returns null when a date of birth shares a line with a collection label', () => {
      assert.equal(detectReportDateFromText('Collected: Date of Birth 4 Mar 1980', NOW), null);
    });

    test('returns null when the nearest label is an appointment', () => {
      assert.equal(detectReportDateFromText('Next appointment: 2026-03-04', NOW), null);
    });

    test('returns null when the nearest label is an expiry', () => {
      assert.equal(detectReportDateFromText('Valid until: 2026-03-04', NOW), null);
    });

    test('returns null when the nearest label is the print date', () => {
      assert.equal(detectReportDateFromText('Printed on: 2026-03-04', NOW), null);
    });

    test('returns null for empty, blank or non-string input', () => {
      assert.equal(detectReportDateFromText('', NOW), null);
      assert.equal(detectReportDateFromText('   \n  ', NOW), null);
      assert.equal(detectReportDateFromText(null, NOW), null);
      assert.equal(detectReportDateFromText(undefined, NOW), null);
      assert.equal(detectReportDateFromText(12345, NOW), null);
    });

    test('keeps the first of two dates at equal confidence', () => {
      const found = detectReportDateFromText('Collected: 4 Mar 2026\nCollected: 9 Mar 2026', NOW);
      assert.equal(found.date, '2026-03-04');
    });
  });

  describe('enforces the same bounds a person could enter by hand', () => {
    test('refuses a date in the future', () => {
      assert.equal(detectReportDateFromText('Collected: 2027-01-01', NOW), null);
      assert.equal(detectReportDateFromText('Collected: 7 Oct 2026', NOW), null);
      assert.equal(detectReportDateFromText('Collected: 06-10-2027', NOW), null);
    });

    test('accepts today, which is allowed and common', () => {
      // The app's own picker has lastDate: DateTime.now(), so refusing today
      // would make OCR stricter than the manual path and push same-day users
      // back to being asked.
      assert.equal(detectReportDateFromText('Collected: 6 Oct 2026', NOW).date, '2026-10-06');
    });

    test('refuses a day that does not exist rather than rolling it forward', () => {
      assert.equal(detectReportDateFromText('Collected: 31 Feb 2026', NOW), null);
      assert.equal(detectReportDateFromText('Collected: 2026-02-31', NOW), null);
      assert.equal(detectReportDateFromText('Collected: 29 Feb 2025', NOW), null);
    });

    test('accepts a real leap day', () => {
      assert.equal(detectReportDateFromText('Collected: 29 Feb 2024', NOW).date, '2024-02-29');
    });

    test('refuses a date before 1900', () => {
      assert.equal(detectReportDateFromText('Collected: 1899-12-31', NOW), null);
      assert.equal(detectReportDateFromText('Collected: 4 Mar 1899', NOW), null);
    });

    test('accepts the oldest date the app will let a user pick', () => {
      assert.equal(detectReportDateFromText('Collected: 1 Jan 1900', NOW).date, '1900-01-01');
    });

    test('refuses an impossible month', () => {
      assert.equal(detectReportDateFromText('Collected: 4 Foo 2026', NOW), null);
    });
  });

  describe('does not leak a date across lines', () => {
    test('ignores a collection label that is not on the same line', () => {
      assert.equal(detectReportDateFromText('Collection Date\n\nHaemoglobin 14.2 on 4 Mar 2026', NOW), null);
    });

    test('matches a label at the far end of a long header line', () => {
      const found = detectReportDateFromText('Northside Diagnostics  Collected: 04 Mar 2026  Haemoglobin: 14.2 g/dL', NOW);
      assert.equal(found.date, '2026-03-04');
    });
  });

  describe('realistic document text', () => {
    test('reads a full lab report header', () => {
      const text = [
        'NORTHSIDE DIAGNOSTICS LABORATORY',
        'Patient: Jane Doe    MRN: 4008123',
        'Date of Birth: 12/05/1984',
        'Collected: 04-Mar-2026 09:15',
        'Received: 04-Mar-2026 11:02',
        'Reported: 05-Mar-2026 16:40',
        '',
        'TEST            RESULT      UNIT      REFERENCE',
        'Haemoglobin     14.2        g/dL      12.0-16.0',
        'Glucose         5.1         mmol/L    3.9-5.5',
      ].join('\n');
      assert.equal(detectReportDateFromText(text, NOW).date, '2026-03-04');
    });

    test('reads a report whose only date is a numeric reported date', () => {
      const found = detectReportDateFromText(['LAB REPORT', 'Reported 14/04/2026', 'TSH 2.1 mIU/L'].join('\n'), NOW);
      assert.equal(found.date, '2026-04-14');
    });

    test('returns null for a page of numbers with no date at all', () => {
      const text = 'Haemoglobin 14.2 g/dL\nGlucose 5.1 mmol/L\nLDL 3.4 mmol/L';
      assert.equal(detectReportDateFromText(text, NOW), null);
    });
  });
});