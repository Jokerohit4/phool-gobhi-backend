import * as workoutSessionService from '../services/workoutSessionService.js';
import { serializeDecimals } from '../utils/serializeDecimals.js';
import { isFeatureEnabled } from '../middleware/requireFeatureFlag.js';

export const startSession = async (req, res) => {
  try {
    const { templateId, bookingId, gymId, attendedAt } = req.body || {};
    const attendance = bookingId || gymId ? { bookingId: bookingId ? parseInt(bookingId) : null, gymId: gymId ? parseInt(gymId) : null, attendedAt } : undefined;
    const session = await workoutSessionService.startSessionService(req.userId, templateId ? parseInt(templateId) : null, attendance);
    res.status(201).json({ data: serializeDecimals(session) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const listSessions = async (req, res) => {
  try {
    const sessions = await workoutSessionService.listSessionsService(req.userId);
    res.json({ data: serializeDecimals(sessions) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getTodaySession = async (req, res) => {
  try {
    const session = await workoutSessionService.getTodaySessionService(req.userId);
    res.json({ data: session ? serializeDecimals(session) : null });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getSessionDetail = async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const session = await workoutSessionService.getSessionDetailService(sessionId, req.userId);
    res.json({ data: serializeDecimals(session) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const updateSet = async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const setId = parseInt(req.params.setId);
    const set = await workoutSessionService.updateSetService(sessionId, setId, req.userId, req.body);
    res.json({ data: serializeDecimals(set) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const addExerciseToSession = async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const { exerciseId } = req.body || {};
    if (!exerciseId) return res.status(400).json({ error: 'exerciseId is required' });
    const sessionExercise = await workoutSessionService.addExerciseToSessionService(sessionId, req.userId, parseInt(exerciseId));
    res.status(201).json({ data: serializeDecimals(sessionExercise) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const addSetToExercise = async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const sessionExerciseId = parseInt(req.params.sessionExerciseId);
    const set = await workoutSessionService.addSetToExerciseService(sessionId, sessionExerciseId, req.userId);
    res.status(201).json({ data: serializeDecimals(set) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

const WORKOUT_TYPES = ['strength', 'cardio', 'hiit', 'yoga_mobility', 'full_body', 'rest'];

export const finishSession = async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const { type, rpe } = req.body || {};
    if (type !== undefined && type !== null && !WORKOUT_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${WORKOUT_TYPES.join(', ')}` });
    }
    let parsedRpe;
    if (rpe !== undefined && rpe !== null) {
      parsedRpe = parseInt(rpe);
      if (!Number.isInteger(parsedRpe) || parsedRpe < 1 || parsedRpe > 10) {
        return res.status(400).json({ error: 'rpe must be an integer between 1 and 10' });
      }
    }
    const session = await workoutSessionService.finishSessionService(sessionId, req.userId, { type, rpe: parsedRpe });
    res.json({ data: serializeDecimals(session) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Internal — booking-service fires this on every verified check-in (see
// notifyHealthService.recordAttendanceForWorkout there). Checks its own flag
// rather than gating the whole route, same convention as challenge-service's
// recordAttendanceEventInternal: booking-service can start calling this
// immediately and it stays a harmless no-op until an admin turns
// healthMetrics on.
export const recordAttendanceForWorkoutInternal = async (req, res) => {
  try {
    const { userId, bookingId, gymId, attendedAt, idempotencyKey } = req.body || {};
    if (!userId || !gymId || !attendedAt || !idempotencyKey) {
      return res.status(400).json({ error: 'userId, gymId, attendedAt and idempotencyKey are required' });
    }
    if (!(await isFeatureEnabled('healthMetrics'))) {
      return res.json({ data: { attached: false } });
    }
    const session = await workoutSessionService.getOrCreateDraftForAttendanceService({ userId, bookingId, gymId, attendedAt });
    res.json({ data: { attached: true, sessionId: session.id } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
