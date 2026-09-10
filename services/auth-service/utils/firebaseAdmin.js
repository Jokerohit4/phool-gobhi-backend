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

const STAFF_APP_NAME = 'staff';
let staffApp;

// Staff (gobhi) Google sign-in is deliberately verified against the shared
// prod `phool-gobhi` Firebase project regardless of environment — staff
// identity isn't per-environment like customer/partner phone auth, whose
// admin app (above) is bound to whichever Firebase project this deploy's
// FIREBASE_SERVICE_ACCOUNT_JSON points at (dev vs prod project differ since
// the 2026-08-06 dev Firebase migration). A single shared app instance here
// would otherwise inherit that per-environment project and reject every
// dev-issued staff Google token, since its audience never matches.
function initStaffAdmin() {
  if (staffApp) return staffApp;
  const raw = process.env.FIREBASE_STAFF_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('FIREBASE_STAFF_SERVICE_ACCOUNT_JSON is not set');
  }
  const serviceAccount = JSON.parse(raw);
  staffApp = admin.apps.find(a => a?.name === STAFF_APP_NAME)
    || admin.initializeApp({ credential: admin.credential.cert(serviceAccount) }, STAFF_APP_NAME);
  return staffApp;
}

export async function verifyStaffFirebaseIdToken(idToken) {
  const app = initStaffAdmin();
  return admin.auth(app).verifyIdToken(idToken);
}
