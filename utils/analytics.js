// First-party tracking facade. Canonical implementation: analyticsTransport.js.
import { createAnalytics } from './analyticsTransport.js';
import { QUEUE_DIAGNOSTIC_EVENTS } from './exploreQueueDiagnosticSchema.js';
const analytics = createAnalytics({ protectedEvents: QUEUE_DIAGNOSTIC_EVENTS });
export const track = analytics.track;
export const ingest = analytics.ingest;
export default { track, ingest };
