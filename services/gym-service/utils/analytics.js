// First-party tracking facade. Canonical implementation: analyticsTransport.js.
import { createAnalytics } from './analyticsTransport.js';
const analytics = createAnalytics();
export const track = analytics.track;
export const ingest = analytics.ingest;
export default { track, ingest };
