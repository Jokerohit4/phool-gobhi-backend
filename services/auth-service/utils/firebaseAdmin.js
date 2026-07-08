import admin from 'firebase-admin';

let initialized = false;

// Unlike booking-service's push-notification init (which no-ops silently on
// failure since a missed push isn't fatal), a failed init here means the
// caller's entire request can't be completed — so this throws instead.
function initAdmin() {
  if (initialized || admin.apps.length) {
    initialized = true;
    return;
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not set');
  }
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  initialized = true;
}

export async function verifyFirebaseIdToken(idToken) {
  initAdmin();
  return admin.auth().verifyIdToken(idToken);
}
