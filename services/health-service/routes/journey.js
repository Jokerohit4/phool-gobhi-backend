import { Router } from 'express';

// The coach journey (start, progress, unpause). Empty on purpose: A2 lands the
// schema and the mount point so B-tasks can add routes here without touching
// health.js again.
const router = Router();

export default router;
