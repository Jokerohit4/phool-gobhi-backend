import * as workoutSessionService from '../services/workoutSessionService.js';

export const startSession = async (req, res) => {
  try {
    const { templateId } = req.body || {};
    const session = await workoutSessionService.startSessionService(req.userId, templateId ? parseInt(templateId) : null);
    res.status(201).json({ data: session });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const listSessions = async (req, res) => {
  try {
    const sessions = await workoutSessionService.listSessionsService(req.userId);
    res.json({ data: sessions });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getSessionDetail = async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const session = await workoutSessionService.getSessionDetailService(sessionId, req.userId);
    res.json({ data: session });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const updateSet = async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const setId = parseInt(req.params.setId);
    const set = await workoutSessionService.updateSetService(sessionId, setId, req.userId, req.body);
    res.json({ data: set });
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
    res.status(201).json({ data: sessionExercise });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const addSetToExercise = async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const sessionExerciseId = parseInt(req.params.sessionExerciseId);
    const set = await workoutSessionService.addSetToExerciseService(sessionId, sessionExerciseId, req.userId);
    res.status(201).json({ data: set });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const finishSession = async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const session = await workoutSessionService.finishSessionService(sessionId, req.userId);
    res.json({ data: session });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
