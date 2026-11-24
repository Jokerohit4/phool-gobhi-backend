// Why a report could not be read, as a short code the app turns into advice.
// Kept apart from ocrService.js so the report pipeline can classify without
// importing the OCR client (and so its tests do not have to mock it).
//
//   TOO_LONG     more pages than the reader accepts: send only the results pages
//   PASSWORD     the PDF needs a password to open
//   UNREADABLE   the reader refused the file (corrupt, blank, not a document)
//   BUSY         the reader was rate limited or down: worth trying again shortly
//   UNAVAILABLE  reading is not configured on this server
//   STALLED      processing never finished (an instance died mid-read)
//   READ_FAILED  anything else

export const FAILURE_CODES = Object.freeze(['TOO_LONG', 'PASSWORD', 'UNREADABLE', 'BUSY', 'UNAVAILABLE', 'STALLED', 'READ_FAILED']);

// A different file is needed; trying the same one again will not help.
export const NEEDS_DIFFERENT_FILE = Object.freeze(['TOO_LONG', 'PASSWORD', 'UNREADABLE']);

export const MAX_REPORT_PAGES = 40;

export function isPageLimitError(err) {
  const detail = String(err?.response?.data?.error?.message || err?.message || '');
  return err?.response?.status === 400 && /page/i.test(detail) && /limit|exceed|maximum|more than|too many/i.test(detail);
}

export function classifyFailure(err) {
  if (String(err?.message || '') === 'OCR_CONFIG_MISSING') return 'UNAVAILABLE';
  const status = err?.response?.status;
  const detail = String(err?.response?.data?.error?.message || '');
  if (isPageLimitError(err)) return 'TOO_LONG';
  if (/password|encrypt/i.test(detail)) return 'PASSWORD';
  if (status === 400 || status === 415 || status === 422) return 'UNREADABLE';
  if (status === 429 || (status >= 500 && status < 600)) return 'BUSY';
  if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT' || /timeout/i.test(String(err?.message || ''))) return 'BUSY';
  return 'READ_FAILED';
}

// A lower bound on a PDF's page count, read from page objects that are visible
// in the raw bytes. PDFs that keep their page objects inside compressed streams
// show none, so null means "unknown", never "one page". Used only to refuse a
// file that is plainly too long before paying to read it.
export function estimatePdfPages(buffer) {
  if (!buffer || buffer.length < 8) return null;
  const found = buffer.toString('latin1').match(/\/Type\s*\/Page(?![A-Za-z])/g);
  return found?.length || null;
}

// A report is stalled when it has sat in flight longer than a read can take. The
// read itself is bounded (fetch 30 s + two reader calls of 90 s + the optional
// model call), so five minutes with no write means the instance that owned it
// died, and nothing will ever finish it.
export const STALL_MS = 5 * 60 * 1000;

export function isStalledReport(report, now = Date.now()) {
  if (report?.status !== 'PENDING' && report?.status !== 'PROCESSING') return false;
  const since = report.status === 'PROCESSING'
    ? report.processingStartedAt || report.updatedAt || report.createdAt
    : report.updatedAt || report.createdAt;
  const at = new Date(since).getTime();
  return Number.isFinite(at) && now - at > STALL_MS;
}
