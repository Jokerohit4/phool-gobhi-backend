// Side-effect module: gives every outbound axios call in this service a default
// timeout so a hung sibling service can't pin request handlers forever. Calls
// that pass their own `timeout` are unaffected. Override with
// OUTBOUND_HTTP_TIMEOUT_MS.
import axios from 'axios';

const DEFAULT_OUTBOUND_TIMEOUT_MS = Number(process.env.OUTBOUND_HTTP_TIMEOUT_MS) > 0
  ? Number(process.env.OUTBOUND_HTTP_TIMEOUT_MS)
  : 10000;

// Guarded: tests replace the axios module with a bare stub.
if (axios && axios.defaults && !axios.defaults.timeout) {
  axios.defaults.timeout = DEFAULT_OUTBOUND_TIMEOUT_MS;
}

export { DEFAULT_OUTBOUND_TIMEOUT_MS };
