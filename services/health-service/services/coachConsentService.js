import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Consent for Gobhi the Coach. Two scopes, deliberately separate from each
// other and from the ledger's:
//
//   basic       - lets the coach read the plan and the score built from it.
//                 This is the scope the whole journey hangs off: without it
//                 the server never serves a plan (the app's fallback starter
//                 week is bundled client-side and never scored).
//   supplements - the narrow extra that lets the supplement habit collect.
//                 Separate because agreeing the coach may build a workout
//                 plan says nothing about wanting a supplement schedule, and
//                 bundling them is how a consent screen ends up clicked
//                 without being read.
//
// Its own row rather than a scope on HealthConsent, for the same reason
// healthProfileConsent and biometricConsent are separate: HealthConsent is the
// device-access grant and needs a platform, and nobody should have to connect
// Apple Health before a coach may read their plan. Shaped like
// CoachConsent's neighbours: server-stamped policy versions per scope, revoke
// sets revokedAt, absence of the row means "not asked yet" — never "declined".
export const BASIC_SCOPE = 'basic';
export const SUPPLEMENTS_SCOPE = 'supplements';
export const COACH_SCOPES = [BASIC_SCOPE, SUPPLEMENTS_SCOPE];

// The wording currently on the coach consent screens, and the only value a
// grant may be recorded against. Bump when the prompt describes a different
// decision, the same rule LEDGER_POLICY_VERSION follows. The client sends the
// version it rendered (POST /coach-consent), and a mismatch is refused — a
// stale build must not be able to record agreement to copy that was never on
// its screen.
//
// This value and the customer app's kCoachPolicyVersion (lib/presentation/
// bloc/onboarding/onboarding_cubit.dart) are the same fact stated twice and
// they MUST move together: the app renders the copy and sends what it saw,
// this file decides what may be recorded, and a drift means every grant from
// a real build is refused with no way for the user to proceed. ('2026-10-11'
// is the version the merged onboarding flow renders - the Contracts' schema
// comment shows "2026-10" only to illustrate the policyVersions map's shape.)
export const COACH_POLICY_VERSION = '2026-10-11';

// Reads the per-scope version map, tolerating both shapes Prisma can hand
// back for a Json column (the parsed object, or the string a raw query would
// produce). Same tolerance as ledgerConsentService.scopeVersionsOf, for the
// same reason: a JSON.parse crash inside a consent check is a bad place to
// find out.
function policyVersionsOf(row) {
  const raw = row?.policyVersions;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

async function readRow(userId) {
  return prisma.coachConsent.findUnique({ where: { userId } });
}

/// The GET shape: the live scopes plus the timestamps that describe them, or
/// just `{scopes: []}` before the first grant. `revokedAt` is set only when
/// NO scope is left — a user who granted basic, granted supplements, then
/// withdrew supplements still has a live consent for basic, and a non-null
/// revokedAt next to a non-empty scopes list would read as a contradiction.
export async function getCoachConsentService(userId) {
  const row = await readRow(userId);
  if (!row) return { scopes: [] };
  const revokedAt = row.revokedAt || null;
  return {
    scopes: revokedAt ? [] : row.scopes || [],
    grantedAt: row.grantedAt,
    revokedAt,
  };
}

/// Whether a scope is live right now. The gate middleware reads this; fails
/// closed on anything unusual (no row, revoked row, missing scope).
export async function hasCoachScopeService(userId, scope) {
  const row = await readRow(userId);
  if (!row || row.revokedAt) return false;
  return (row.scopes || []).includes(scope);
}

export async function grantCoachScopeService(userId, scope, { policyVersion } = {}) {
  if (!COACH_SCOPES.includes(scope)) {
    throw {
      status: 400,
      error: 'Unknown consent scope.',
      code: 'UNKNOWN_SCOPE',
    };
  }

  // The client sends the version it rendered; refusing a mismatch is the
  // whole reason the versions column exists. A missing version is refused
  // with its own sentence so the app can say "reopen the screen" rather than
  // "you are out of date" to someone whose build simply predates the field.
  if (policyVersion !== COACH_POLICY_VERSION) {
    throw {
      status: 409,
      error: policyVersion
        ? `This consent copy has been updated. Please reopen the screen to see the current version (${COACH_POLICY_VERSION}).`
        : 'The consent screen did not report which version it displayed. Please reopen it and try again.',
      code: 'COACH_POLICY_VERSION_MISMATCH',
      currentVersion: COACH_POLICY_VERSION,
    };
  }

  const existing = await readRow(userId);
  const now = new Date();
  const scopes = [...new Set([...(existing?.scopes || []), scope])];
  const policyVersions = { ...policyVersionsOf(existing), [scope]: policyVersion };

  // A re-grant is a grant with history: revokedAt is cleared, matching how
  // HealthConsent and the ledger scopes treat re-consenting after a revoke.
  await prisma.coachConsent.upsert({
    where: { userId },
    update: { scopes, policyVersions, grantedAt: now, revokedAt: null },
    create: { userId, scopes, policyVersions, grantedAt: now },
  });

  // Rebuild plan when supplements scope changes, or any coach consent grant
  if (scope === SUPPLEMENTS_SCOPE || scope === BASIC_SCOPE) {
    const { rebuildPlan } = await import('./plan/rebuildPlan.js');
    await rebuildPlan(prisma, userId, { reason: 'consent' });
  }

  return {
    scopes,
    grantedAt: now,
    revokedAt: null,
  };
}

/// Withdraw one scope. Removing the last scope sets revokedAt; removing one
/// of several leaves the row live for the rest. The recorded version goes
/// with the scope, so a later re-grant can never look like it had never
/// needed consent (the same rule the ledger scopes enforce).
///
/// A revoke of something never granted is a no-op, not an error: "turn this
/// off" must be idempotent, and there is no state difference between revoking
/// twice and revoking once.
export async function revokeCoachScopeService(userId, scope) {
  if (!COACH_SCOPES.includes(scope)) {
    throw {
      status: 400,
      error: 'Unknown consent scope.',
      code: 'UNKNOWN_SCOPE',
    };
  }

  const row = await readRow(userId);
  if (!row) return { scopes: [] };
  if (row.revokedAt) return { scopes: [], grantedAt: row.grantedAt, revokedAt: row.revokedAt };

  const scopes = (row.scopes || []).filter((s) => s !== scope);
  const policyVersions = { ...policyVersionsOf(row) };
  delete policyVersions[scope];
  const revokedAt = scopes.length === 0 ? new Date() : null;

  await prisma.coachConsent.update({
    where: { userId },
    data: { scopes, policyVersions, revokedAt },
  });

  // Rebuild plan on revoke for basic scope, or any supplements change
  if (scope === BASIC_SCOPE || scope === SUPPLEMENTS_SCOPE) {
    const { rebuildPlan } = await import('./plan/rebuildPlan.js');
    await rebuildPlan(prisma, userId, { reason: 'consent' });
  }

  return { scopes, grantedAt: row.grantedAt, revokedAt };
}
