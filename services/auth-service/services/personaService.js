// Persona: who the user is in the app — linked_gym, own_gym, wellness,
// home_training or explorer.
//
// Before this module the persona was re-guessed from the onboarding answers in
// four places (the app twice, deriveAppMode, challenge-service), and the
// answers are sticky: a saved wellness focus or a home gym id kept winning
// forever, so nobody could move from one persona to another. Now:
//
//   * User.persona null  -> resolved from the answers (initialPersonaFromAnswers),
//                           which reproduces the old behaviour exactly;
//   * User.persona set   -> that is the persona. Only switchPersona and the
//                           gym-link events below write it; editing an answer
//                           never does.
//
// appMode is kept in step (appModeForPersona) so older app builds, which branch
// Home on appMode, still land on the right screen.

import {
  PERSONAS,
  APP_MODES,
  TRAINING_LOCATION_PREFS,
  VALID_PERSONAS,
  PERSONA_SWITCH_SOURCES,
  USER_PERSONA_SWITCH_SOURCES,
} from '../constants/userEnums.js';
import { linkGymTx, leaveGymTx, isSelfLinkGymEnabled } from './gymLinkService.js';

// A switch is cheap to make and each one re-shapes the app, so it is capped
// server-side (the old cap was a device-local counter that leaked across
// accounts). Gym-link side effects never count.
export const PERSONA_SWITCH_LIMIT = 3;
export const PERSONA_SWITCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const GYM_LOCATIONS = [TRAINING_LOCATION_PREFS.GYM, TRAINING_LOCATION_PREFS.FITNESS_CENTRE];

function hasWellnessAnswers(user) {
  return user.workoutIntent === 'wellness_only'
    || user.wellnessSetupCompleted === true
    || (Array.isArray(user.wellnessFocuses) && user.wellnessFocuses.length > 0)
    || user.wellnessDayPattern != null
    || user.wellnessSleepPattern != null;
}

/**
 * The persona implied by the onboarding answers, for users who have never
 * switched. Null while the answers are not enough to say (never asked, or
 * mid-onboarding).
 *
 * Same precedence the app and challenge-service used, with one correction: a
 * user who does not train yet but would prefer a gym is an explorer (that is
 * who deriveAppMode already sent to the marketplace), not own_gym — own_gym
 * means "already trains at a gym we don't partner with".
 */
export function initialPersonaFromAnswers(user) {
  const u = user || {};
  if (u.linkedGymId != null) return PERSONAS.LINKED_GYM;
  if (u.homeUnclaimedGymId != null) return PERSONAS.OWN_GYM;
  if (hasWellnessAnswers(u)) return PERSONAS.WELLNESS;

  const pref = u.trainingLocationPref ?? null;
  if (u.currentlyWorksOut === false) {
    return pref && pref !== TRAINING_LOCATION_PREFS.GYM ? PERSONAS.HOME_TRAINING : PERSONAS.EXPLORER;
  }
  if (GYM_LOCATIONS.includes(pref)) return PERSONAS.OWN_GYM;
  if (pref) return PERSONAS.HOME_TRAINING;
  if (u.currentlyWorksOut === true) return PERSONAS.HOME_TRAINING;

  // Never asked. An appMode on its own means an older floating-chip override.
  if (u.appMode === APP_MODES.HOME_TRACK) return PERSONAS.HOME_TRAINING;
  if (u.appMode === APP_MODES.WELLNESS) return PERSONAS.WELLNESS;
  if (u.appMode === APP_MODES.GYM_SEEKER) return PERSONAS.EXPLORER;
  return null;
}

/** The persona every reader should use. */
export function resolvePersona(user) {
  if (user?.persona && VALID_PERSONAS.includes(user.persona)) return user.persona;
  return initialPersonaFromAnswers(user);
}

/** The appMode older app builds branch Home on, for a persona. */
export function appModeForPersona(persona) {
  switch (persona) {
    case PERSONAS.WELLNESS: return APP_MODES.WELLNESS;
    case PERSONAS.OWN_GYM:
    case PERSONAS.HOME_TRAINING: return APP_MODES.HOME_TRACK;
    case PERSONAS.LINKED_GYM:
    case PERSONAS.EXPLORER: return APP_MODES.GYM_SEEKER;
    default: return null;
  }
}

// Legacy PUT /users/:id/app-mode callers pick a mode; this is the persona that
// mode means.
export function personaForAppMode(appMode) {
  switch (appMode) {
    case APP_MODES.WELLNESS: return PERSONAS.WELLNESS;
    case APP_MODES.HOME_TRACK: return PERSONAS.HOME_TRAINING;
    case APP_MODES.GYM_SEEKER: return PERSONAS.EXPLORER;
    default: return null;
  }
}

/**
 * Where a user lands when their gym link ends (they left, or the gym removed
 * them): whatever they were before they linked, if we recorded it, otherwise
 * explorer. Not the answers — linking forces trainingLocationPref to 'gym',
 * which would otherwise drop every ex-member into own_gym.
 */
export async function personaAfterGymExit(tx, userId) {
  const linkedRow = await tx.appModeHistory.findFirst({
    where: { userId, toPersona: PERSONAS.LINKED_GYM },
    orderBy: { createdAt: 'desc' },
  });
  const before = linkedRow?.fromPersona;
  if (before && before !== PERSONAS.LINKED_GYM) return before;
  return PERSONAS.EXPLORER;
}

/**
 * Write a persona (and the matching appMode) plus its history row. `user` is
 * the row as it was before the change (for fromMode, and fromPersona unless
 * given). No history row when the persona did not actually change — that is
 * just pinning a derived value.
 */
export async function writePersonaTx(tx, user, toPersona, source, extra = {}, fromPersona = resolvePersona(user)) {
  const toMode = appModeForPersona(toPersona);
  const updated = await tx.user.update({
    where: { id: user.id },
    data: { ...extra, persona: toPersona, appMode: toMode },
  });
  if (fromPersona !== toPersona) {
    await tx.appModeHistory.create({
      data: {
        userId: user.id,
        fromMode: user.appMode ?? null,
        toMode,
        fromPersona: fromPersona ?? null,
        toPersona,
        source,
      },
    });
  }
  return { user: updated, fromPersona };
}

async function assertSwitchAllowed(tx, userId, now) {
  const since = new Date(now.getTime() - PERSONA_SWITCH_WINDOW_MS);
  const recent = await tx.appModeHistory.count({
    where: {
      userId,
      createdAt: { gte: since },
      toPersona: { not: null },
      source: { in: [PERSONA_SWITCH_SOURCES.SETTINGS, PERSONA_SWITCH_SOURCES.FLOATING_PROMPT] },
    },
  });
  if (recent >= PERSONA_SWITCH_LIMIT) {
    throw {
      status: 429,
      error: `You can switch how you use the app ${PERSONA_SWITCH_LIMIT} times a week. Try again in a few days.`,
      errorCode: 'SWITCH_COOLDOWN',
    };
  }
}

/**
 * The one way a user changes persona.
 *
 * Never deletes an answer: switching back restores the old experience. Only
 * pointers that contradict the target change — leaving linked_gym ends the gym
 * link; moving to linked_gym needs a gym and goes through the self-link
 * guards. homeUnclaimedGymId is kept when leaving own_gym so it can be
 * restored; the persona, not the pin, decides the Home now.
 *
 * deps (injected so the service is testable without the network):
 *   partnerGym(gymId)    -> { id, isApproved } | null
 *   unclaimedGym(gymId)  -> { id } | null
 *
 * @returns {{ user, fromPersona, toPersona, changed }}
 */
export async function switchPersona(prisma, userId, target, opts = {}, deps = {}) {
  if (!VALID_PERSONAS.includes(target)) {
    throw { status: 400, error: `Invalid persona. Must be one of: ${VALID_PERSONAS.join(', ')}`, errorCode: 'INVALID_PERSONA' };
  }
  const source = USER_PERSONA_SWITCH_SOURCES.includes(opts.source) ? opts.source : PERSONA_SWITCH_SOURCES.SETTINGS;
  const now = opts.now ?? new Date();
  const gymId = opts.gymId == null ? null : Number(opts.gymId);
  if (gymId !== null && (!Number.isInteger(gymId) || gymId <= 0)) {
    throw { status: 400, error: 'gymId must be a positive integer', errorCode: 'INVALID_GYM' };
  }

  // Network checks happen before the transaction so it stays short.
  if (target === PERSONAS.LINKED_GYM) {
    // Moving onto a partner gym is a self-link (a membership the gym is billed
    // for), so it stays behind the self-link flag even when switching is on.
    if (!(await isSelfLinkGymEnabled(prisma))) {
      throw { status: 403, error: "Linking to a gym from the app isn't available yet. Scan your gym's QR instead.", errorCode: 'FLAG_DISABLED' };
    }
    if (!gymId) throw { status: 409, error: 'Pick your gym to link to it.', errorCode: 'GYM_REQUIRED' };
    const gym = deps.partnerGym ? await deps.partnerGym(gymId) : null;
    if (!gym || gym.isApproved === false) {
      throw { status: 404, error: 'That gym is not on Phool Gobhi yet.', errorCode: 'GYM_NOT_FOUND' };
    }
  }
  if (target === PERSONAS.OWN_GYM && gymId) {
    const gym = deps.unclaimedGym ? await deps.unclaimedGym(gymId) : null;
    if (!gym) throw { status: 404, error: 'Gym not found', errorCode: 'GYM_NOT_FOUND' };
  }

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw { status: 404, error: 'User not found' };
    if (user.role && user.role !== 'customer') throw { status: 403, error: 'Forbidden' };

    const fromPersona = resolvePersona(user);
    const sameGym = target === PERSONAS.LINKED_GYM
      ? user.linkedGymId === gymId
      : target !== PERSONAS.OWN_GYM || !gymId || user.homeUnclaimedGymId === gymId;
    if (fromPersona === target && sameGym) {
      // Already there. Pin a derived persona so later answer edits cannot move
      // it, but write no history row and spend no switch.
      const pinned = user.persona === target
        ? user
        : await tx.user.update({ where: { id: userId }, data: { persona: target, appMode: appModeForPersona(target) } });
      return { user: pinned, fromPersona, toPersona: target, source, changed: false };
    }

    await assertSwitchAllowed(tx, userId, now);

    // Leaving a partner gym is leaving its roster: same as DELETE
    // /gym-links/self. Also when moving to a different partner gym.
    if (user.linkedGymId && (target !== PERSONAS.LINKED_GYM || user.linkedGymId !== gymId)) {
      await leaveGymTx(tx, userId, now);
    }
    if (target === PERSONAS.LINKED_GYM) {
      await linkGymTx(tx, userId, gymId, 'self', now);
    }

    const extra = {};
    if (target === PERSONAS.OWN_GYM && gymId) extra.homeUnclaimedGymId = gymId;
    // A claim prompt for a gym the user is leaving the gym world for is noise.
    if (target === PERSONAS.WELLNESS && user.pendingGymPromptGymId) extra.pendingGymPromptGymId = null;

    const { user: updated } = await writePersonaTx(tx, user, target, source, extra, fromPersona);
    return { user: updated, fromPersona, toPersona: target, source, changed: true };
  });
}
