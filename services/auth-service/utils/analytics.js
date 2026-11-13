// First-party tracking facade. Canonical implementation: analyticsTransport.js.
import { createAnalytics } from './analyticsTransport.js';
const analytics = createAnalytics();
export const track = analytics.track;
export const ingest = analytics.ingest;
export const deliverReceiptEvent = analytics.deliverReceiptEvent;
export { insertReceiptEvent } from './analyticsTransport.js';
export default { track, ingest };
