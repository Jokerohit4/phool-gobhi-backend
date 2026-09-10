import * as exerciseLibraryService from '../services/exerciseLibraryService.js';

export const searchExercises = async (req, res) => {
  try {
    const { q, muscleGroup, equipment } = req.query;
    const exercises = await exerciseLibraryService.searchExercisesService(req.userId, { q, muscleGroup, equipment });
    res.json({ data: exercises });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const createCustomExercise = async (req, res) => {
  try {
    const exercise = await exerciseLibraryService.createCustomExerciseService(req.userId, req.body);
    res.status(201).json({ data: exercise });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getExerciseDetail = async (req, res) => {
  try {
    const exerciseId = parseInt(req.params.id);
    const detail = await exerciseLibraryService.getExerciseDetailService(req.userId, exerciseId, req.query.lang);
    res.json({ data: detail });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getExerciseHistory = async (req, res) => {
  try {
    const exerciseId = parseInt(req.params.id);
    const history = await exerciseLibraryService.getExerciseHistoryService(req.userId, exerciseId);
    res.json({ data: history });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
