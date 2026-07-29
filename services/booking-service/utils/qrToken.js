import crypto from 'crypto';

// Signs the booking check-in QR payload so a partner's scan can be
// cryptographically verified as authentic and unexpired, instead of trusting
// a bare, guessable booking id (the id alone is what used to be encoded).
// Falls back to INTERNAL_API_KEY so this works without provisioning a new
// secret on every environment — rotate to a dedicated QR_SIGNING_SECRET later
// if the two ever need to change independently.
const QR_SECRET = (process.env.QR_SIGNING_SECRET || process.env.INTERNAL_API_KEY || '').trim();
if (!QR_SECRET) {
  console.warn('qrToken: no QR_SIGNING_SECRET or INTERNAL_API_KEY set — booking QR codes will be signed with an empty key');
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h — comfortably covers a same-day session window

function hmac(payload) {
  return crypto.createHmac('sha256', QR_SECRET).update(payload).digest('hex');
}

export function signQrToken(bookingId, gymId, ttlMs = DEFAULT_TTL_MS) {
  const expiry = Date.now() + ttlMs;
  const payload = `${bookingId}.${gymId}.${expiry}`;
  return `${payload}.${hmac(payload)}`;
}

// Verifies a scanned token actually names this booking/gym, hasn't expired,
// and wasn't tampered with. Returns a reason on failure for logging/debugging
// — never surfaced verbatim to the client beyond a generic error message.
export function verifyQrToken(token, bookingId, gymId) {
  if (typeof token !== 'string' || !token) return { valid: false, reason: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 4) return { valid: false, reason: 'malformed' };

  const [tokenBookingId, tokenGymId, expiryStr, signature] = parts;
  const payload = `${tokenBookingId}.${tokenGymId}.${expiryStr}`;
  const expected = hmac(payload);

  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, reason: 'bad_signature' };
  }
  if (Number(tokenBookingId) !== Number(bookingId) || Number(tokenGymId) !== Number(gymId)) {
    return { valid: false, reason: 'mismatch' };
  }
  if (Date.now() > Number(expiryStr)) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true };
}
